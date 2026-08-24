import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { atomicWriteJson, ensurePrivateDirectory, readJsonFile } from "./fs-safe.js";
import { BridgeError } from "./errors.js";
import { assertLocalAlias } from "./names.js";
import { publicKeyBytesToDid } from "./protocol.js";
import type { PublicIdentity, StoredIdentity } from "./types.js";

export function fingerprintDid(did: string): string {
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
}

function publicIdentity(identity: StoredIdentity): PublicIdentity {
  return {
    name: identity.name,
    did: identity.did,
    fingerprint: identity.fingerprint,
    createdAt: identity.createdAt,
  };
}

export class IdentityStore {
  constructor(private readonly directory: string) {}

  private path(name: string): string {
    return resolve(this.directory, `${assertLocalAlias(name, "identity name")}.json`);
  }

  async create(name: string): Promise<PublicIdentity> {
    const path = this.path(name);
    await ensurePrivateDirectory(this.directory);
    try {
      await access(path);
      throw new BridgeError(`Identity ${name} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" });
    if (!publicJwk.x) throw new BridgeError("Node did not export the Ed25519 public key");
    const did = publicKeyBytesToDid(Buffer.from(publicJwk.x, "base64url"));
    const identity: StoredIdentity = {
      version: 1,
      name,
      did,
      fingerprint: fingerprintDid(did),
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      createdAt: new Date().toISOString(),
    };
    await atomicWriteJson(path, identity);
    return publicIdentity(identity);
  }

  async load(name: string): Promise<StoredIdentity> {
    const path = this.path(name);
    const identity = await readJsonFile<StoredIdentity | null>(path, null);
    if (!identity) throw new BridgeError(`Identity ${name} does not exist`);
    if (identity.version !== 1 || identity.name !== name) {
      throw new BridgeError(`Identity ${name} has an unsupported local format`);
    }

    try {
      const privateKey = createPrivateKey(identity.privateKeyPem);
      const publicKey = createPublicKey(privateKey);
      const publicJwk = publicKey.export({ format: "jwk" });
      if (!publicJwk.x) throw new Error("missing public key bytes");
      const derivedDid = publicKeyBytesToDid(Buffer.from(publicJwk.x, "base64url"));
      if (
        derivedDid !== identity.did ||
        fingerprintDid(derivedDid) !== identity.fingerprint
      ) {
        throw new Error("public identity does not match the private key");
      }
    } catch (error) {
      throw new BridgeError(`Identity ${name} failed integrity validation`, {
        cause: error,
      });
    }
    return identity;
  }

  async inspect(name: string): Promise<PublicIdentity> {
    return publicIdentity(await this.load(name));
  }
}
