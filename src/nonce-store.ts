import { atomicWriteJson, readJsonFile, withFileLock } from "./fs-safe.js";
import { BridgeError } from "./errors.js";
import { assertTechnocoreName } from "./names.js";
import { didToPublicKeyBytes, normalizeNonce } from "./protocol.js";

interface NonceState {
  version: 1;
  values: Record<string, string>;
}

function stateKey(did: string, room: string): string {
  didToPublicKeyBytes(did);
  assertTechnocoreName(room, "room");
  return `${did}|${room}`;
}

export class NonceStore {
  constructor(private readonly path: string) {}

  async last(did: string, room: string): Promise<string | undefined> {
    const state = await readJsonFile<NonceState>(this.path, { version: 1, values: {} });
    if (state.version !== 1 || typeof state.values !== "object") {
      throw new BridgeError("Nonce state has an unsupported local format");
    }
    return state.values[stateKey(did, room)];
  }

  async reserve(did: string, room: string): Promise<string> {
    return withFileLock(this.path, async () => {
      const state = await readJsonFile<NonceState>(this.path, { version: 1, values: {} });
      if (state.version !== 1 || typeof state.values !== "object") {
        throw new BridgeError("Nonce state has an unsupported local format");
      }
      const key = stateKey(did, room);
      const previous = state.values[key] === undefined ? -1n : BigInt(state.values[key]);
      const clock = BigInt(Date.now());
      const next = previous + 1n > clock ? previous + 1n : clock;
      const normalized = normalizeNonce(next);
      state.values[key] = normalized;
      await atomicWriteJson(this.path, state);
      return normalized;
    });
  }
}
