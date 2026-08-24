import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { atomicWriteJson, readJsonFile, withFileLock } from "./fs-safe.js";
import { assertLocalAlias, assertTechnocoreName } from "./names.js";

interface CursorState {
  version: 1;
  cursors: Record<string, number>;
}

function roomKey(room: string): string {
  assertTechnocoreName(room, "room");
  return createHash("sha256").update(room, "utf8").digest("hex");
}

export class CursorStore {
  constructor(private readonly directory: string) {}

  private path(owner: string): string {
    return resolve(this.directory, `${assertLocalAlias(owner, "owner")}.json`);
  }

  async get(owner: string, room: string): Promise<number> {
    const state = await readJsonFile<CursorState>(this.path(owner), { version: 1, cursors: {} });
    return state.cursors[roomKey(room)] ?? 0;
  }

  async advance(owner: string, room: string, seq: number): Promise<void> {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("cursor must be a non-negative safe integer");
    const path = this.path(owner);
    await withFileLock(path, async () => {
      const state = await readJsonFile<CursorState>(path, { version: 1, cursors: {} });
      const key = roomKey(room);
      state.cursors[key] = Math.max(state.cursors[key] ?? 0, seq);
      await atomicWriteJson(path, state);
    });
  }
}
