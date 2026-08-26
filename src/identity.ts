import {
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { resolve } from "node:path";
import { unlink } from "node:fs/promises";
import {
  atomicCreateJson,
  atomicWriteJson,
  ensurePrivateDirectory,
  pathExists,
  readJsonFile,
  renameWithoutReplace,
  withFileLock,
} from "./fs-safe.js";
import { BridgeError } from "./errors.js";
import { assertLocalAlias } from "./names.js";
import {
  assertPublicIdentityIntegrity,
  decryptIdentity,
  encryptIdentity,
  fingerprintDid,
  parseStoredIdentity,
  publicIdentity,
  unlockPlaintextIdentity,
  validatePassphrase,
} from "./identity-crypto.js";
import { publicKeyBytesToDid } from "./protocol.js";
import type { PassphraseProvider, PassphrasePurpose } from "./passphrase.js";
import type {
  PublicIdentity,
  StoredIdentity,
  StoredIdentityV2,
  UnlockedIdentity,
} from "./types.js";

export { fingerprintDid } from "./identity-crypto.js";

export type MigrationPhase =
  | "backup-verified"
  | "candidate-verified"
  | "marker-prepared"
  | "original-moved"
  | "marker-original-moved"
  | "candidate-installed"
  | "marker-installed"
  | "primary-verified"
  | "marker-verified";

export interface MigrationOptions {
  onPhase?(phase: MigrationPhase): void | Promise<void>;
}

export interface IdentityMigrationResult extends PublicIdentity {
  migrated: boolean;
  backupVerified: true;
  recovered: boolean;
}

interface MigrationArtifacts {
  primary: string;
  candidate: string;
  rollback: string;
  marker: string;
}

function keyPairDid(publicKey: KeyObject): string {
  const publicJwk = publicKey.export({ format: "jwk" });
  if (!publicJwk.x) throw new BridgeError("Node did not export the Ed25519 public key");
  return publicKeyBytesToDid(Buffer.from(publicJwk.x, "base64url"));
}

async function removeFile(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export class IdentityStore {
  constructor(
    private readonly directory: string,
    private readonly passphrases?: PassphraseProvider,
  ) {}

  private path(name: string): string {
    return resolve(this.directory, `${assertLocalAlias(name, "identity name")}.json`);
  }

  private artifacts(name: string): MigrationArtifacts {
    const primary = this.path(name);
    return {
      primary,
      candidate: `${primary}.migrate-v2`,
      rollback: `${primary}.v1.rollback`,
      marker: `${primary}.migration.json`,
    };
  }

  private async getPassphrase(
    name: string,
    purpose: PassphrasePurpose,
    confirm: boolean,
  ): Promise<Buffer> {
    if (!this.passphrases) {
      throw new BridgeError(`Identity ${name} requires a private passphrase provider`);
    }
    const passphrase = await this.passphrases({ identityName: name, purpose, confirm });
    if (!Buffer.isBuffer(passphrase)) {
      throw new BridgeError("Passphrase provider returned an invalid value");
    }
    try {
      validatePassphrase(passphrase);
      return passphrase;
    } catch (error) {
      passphrase.fill(0);
      throw error;
    }
  }

  private async readAt(path: string, name: string): Promise<StoredIdentity | null> {
    const value = await readJsonFile<unknown | null>(path, null);
    return value === null ? null : parseStoredIdentity(value, name);
  }

  private async requireAt(path: string, name: string): Promise<StoredIdentity> {
    const identity = await this.readAt(path, name);
    if (!identity) throw new BridgeError(`Identity ${name} does not exist`);
    return identity;
  }

  private async hasMigrationArtifacts(name: string): Promise<boolean> {
    const { candidate, rollback, marker } = this.artifacts(name);
    return (await pathExists(candidate)) || (await pathExists(rollback)) || (await pathExists(marker));
  }

  private async assertNoMigrationArtifacts(name: string): Promise<void> {
    if (await this.hasMigrationArtifacts(name)) {
      throw new BridgeError(
        `Identity ${name} has an incomplete migration; rerun identity:migrate to recover`,
      );
    }
  }

  async create(name: string): Promise<PublicIdentity> {
    assertLocalAlias(name, "identity name");
    const passphrase = await this.getPassphrase(name, "create", true);
    const path = this.path(name);
    try {
      return await withFileLock(path, async () => {
        await ensurePrivateDirectory(this.directory);
        if (await pathExists(path)) throw new BridgeError(`Identity ${name} already exists`);
        await this.assertNoMigrationArtifacts(name);

        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const did = keyPairDid(publicKey);
        const metadata = {
          name,
          did,
          fingerprint: fingerprintDid(did),
          publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
          createdAt: new Date().toISOString(),
        };
        const encrypted = await encryptIdentity(metadata, privateKey, passphrase);
        await atomicWriteJson(path, encrypted);
        const reopened = await this.requireAt(path, name);
        if (reopened.version !== 2) throw new BridgeError(`Identity ${name} creation verification failed`);
        const unlocked = await decryptIdentity(reopened, passphrase);
        if (unlocked.did !== did) throw new BridgeError(`Identity ${name} creation changed its DID`);
        return publicIdentity(reopened);
      });
    } finally {
      passphrase.fill(0);
    }
  }

  async inspect(name: string): Promise<PublicIdentity> {
    await this.assertNoMigrationArtifacts(name);
    const identity = await this.requireAt(this.path(name), name);
    assertPublicIdentityIntegrity(identity);
    return publicIdentity(identity);
  }

  async unlock(name: string): Promise<UnlockedIdentity> {
    await this.assertNoMigrationArtifacts(name);
    const identity = await this.requireAt(this.path(name), name);
    if (identity.version === 1) {
      throw new BridgeError(
        `Identity ${name} is plaintext version 1; run identity:migrate before signing`,
      );
    }
    const passphrase = await this.getPassphrase(name, "unlock", false);
    try {
      return await decryptIdentity(identity, passphrase);
    } finally {
      passphrase.fill(0);
    }
  }

  private ensureSameDid(expected: string, actual: string, stage: string): void {
    if (actual !== expected) {
      throw new BridgeError(`Identity migration ${stage} did not preserve the exact DID`);
    }
  }

  private async writeMarker(
    name: string,
    phase: "prepared" | "original-moved" | "installed" | "verified",
    did: string,
  ): Promise<void> {
    await atomicWriteJson(this.artifacts(name).marker, {
      version: 1,
      identityName: name,
      phase,
      originalDid: did,
      updatedAt: new Date().toISOString(),
    });
  }

  private async verifyEncryptedAt(
    path: string,
    name: string,
    passphrase: Buffer,
    expectedDid: string,
    stage: string,
  ): Promise<StoredIdentityV2> {
    const stored = await this.requireAt(path, name);
    if (stored.version !== 2) {
      throw new BridgeError(`Identity migration ${stage} is not an encrypted v2 identity`);
    }
    const unlocked = await decryptIdentity(stored, passphrase);
    this.ensureSameDid(expectedDid, unlocked.did, stage);
    return stored;
  }

  private async recoverLocked(
    name: string,
    passphrase: Buffer,
    backupPath: string,
  ): Promise<{ identity: StoredIdentity; recovered: boolean }> {
    const paths = this.artifacts(name);
    let primary = await this.readAt(paths.primary, name);
    const candidate = await this.readAt(paths.candidate, name);
    const rollback = await this.readAt(paths.rollback, name);
    const markerExists = await pathExists(paths.marker);
    const recovered = candidate !== null || rollback !== null || markerExists;

    if (primary?.version === 2) {
      let unlocked: UnlockedIdentity;
      try {
        unlocked = await decryptIdentity(primary, passphrase);
      } catch (error) {
        if (rollback?.version === 1) {
          const rollbackUnlocked = unlockPlaintextIdentity(rollback);
          const backup = await this.readAt(backupPath, name);
          if (backup?.version !== 2) {
            throw new BridgeError(
              `Identity ${name} recovery needs its verified encrypted backup; migration files were preserved`,
            );
          }
          let backupUnlocked: UnlockedIdentity;
          try {
            backupUnlocked = await decryptIdentity(backup, passphrase);
          } catch {
            throw new BridgeError(
              `Identity ${name} recovery could not verify the passphrase; migration files were preserved`,
            );
          }
          this.ensureSameDid(
            rollbackUnlocked.did,
            backupUnlocked.did,
            "rollback backup verification",
          );
          const failedPath = `${paths.primary}.failed-v2-${Date.now()}`;
          await renameWithoutReplace(paths.primary, failedPath);
          await renameWithoutReplace(paths.rollback, paths.primary);
          await removeFile(paths.marker);
          throw new BridgeError(
            `Identity ${name} encrypted migration result was invalid; the plaintext rollback was restored`,
          );
        }
        throw error;
      }
      if (rollback) {
        if (rollback.version !== 1) {
          throw new BridgeError(`Identity ${name} has an invalid migration rollback`);
        }
        const rollbackUnlocked = unlockPlaintextIdentity(rollback);
        this.ensureSameDid(unlocked.did, rollbackUnlocked.did, "rollback recovery");
      }
      if (candidate) {
        if (candidate.version !== 2) {
          throw new BridgeError(`Identity ${name} has an invalid migration candidate`);
        }
        const candidateUnlocked = await decryptIdentity(candidate, passphrase);
        this.ensureSameDid(unlocked.did, candidateUnlocked.did, "candidate recovery");
      }
      await removeFile(paths.rollback);
      await removeFile(paths.candidate);
      await removeFile(paths.marker);
      return { identity: primary, recovered };
    }

    if (primary?.version === 1) {
      if (rollback) {
        throw new BridgeError(`Identity ${name} has conflicting plaintext migration files`);
      }
      if (markerExists && !candidate) await removeFile(paths.marker);
      return { identity: primary, recovered };
    }

    if (!primary && rollback?.version === 1) {
      const rollbackUnlocked = unlockPlaintextIdentity(rollback);
      if (candidate?.version === 2) {
        const candidateUnlocked = await decryptIdentity(candidate, passphrase);
        this.ensureSameDid(rollbackUnlocked.did, candidateUnlocked.did, "crash recovery");
        await renameWithoutReplace(paths.candidate, paths.primary);
        primary = await this.requireAt(paths.primary, name);
        if (primary.version !== 2) throw new BridgeError(`Identity ${name} crash recovery failed`);
        const reopened = await decryptIdentity(primary, passphrase);
        this.ensureSameDid(rollbackUnlocked.did, reopened.did, "crash recovery reopen");
        await removeFile(paths.rollback);
        await removeFile(paths.marker);
        return { identity: primary, recovered: true };
      }
      if (candidate) throw new BridgeError(`Identity ${name} has an invalid migration candidate`);
      await renameWithoutReplace(paths.rollback, paths.primary);
      await removeFile(paths.marker);
      primary = await this.requireAt(paths.primary, name);
      return { identity: primary, recovered: true };
    }

    if (!primary && (candidate || markerExists)) {
      throw new BridgeError(`Identity ${name} migration cannot recover without its plaintext rollback`);
    }
    if (!primary) throw new BridgeError(`Identity ${name} does not exist`);
    throw new BridgeError(`Identity ${name} has an unsupported local format`);
  }

  async migrate(
    name: string,
    backupPath: string,
    options: MigrationOptions = {},
  ): Promise<IdentityMigrationResult> {
    assertLocalAlias(name, "identity name");
    const passphrase = await this.getPassphrase(name, "migrate", true);
    const paths = this.artifacts(name);
    const resolvedBackup = resolve(backupPath);
    if (Object.values(paths).includes(resolvedBackup)) {
      passphrase.fill(0);
      throw new BridgeError("Encrypted backup path must be outside reserved identity migration files");
    }
    const phase = async (value: MigrationPhase): Promise<void> => {
      await options.onPhase?.(value);
    };

    try {
      return await withFileLock(paths.primary, async () => {
        await ensurePrivateDirectory(this.directory);
        const recovery = await this.recoverLocked(name, passphrase, resolvedBackup);
        if (recovery.identity.version === 2) {
          const unlocked = await decryptIdentity(recovery.identity, passphrase);
          const backup = await this.readAt(resolvedBackup, name);
          if (backup?.version !== 2) {
            throw new BridgeError(
              `Identity ${name} is already encrypted, but the supplied verified backup is unavailable`,
            );
          }
          await this.verifyEncryptedAt(
            resolvedBackup,
            name,
            passphrase,
            unlocked.did,
            "backup verification",
          );
          return {
            ...publicIdentity(recovery.identity),
            migrated: false,
            backupVerified: true,
            recovered: recovery.recovered,
          };
        }

        const plaintext = recovery.identity;
        const unlockedPlaintext = unlockPlaintextIdentity(plaintext);
        const originalDid = unlockedPlaintext.did;

        const existingBackup = await this.readAt(resolvedBackup, name);
        if (existingBackup) {
          if (existingBackup.version !== 2) {
            throw new BridgeError("Existing identity backup is not an encrypted v2 identity");
          }
          await this.verifyEncryptedAt(
            resolvedBackup,
            name,
            passphrase,
            originalDid,
            "backup verification",
          );
        } else {
          const backup = await encryptIdentity(plaintext, unlockedPlaintext.privateKey, passphrase);
          await atomicCreateJson(resolvedBackup, backup);
          await this.verifyEncryptedAt(
            resolvedBackup,
            name,
            passphrase,
            originalDid,
            "backup verification",
          );
        }
        await phase("backup-verified");

        const existingCandidate = await this.readAt(paths.candidate, name);
        if (existingCandidate) {
          if (existingCandidate.version !== 2) {
            throw new BridgeError(`Identity ${name} has an invalid migration candidate`);
          }
          await this.verifyEncryptedAt(
            paths.candidate,
            name,
            passphrase,
            originalDid,
            "candidate verification",
          );
        } else {
          const candidate = await encryptIdentity(plaintext, unlockedPlaintext.privateKey, passphrase);
          await atomicCreateJson(paths.candidate, candidate);
          await this.verifyEncryptedAt(
            paths.candidate,
            name,
            passphrase,
            originalDid,
            "candidate verification",
          );
        }
        await phase("candidate-verified");

        await this.writeMarker(name, "prepared", originalDid);
        await phase("marker-prepared");
        await renameWithoutReplace(paths.primary, paths.rollback);
        await phase("original-moved");
        await this.writeMarker(name, "original-moved", originalDid);
        await phase("marker-original-moved");
        await renameWithoutReplace(paths.candidate, paths.primary);
        await phase("candidate-installed");
        await this.writeMarker(name, "installed", originalDid);
        await phase("marker-installed");
        const installed = await this.verifyEncryptedAt(
          paths.primary,
          name,
          passphrase,
          originalDid,
          "installed identity verification",
        );
        await phase("primary-verified");
        await this.writeMarker(name, "verified", originalDid);
        await phase("marker-verified");
        await removeFile(paths.rollback);
        await removeFile(paths.marker);
        return {
          ...publicIdentity(installed),
          migrated: true,
          backupVerified: true,
          recovered: recovery.recovered,
        };
      });
    } finally {
      passphrase.fill(0);
    }
  }

  async restore(name: string, backupPath: string): Promise<PublicIdentity> {
    assertLocalAlias(name, "identity name");
    const passphrase = await this.getPassphrase(name, "restore", false);
    const primary = this.path(name);
    const resolvedBackup = resolve(backupPath);
    try {
      return await withFileLock(primary, async () => {
        await ensurePrivateDirectory(this.directory);
        if (await pathExists(primary)) {
          throw new BridgeError(`Identity ${name} already exists; restore will not replace it`);
        }
        await this.assertNoMigrationArtifacts(name);
        const backup = await this.requireAt(resolvedBackup, name);
        if (backup.version !== 2) {
          throw new BridgeError("Identity backup is not an encrypted v2 identity");
        }
        const unlocked = await decryptIdentity(backup, passphrase);
        await atomicWriteJson(primary, backup);
        const restored = await this.requireAt(primary, name);
        if (restored.version !== 2) throw new BridgeError(`Identity ${name} restore verification failed`);
        const reopened = await decryptIdentity(restored, passphrase);
        this.ensureSameDid(unlocked.did, reopened.did, "restore verification");
        return publicIdentity(restored);
      });
    } finally {
      passphrase.fill(0);
    }
  }
}
