import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { atomicWriteJson } from "../src/fs-safe.js";
import { fingerprintDid } from "../src/identity.js";
import { publicKeyBytesToDid } from "../src/protocol.js";
import type { PassphraseProvider } from "../src/passphrase.js";
import type { StoredIdentityV1 } from "../src/types.js";

export async function temporaryDirectory(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "technocore-bridge-test-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export function roomFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room: "public",
    count: 0,
    first_seq: null,
    last_seq: 0,
    messages: [],
    ...overrides,
  };
}

export function generatedPassphraseProvider(): {
  passphrase: Buffer;
  provider: PassphraseProvider;
  cleanup: () => void;
} {
  const passphrase = randomBytes(32);
  return {
    passphrase,
    provider: async () => Buffer.from(passphrase),
    cleanup: () => passphrase.fill(0),
  };
}

export async function createTemporaryV1Identity(
  directory: string,
  name: string,
): Promise<StoredIdentityV1> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  if (!publicJwk.x) throw new Error("test Ed25519 key did not export public bytes");
  const did = publicKeyBytesToDid(Buffer.from(publicJwk.x, "base64url"));
  const identity: StoredIdentityV1 = {
    version: 1,
    name,
    did,
    fingerprint: fingerprintDid(did),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    createdAt: new Date().toISOString(),
  };
  await atomicWriteJson(resolve(directory, `${name}.json`), identity);
  return identity;
}
