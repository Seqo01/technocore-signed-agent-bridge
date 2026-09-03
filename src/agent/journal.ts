import { chmod, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BridgeError } from "../errors.js";
import { cleanOutbound } from "../send-diagnostics.js";
import { ensurePrivateDirectory, withFileLock } from "../fs-safe.js";
import { assertTechnocoreName, roomClasses } from "../names.js";
import { didToPublicKeyBytes } from "../protocol.js";
import type {
  InferenceMetadata,
  JournalEntry,
  SafeErrorRecord,
  SpendMetadata,
} from "./types.js";
import { assertDecimalString } from "./util.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function validateSafeId(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) throw new BridgeError(`${label} has an invalid journal format`);
  return value;
}

function validateSpend(spend: SpendMetadata): SpendMetadata {
  validateSafeId(spend.asset, "spend asset");
  validateSafeId(spend.network, "spend network");
  assertDecimalString(spend.amount, "spend amount");
  return { ...spend };
}

function validateInference(metadata: InferenceMetadata): InferenceMetadata {
  validateSafeId(metadata.provider, "inference provider");
  validateSafeId(metadata.model, "inference model");
  if (metadata.latencyMs !== undefined && (
    !Number.isSafeInteger(metadata.latencyMs) || metadata.latencyMs < 0
  )) throw new BridgeError("Inference latency has an invalid journal format");
  const usage = metadata.usage
    ? Object.fromEntries(Object.entries(metadata.usage).map(([key, value]) => {
      validateSafeId(key, "inference usage key");
      assertDecimalString(value, `inference usage ${key}`);
      return [key, value];
    }))
    : undefined;
  return {
    provider: metadata.provider,
    model: metadata.model,
    ...(metadata.providerSessionId
      ? { providerSessionId: validateSafeId(metadata.providerSessionId, "provider session id") }
      : {}),
    ...(metadata.providerResultId
      ? { providerResultId: validateSafeId(metadata.providerResultId, "provider result id") }
      : {}),
    ...(metadata.latencyMs === undefined ? {} : { latencyMs: metadata.latencyMs }),
    ...(usage ? { usage } : {}),
    ...(metadata.spend ? { spend: validateSpend(metadata.spend) } : {}),
  };
}

function validateSafeError(error: SafeErrorRecord): SafeErrorRecord {
  if (!HASH_PATTERN.test(error.messageHash)) throw new BridgeError("Error hash is invalid");
  return {
    name: validateSafeId(error.name, "error name"),
    ...(error.code ? { code: validateSafeId(error.code, "error code") } : {}),
    messageHash: error.messageHash,
    ...(error.outbound ? { outbound: cleanOutbound(error.outbound) } : {}),
  };
}

function normalizeEntry(entry: JournalEntry): JournalEntry {
  if (entry.version !== 1 || Number.isNaN(Date.parse(entry.timestamp))) {
    throw new BridgeError("Journal entry has an unsupported local format");
  }
  didToPublicKeyBytes(entry.did);
  validateSafeId(entry.id, "journal id");
  validateSafeId(entry.sessionId, "journal session id");
  validateSafeId(entry.event, "journal event");
  if (!(["success", "failure", "ambiguous", "info"] as const).includes(entry.outcome)) {
    throw new BridgeError("Journal outcome is invalid");
  }
  if (entry.taskId) validateSafeId(entry.taskId, "journal task id");
  if (entry.taskType) validateSafeId(entry.taskType, "journal task type");
  if (entry.resultHash && !HASH_PATTERN.test(entry.resultHash)) {
    throw new BridgeError("Journal result hash is invalid");
  }
  if (entry.actionHash && !HASH_PATTERN.test(entry.actionHash)) throw new BridgeError("Invalid approval hash");
  if (entry.delegationId) validateSafeId(entry.delegationId, "delegation id");
  if (entry.inferenceRequestId) validateSafeId(entry.inferenceRequestId, "inference request id");
  if (entry.inferenceRequestHash && !HASH_PATTERN.test(entry.inferenceRequestHash)) {
    throw new BridgeError("Journal inference-request hash is invalid");
  }
  if (entry.inferenceResultHash && !HASH_PATTERN.test(entry.inferenceResultHash)) {
    throw new BridgeError("Journal inference-result hash is invalid");
  }
  if (entry.privateRoomHash && !HASH_PATTERN.test(entry.privateRoomHash)) {
    throw new BridgeError("Private-room hash is invalid");
  }
  for (const hash of entry.memoryWriteHashes ?? []) {
    if (!HASH_PATTERN.test(hash)) throw new BridgeError("Memory-write hash is invalid");
  }
  if (entry.publicTechnocore) {
    const room = assertTechnocoreName(entry.publicTechnocore.room, "public room");
    const classes = roomClasses(room);
    if (classes.includes("p") || classes.includes("mb")) {
      throw new BridgeError("Private room names cannot be stored in the activity journal");
    }
    if (!Number.isSafeInteger(entry.publicTechnocore.seq) || entry.publicTechnocore.seq < 0) {
      throw new BridgeError("Technocore sequence is invalid");
    }
    didToPublicKeyBytes(entry.publicTechnocore.did);
  }
  const normalized: JournalEntry = {
    version: 1,
    id: entry.id,
    timestamp: entry.timestamp,
    did: entry.did,
    sessionId: entry.sessionId,
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(entry.taskType ? { taskType: entry.taskType } : {}),
    event: entry.event,
    outcome: entry.outcome,
    ...(entry.inference ? { inference: validateInference(entry.inference) } : {}),
    ...(entry.publicTechnocore ? { publicTechnocore: { ...entry.publicTechnocore } } : {}),
    ...(entry.privateRoomHash ? { privateRoomHash: entry.privateRoomHash } : {}),
    ...(entry.inferenceRequestId ? { inferenceRequestId: entry.inferenceRequestId } : {}),
    ...(entry.inferenceRequestHash ? { inferenceRequestHash: entry.inferenceRequestHash } : {}),
    ...(entry.inferenceResultHash ? { inferenceResultHash: entry.inferenceResultHash } : {}),
    ...(entry.memoryWriteHashes ? { memoryWriteHashes: [...entry.memoryWriteHashes] } : {}),
    ...(entry.resultHash ? { resultHash: entry.resultHash } : {}),
    ...(entry.error ? { error: validateSafeError(entry.error) } : {}),
    ...(entry.actionHash ? { actionHash: entry.actionHash } : {}),
    ...(entry.delegationId ? { delegationId: entry.delegationId } : {}),
  };
  const serialized = JSON.stringify(normalized);
  if (
    /\b(?:mb-)?p-[a-z0-9_-]{8,}\b/iu.test(serialized) ||
    /-----BEGIN PRIVATE KEY-----/u.test(serialized) ||
    /"(?:sig|signature|privateKey|passphrase|authorization|signedRequestBody)"\s*:/iu.test(serialized)
  ) {
    throw new BridgeError("Journal entry contains forbidden secret material");
  }
  return normalized;
}

export class ActivityJournal {
  constructor(readonly path: string) {}

  async append(entry: JournalEntry): Promise<boolean> {
    const normalized = normalizeEntry(entry);
    return withFileLock(this.path, async () => {
      const existing = await this.readUnlocked();
      if (existing.some(({ id }) => id === normalized.id)) return false;
      await ensurePrivateDirectory(dirname(this.path));
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(this.path, 0o600).catch(() => undefined);
      return true;
    });
  }

  async read(): Promise<JournalEntry[]> {
    return structuredClone(await this.readUnlocked());
  }

  private async readUnlocked(): Promise<JournalEntry[]> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new BridgeError("Could not read the local activity journal", { cause: error });
    }
    const entries: JournalEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        entries.push(normalizeEntry(JSON.parse(line) as JournalEntry));
      } catch (error) {
        throw new BridgeError("Activity journal contains an invalid entry", { cause: error });
      }
    }
    return entries;
  }
}
