import { BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile, withFileLock } from "../fs-safe.js";
import type {
  MemoryProvider,
  MemoryPutRequest,
  MemoryRecord,
  MemorySearchQuery,
} from "./types.js";
import { hashText, hashValue, systemClock, timestamp, type AgentClock } from "./util.js";

interface LocalMemoryStateV1 {
  version: 1;
  records: Record<string, MemoryRecord>;
}

function validateText(value: string, label: string, maximum = 256): string {
  if (value.length === 0 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new BridgeError(`${label} has an invalid local memory format`);
  }
  return value;
}

function requestHash(request: MemoryPutRequest): string {
  return hashValue({
    scope: request.scope,
    key: request.key,
    value: request.value,
    tags: [...new Set(request.tags ?? [])].sort(),
  });
}

export class LocalMemoryProvider implements MemoryProvider {
  constructor(
    readonly path: string,
    private readonly clock: AgentClock = systemClock,
  ) {}

  async put(request: MemoryPutRequest): Promise<MemoryRecord> {
    validateText(request.idempotencyKey, "memory idempotency key");
    validateText(request.scope, "memory scope");
    validateText(request.key, "memory key");
    const tags = [...new Set(request.tags ?? [])].sort();
    for (const tag of tags) validateText(tag, "memory tag", 128);
    const valueHash = requestHash(request);
    return withFileLock(this.path, async () => {
      const state = await this.loadUnlocked();
      const duplicate = Object.values(state.records).find(
        (record) => record.idempotencyKey === request.idempotencyKey,
      );
      if (duplicate) {
        if (duplicate.valueHash !== valueHash) {
          throw new BridgeError("Memory idempotency key was reused with different content");
        }
        return structuredClone(duplicate);
      }
      const id = `mem_${hashText(request.idempotencyKey).slice(0, 32)}`;
      const record: MemoryRecord = {
        id,
        idempotencyKey: request.idempotencyKey,
        scope: request.scope,
        key: request.key,
        value: structuredClone(request.value),
        tags,
        valueHash,
        createdAt: timestamp(this.clock),
      };
      state.records[id] = record;
      await atomicWriteJson(this.path, state);
      return structuredClone(record);
    });
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    validateText(id, "memory id", 128);
    const record = (await this.loadUnlocked()).records[id];
    return record ? structuredClone(record) : undefined;
  }

  async search(query: MemorySearchQuery): Promise<MemoryRecord[]> {
    if (query.scope) validateText(query.scope, "memory scope");
    if (query.key) validateText(query.key, "memory key");
    if (query.tag) validateText(query.tag, "memory tag", 128);
    return Object.values((await this.loadUnlocked()).records)
      .filter((record) => query.scope === undefined || record.scope === query.scope)
      .filter((record) => query.key === undefined || record.key === query.key)
      .filter((record) => query.tag === undefined || record.tags.includes(query.tag))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      ))
      .map((record) => structuredClone(record));
  }

  private async loadUnlocked(): Promise<LocalMemoryStateV1> {
    const state = await readJsonFile<LocalMemoryStateV1>(this.path, {
      version: 1,
      records: {},
    });
    if (state.version !== 1 || !state.records || typeof state.records !== "object") {
      throw new BridgeError("Local memory has an unsupported format");
    }
    return state;
  }
}
