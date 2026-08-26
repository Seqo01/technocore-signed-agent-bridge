import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createHash,
  randomBytes,
  scrypt,
  type KeyObject,
} from "node:crypto";
import { BridgeError } from "./errors.js";
import { assertLocalAlias } from "./names.js";
import { publicKeyBytesToDid } from "./protocol.js";
import type {
  PublicIdentity,
  StoredIdentity,
  StoredIdentityV1,
  StoredIdentityV2,
  UnlockedIdentity,
} from "./types.js";

export const IDENTITY_SCRYPT_N = 2 ** 17;
export const IDENTITY_SCRYPT_R = 8;
export const IDENTITY_SCRYPT_P = 1;
export const IDENTITY_SCRYPT_KEY_LENGTH = 32;
export const IDENTITY_SCRYPT_MAXMEM = 256 * 1024 * 1024;
export const IDENTITY_SALT_BYTES = 32;
export const IDENTITY_GCM_IV_BYTES = 12;
export const IDENTITY_GCM_TAG_BYTES = 16;
export const MIN_PASSPHRASE_BYTES = 16;
export const MAX_PASSPHRASE_BYTES = 1024;

const MAX_PUBLIC_KEY_PEM_CHARS = 4096;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0 || field.length > maximumLength) {
    throw new BridgeError("Identity file has an invalid local format");
  }
  return field;
}

function exactInteger(
  value: Record<string, unknown>,
  key: string,
  expected: number,
): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || field !== expected) {
    throw new BridgeError("Identity file uses unsupported encryption parameters");
  }
  return field;
}

function decodeCanonicalBase64Url(
  value: string,
  expectedLength?: number,
  maximumLength?: number,
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new BridgeError("Identity file has invalid encoded encryption data");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength) ||
    (maximumLength !== undefined && decoded.length > maximumLength)
  ) {
    decoded.fill(0);
    throw new BridgeError("Identity file has invalid encoded encryption data");
  }
  return decoded;
}

function assertTimestamp(value: string): void {
  if (value.length > 64 || Number.isNaN(Date.parse(value))) {
    throw new BridgeError("Identity file has an invalid timestamp");
  }
}

export function fingerprintDid(did: string): string {
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
}

export function publicIdentity(identity: StoredIdentity): PublicIdentity {
  return {
    name: identity.name,
    did: identity.did,
    fingerprint: identity.fingerprint,
    createdAt: identity.createdAt,
  };
}

export function validatePassphrase(passphrase: Buffer): void {
  if (
    passphrase.length < MIN_PASSPHRASE_BYTES ||
    passphrase.length > MAX_PASSPHRASE_BYTES
  ) {
    throw new BridgeError(
      `Passphrase must contain ${MIN_PASSPHRASE_BYTES}-${MAX_PASSPHRASE_BYTES} UTF-8 bytes`,
    );
  }
}

export function parseStoredIdentity(value: unknown, expectedName: string): StoredIdentity {
  if (!isRecord(value)) throw new BridgeError(`Identity ${expectedName} has an unsupported local format`);
  const version = value.version;
  const name = requiredString(value, "name", 128);
  if (name !== expectedName) {
    throw new BridgeError(`Identity ${expectedName} has an unsupported local format`);
  }
  assertLocalAlias(name, "identity name");
  const did = requiredString(value, "did", 256);
  const fingerprint = requiredString(value, "fingerprint", 128);
  const publicKeyPem = requiredString(value, "publicKeyPem", MAX_PUBLIC_KEY_PEM_CHARS);
  const createdAt = requiredString(value, "createdAt", 64);
  assertTimestamp(createdAt);

  if (version === 1) {
    const privateKeyPem = requiredString(value, "privateKeyPem", 16 * 1024);
    return {
      version: 1,
      name,
      did,
      fingerprint,
      publicKeyPem,
      privateKeyPem,
      createdAt,
    };
  }

  if (version !== 2 || !isRecord(value.encryptedPrivateKey)) {
    throw new BridgeError(`Identity ${expectedName} has an unsupported local format`);
  }
  if ("privateKeyPem" in value) {
    throw new BridgeError(`Identity ${expectedName} version 2 contains forbidden plaintext key material`);
  }
  const encrypted = value.encryptedPrivateKey;
  if (
    encrypted.format !== "pkcs8-der" ||
    encrypted.encoding !== "base64url" ||
    encrypted.aadVersion !== 1 ||
    !isRecord(encrypted.kdf) ||
    !isRecord(encrypted.cipher)
  ) {
    throw new BridgeError(`Identity ${expectedName} has an unsupported encrypted format`);
  }

  const kdf = encrypted.kdf;
  const cipher = encrypted.cipher;
  if (kdf.name !== "scrypt" || cipher.name !== "aes-256-gcm") {
    throw new BridgeError("Identity file uses unsupported encryption parameters");
  }
  exactInteger(kdf, "N", IDENTITY_SCRYPT_N);
  exactInteger(kdf, "r", IDENTITY_SCRYPT_R);
  exactInteger(kdf, "p", IDENTITY_SCRYPT_P);
  exactInteger(kdf, "keyLength", IDENTITY_SCRYPT_KEY_LENGTH);
  exactInteger(cipher, "tagLength", IDENTITY_GCM_TAG_BYTES);
  const salt = requiredString(kdf, "salt", 128);
  const iv = requiredString(cipher, "iv", 128);
  const tag = requiredString(cipher, "tag", 128);
  const ciphertext = requiredString(encrypted, "ciphertext", 32 * 1024);
  const decoded = [
    decodeCanonicalBase64Url(salt, IDENTITY_SALT_BYTES),
    decodeCanonicalBase64Url(iv, IDENTITY_GCM_IV_BYTES),
    decodeCanonicalBase64Url(tag, IDENTITY_GCM_TAG_BYTES),
    decodeCanonicalBase64Url(ciphertext, undefined, MAX_CIPHERTEXT_BYTES),
  ];
  for (const item of decoded) item.fill(0);

  const encryptedAt = requiredString(value, "encryptedAt", 64);
  assertTimestamp(encryptedAt);
  return {
    version: 2,
    name,
    did,
    fingerprint,
    publicKeyPem,
    createdAt,
    encryptedAt,
    encryptedPrivateKey: {
      format: "pkcs8-der",
      encoding: "base64url",
      kdf: {
        name: "scrypt",
        salt,
        N: IDENTITY_SCRYPT_N,
        r: IDENTITY_SCRYPT_R,
        p: IDENTITY_SCRYPT_P,
        keyLength: IDENTITY_SCRYPT_KEY_LENGTH,
      },
      cipher: {
        name: "aes-256-gcm",
        iv,
        tagLength: IDENTITY_GCM_TAG_BYTES,
        tag,
      },
      aadVersion: 1,
      ciphertext,
    },
  };
}

function publicKeyDid(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new BridgeError("Node did not export the Ed25519 public key");
  return publicKeyBytesToDid(Buffer.from(jwk.x, "base64url"));
}

export function assertPublicIdentityIntegrity(identity: StoredIdentity): void {
  try {
    const publicKey = createPublicKey(identity.publicKeyPem);
    const derivedDid = publicKeyDid(publicKey);
    if (
      derivedDid !== identity.did ||
      fingerprintDid(derivedDid) !== identity.fingerprint
    ) {
      throw new Error("public identity mismatch");
    }
  } catch {
    throw new BridgeError(`Identity ${identity.name} failed public integrity validation`);
  }
}

function unlockedFromPrivateKey(
  identity: StoredIdentity,
  privateKey: KeyObject,
): UnlockedIdentity {
  try {
    const publicKey = createPublicKey(privateKey);
    const derivedDid = publicKeyDid(publicKey);
    const storedPublic = createPublicKey(identity.publicKeyPem);
    if (
      derivedDid !== identity.did ||
      fingerprintDid(derivedDid) !== identity.fingerprint ||
      !publicKey.equals(storedPublic)
    ) {
      throw new Error("private/public identity mismatch");
    }
  } catch {
    throw new BridgeError(`Identity ${identity.name} failed private/public integrity validation`);
  }
  return {
    ...publicIdentity(identity),
    publicKeyPem: identity.publicKeyPem,
    privateKey,
  };
}

export function unlockPlaintextIdentity(identity: StoredIdentityV1): UnlockedIdentity {
  try {
    return unlockedFromPrivateKey(identity, createPrivateKey(identity.privateKeyPem));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`Identity ${identity.name} failed plaintext integrity validation`);
  }
}

function identityAad(identity: Omit<StoredIdentityV2, "encryptedPrivateKey"> & {
  encryptedPrivateKey: Omit<StoredIdentityV2["encryptedPrivateKey"], "ciphertext">;
}): Buffer {
  const encrypted = identity.encryptedPrivateKey;
  return Buffer.from(JSON.stringify([
    "technocore-encrypted-identity",
    identity.version,
    identity.name,
    identity.did,
    identity.fingerprint,
    identity.publicKeyPem,
    identity.createdAt,
    identity.encryptedAt,
    encrypted.format,
    encrypted.encoding,
    encrypted.aadVersion,
    encrypted.kdf.name,
    encrypted.kdf.salt,
    encrypted.kdf.N,
    encrypted.kdf.r,
    encrypted.kdf.p,
    encrypted.kdf.keyLength,
    encrypted.cipher.name,
    encrypted.cipher.iv,
    encrypted.cipher.tagLength,
  ]), "utf8");
}

function deriveEncryptionKey(passphrase: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, IDENTITY_SCRYPT_KEY_LENGTH, {
      N: IDENTITY_SCRYPT_N,
      r: IDENTITY_SCRYPT_R,
      p: IDENTITY_SCRYPT_P,
      maxmem: IDENTITY_SCRYPT_MAXMEM,
    }, (error, derivedKey) => {
      if (error) reject(new BridgeError("Identity key derivation failed"));
      else resolve(derivedKey);
    });
  });
}

export async function encryptIdentity(
  identity: Pick<StoredIdentity, "name" | "did" | "fingerprint" | "publicKeyPem" | "createdAt">,
  privateKey: KeyObject,
  passphrase: Buffer,
): Promise<StoredIdentityV2> {
  validatePassphrase(passphrase);
  const salt = randomBytes(IDENTITY_SALT_BYTES);
  const iv = randomBytes(IDENTITY_GCM_IV_BYTES);
  const key = await deriveEncryptionKey(passphrase, salt);
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const encryptedAt = new Date().toISOString();
  const base = {
    version: 2 as const,
    name: identity.name,
    did: identity.did,
    fingerprint: identity.fingerprint,
    publicKeyPem: identity.publicKeyPem,
    createdAt: identity.createdAt,
    encryptedAt,
    encryptedPrivateKey: {
      format: "pkcs8-der" as const,
      encoding: "base64url" as const,
      kdf: {
        name: "scrypt" as const,
        salt: salt.toString("base64url"),
        N: IDENTITY_SCRYPT_N,
        r: IDENTITY_SCRYPT_R,
        p: IDENTITY_SCRYPT_P,
        keyLength: IDENTITY_SCRYPT_KEY_LENGTH as 32,
      },
      cipher: {
        name: "aes-256-gcm" as const,
        iv: iv.toString("base64url"),
        tagLength: IDENTITY_GCM_TAG_BYTES as 16,
        tag: "",
      },
      aadVersion: 1 as const,
    },
  };

  try {
    const aad = identityAad(base);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: IDENTITY_GCM_TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(privateDer), cipher.final()]);
    const tag = cipher.getAuthTag();
    try {
      return {
        ...base,
        encryptedPrivateKey: {
          ...base.encryptedPrivateKey,
          cipher: {
            ...base.encryptedPrivateKey.cipher,
            tag: tag.toString("base64url"),
          },
          ciphertext: ciphertext.toString("base64url"),
        },
      };
    } finally {
      aad.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  } finally {
    salt.fill(0);
    iv.fill(0);
    key.fill(0);
    privateDer.fill(0);
  }
}

export async function decryptIdentity(
  identity: StoredIdentityV2,
  passphrase: Buffer,
): Promise<UnlockedIdentity> {
  validatePassphrase(passphrase);
  assertPublicIdentityIntegrity(identity);
  const salt = decodeCanonicalBase64Url(
    identity.encryptedPrivateKey.kdf.salt,
    IDENTITY_SALT_BYTES,
  );
  const iv = decodeCanonicalBase64Url(
    identity.encryptedPrivateKey.cipher.iv,
    IDENTITY_GCM_IV_BYTES,
  );
  const tag = decodeCanonicalBase64Url(
    identity.encryptedPrivateKey.cipher.tag,
    IDENTITY_GCM_TAG_BYTES,
  );
  const ciphertext = decodeCanonicalBase64Url(
    identity.encryptedPrivateKey.ciphertext,
    undefined,
    MAX_CIPHERTEXT_BYTES,
  );
  const key = await deriveEncryptionKey(passphrase, salt);
  const aad = identityAad({
    version: identity.version,
    name: identity.name,
    did: identity.did,
    fingerprint: identity.fingerprint,
    publicKeyPem: identity.publicKeyPem,
    createdAt: identity.createdAt,
    encryptedAt: identity.encryptedAt,
    encryptedPrivateKey: {
      format: identity.encryptedPrivateKey.format,
      encoding: identity.encryptedPrivateKey.encoding,
      kdf: identity.encryptedPrivateKey.kdf,
      cipher: identity.encryptedPrivateKey.cipher,
      aadVersion: identity.encryptedPrivateKey.aadVersion,
    },
  });
  let privateDer: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: IDENTITY_GCM_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    try {
      privateDer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new BridgeError(`Identity ${identity.name} could not be unlocked`);
    }
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    } catch {
      throw new BridgeError(`Identity ${identity.name} decrypted to an invalid private key`);
    }
    return unlockedFromPrivateKey(identity, privateKey);
  } finally {
    salt.fill(0);
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    key.fill(0);
    aad.fill(0);
    privateDer?.fill(0);
  }
}
