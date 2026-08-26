import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { atomicWriteJson, pathExists, readJsonFile } from "../src/fs-safe.js";
import { IdentityStore, type MigrationPhase } from "../src/identity.js";
import { bridgePaths } from "../src/paths.js";
import { signMessage } from "../src/protocol.js";
import type { StoredIdentityV2 } from "../src/types.js";
import {
  createTemporaryV1Identity,
  generatedPassphraseProvider,
  temporaryDirectory,
} from "./helpers.js";

function flipBase64Url(value: string): string {
  const replacement = value[0] === "A" ? "B" : "A";
  return `${replacement}${value.slice(1)}`;
}

async function readV2(path: string): Promise<StoredIdentityV2> {
  const value = await readJsonFile<StoredIdentityV2 | null>(path, null);
  assert.equal(value?.version, 2);
  return value!;
}

test("v1 migration preserves the exact DID, creates a verified encrypted backup and reopens", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const paths = bridgePaths(temporary.path);
    const original = await createTemporaryV1Identity(paths.identities, "alice");
    const backup = resolve(temporary.path, "offline", "alice.identity.v2.json");
    const store = new IdentityStore(paths.identities, passphrases.provider);

    assert.equal((await store.inspect("alice")).did, original.did);
    await assert.rejects(
      () => store.unlock("alice"),
      /plaintext version 1.*identity:migrate/u,
    );

    const result = await store.migrate("alice", backup);
    assert.equal(result.migrated, true);
    assert.equal(result.backupVerified, true);
    assert.equal(result.did, original.did);

    const primaryPath = resolve(paths.identities, "alice.json");
    const primaryText = await readFile(primaryPath, "utf8");
    const backupText = await readFile(backup, "utf8");
    assert.doesNotMatch(primaryText, /privateKeyPem|BEGIN PRIVATE KEY/u);
    assert.doesNotMatch(backupText, /privateKeyPem|BEGIN PRIVATE KEY/u);
    const primary = await readV2(primaryPath);
    const encryptedBackup = await readV2(backup);
    assert.equal(primary.did, original.did);
    assert.equal(encryptedBackup.did, original.did);
    assert.notEqual(
      primary.encryptedPrivateKey.kdf.salt,
      encryptedBackup.encryptedPrivateKey.kdf.salt,
    );
    assert.notEqual(
      primary.encryptedPrivateKey.cipher.iv,
      encryptedBackup.encryptedPrivateKey.cipher.iv,
    );

    const unlocked = await store.unlock("alice");
    assert.equal(unlocked.did, original.did);
    assert.equal(signMessage(unlocked, "lobby", "1", "migration proof").did, original.did);
    assert.equal((await new IdentityStore(paths.identities).inspect("alice")).did, original.did);

    const repeated = await store.migrate("alice", backup);
    assert.equal(repeated.migrated, false);
    assert.equal(repeated.did, original.did);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("wrong passphrase, ciphertext, tag and authenticated metadata tampering fail closed", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  const wrongPassphrases = generatedPassphraseProvider();
  try {
    const paths = bridgePaths(temporary.path);
    const store = new IdentityStore(paths.identities, passphrases.provider);
    await store.create("alice");
    const identityPath = resolve(paths.identities, "alice.json");
    const original = await readV2(identityPath);

    const wrongStore = new IdentityStore(paths.identities, wrongPassphrases.provider);
    await assert.rejects(() => wrongStore.unlock("alice"), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /could not be unlocked/u);
      assert.equal(message.includes(wrongPassphrases.passphrase.toString("base64url")), false);
      return true;
    });

    const tamperedCiphertext: StoredIdentityV2 = structuredClone(original);
    tamperedCiphertext.encryptedPrivateKey.ciphertext = flipBase64Url(
      tamperedCiphertext.encryptedPrivateKey.ciphertext,
    );
    await atomicWriteJson(identityPath, tamperedCiphertext);
    await assert.rejects(() => store.unlock("alice"), /could not be unlocked/u);

    const tamperedTag: StoredIdentityV2 = structuredClone(original);
    tamperedTag.encryptedPrivateKey.cipher.tag = flipBase64Url(
      tamperedTag.encryptedPrivateKey.cipher.tag,
    );
    await atomicWriteJson(identityPath, tamperedTag);
    await assert.rejects(() => store.unlock("alice"), /could not be unlocked/u);

    const tamperedMetadata: StoredIdentityV2 = structuredClone(original);
    tamperedMetadata.createdAt = new Date(Date.parse(original.createdAt) + 1).toISOString();
    await atomicWriteJson(identityPath, tamperedMetadata);
    await assert.rejects(() => store.unlock("alice"), /could not be unlocked/u);

    const tamperedDid: StoredIdentityV2 = structuredClone(original);
    tamperedDid.did = `${original.did}x`;
    await atomicWriteJson(identityPath, tamperedDid);
    await assert.rejects(() => store.unlock("alice"), /public integrity validation/u);

    await atomicWriteJson(identityPath, original);
    assert.equal((await store.unlock("alice")).did, original.did);
  } finally {
    passphrases.cleanup();
    wrongPassphrases.cleanup();
    await temporary.cleanup();
  }
});

test("invalid and excessive KDF parameters are rejected before key derivation", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const paths = bridgePaths(temporary.path);
    const store = new IdentityStore(paths.identities, passphrases.provider);
    await store.create("alice");
    const identityPath = resolve(paths.identities, "alice.json");
    const original = await readV2(identityPath);
    const invalid: StoredIdentityV2 = structuredClone(original);
    invalid.encryptedPrivateKey.kdf.N = 2 ** 30;
    await atomicWriteJson(identityPath, invalid);

    const started = performance.now();
    await assert.rejects(() => store.unlock("alice"), /unsupported encryption parameters/u);
    assert.ok(performance.now() - started < 100, "hostile KDF parameters must fail before scrypt");
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("an encrypted backup restores the same DID without replacing an existing identity", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const paths = bridgePaths(temporary.path);
    const original = await createTemporaryV1Identity(paths.identities, "alice");
    const backup = resolve(temporary.path, "offline", "alice.identity.v2.json");
    const store = new IdentityStore(paths.identities, passphrases.provider);
    await store.migrate("alice", backup);
    await assert.rejects(() => store.restore("alice", backup), /already exists/u);

    await rm(resolve(paths.identities, "alice.json"));
    const restored = await store.restore("alice", backup);
    assert.equal(restored.did, original.did);
    assert.equal((await store.unlock("alice")).did, original.did);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("every migration phase can crash and recover without changing the DID", async () => {
  const phases: readonly MigrationPhase[] = [
    "backup-verified",
    "candidate-verified",
    "marker-prepared",
    "original-moved",
    "marker-original-moved",
    "candidate-installed",
    "marker-installed",
    "primary-verified",
    "marker-verified",
  ];

  for (const crashPhase of phases) {
    const temporary = await temporaryDirectory();
    const passphrases = generatedPassphraseProvider();
    try {
      const paths = bridgePaths(temporary.path);
      const original = await createTemporaryV1Identity(paths.identities, "alice");
      const backup = resolve(temporary.path, "offline", "alice.identity.v2.json");
      const store = new IdentityStore(paths.identities, passphrases.provider);
      await assert.rejects(
        () => store.migrate("alice", backup, {
          onPhase: (phase) => {
            if (phase === crashPhase) throw new Error(`injected crash at ${phase}`);
          },
        }),
        /injected crash/u,
      );

      const reopened = new IdentityStore(paths.identities, passphrases.provider);
      const recovered = await reopened.migrate("alice", backup);
      assert.equal(recovered.did, original.did, crashPhase);
      assert.equal((await reopened.unlock("alice")).did, original.did, crashPhase);
      assert.equal(await pathExists(resolve(paths.identities, "alice.json.migrate-v2")), false);
      assert.equal(await pathExists(resolve(paths.identities, "alice.json.v1.rollback")), false);
      assert.equal(await pathExists(resolve(paths.identities, "alice.json.migration.json")), false);
    } finally {
      passphrases.cleanup();
      await temporary.cleanup();
    }
  }
});

test("an invalid installed candidate restores the plaintext rollback and never regenerates", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const paths = bridgePaths(temporary.path);
    const original = await createTemporaryV1Identity(paths.identities, "alice");
    const backup = resolve(temporary.path, "offline", "alice.identity.v2.json");
    const store = new IdentityStore(paths.identities, passphrases.provider);
    await assert.rejects(
      () => store.migrate("alice", backup, {
        onPhase: (phase) => {
          if (phase === "candidate-installed") throw new Error("injected crash");
        },
      }),
      /injected crash/u,
    );

    const primaryPath = resolve(paths.identities, "alice.json");
    const wrongPassphrases = generatedPassphraseProvider();
    try {
      const wrongStore = new IdentityStore(paths.identities, wrongPassphrases.provider);
      await assert.rejects(
        () => wrongStore.migrate("alice", backup),
        /could not verify the passphrase.*preserved/u,
      );
      assert.equal(await pathExists(primaryPath), true);
      assert.equal(await pathExists(`${primaryPath}.v1.rollback`), true);
    } finally {
      wrongPassphrases.cleanup();
    }

    const installed = await readV2(primaryPath);
    installed.encryptedPrivateKey.ciphertext = flipBase64Url(
      installed.encryptedPrivateKey.ciphertext,
    );
    await atomicWriteJson(primaryPath, installed);

    await assert.rejects(
      () => store.migrate("alice", backup),
      /plaintext rollback was restored/u,
    );
    const restoredV1 = await readJsonFile<{ version: number; did: string } | null>(primaryPath, null);
    assert.equal(restoredV1?.version, 1);
    assert.equal(restoredV1?.did, original.did);

    const completed = await store.migrate("alice", backup);
    assert.equal(completed.did, original.did);
    assert.equal((await store.unlock("alice")).did, original.did);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("concurrent identity creation and migration serialize safely", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const paths = bridgePaths(temporary.path);
    const createStore = new IdentityStore(paths.identities, passphrases.provider);
    const creations = await Promise.allSettled([
      createStore.create("alice"),
      createStore.create("alice"),
    ]);
    assert.equal(creations.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(creations.filter(({ status }) => status === "rejected").length, 1);

    const original = await createTemporaryV1Identity(paths.identities, "bob");
    const backup = resolve(temporary.path, "offline", "bob.identity.v2.json");
    const first = new IdentityStore(paths.identities, passphrases.provider);
    const second = new IdentityStore(paths.identities, passphrases.provider);
    const migrations = await Promise.all([
      first.migrate("bob", backup),
      second.migrate("bob", backup),
    ]);
    assert.deepEqual(migrations.map(({ did }) => did), [original.did, original.did]);
    assert.equal((await first.unlock("bob")).did, original.did);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});

test("identity errors never contain generated passphrases or private keys", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  const wrong = randomBytes(32);
  try {
    const paths = bridgePaths(temporary.path);
    const original = await createTemporaryV1Identity(paths.identities, "alice");
    const backup = resolve(temporary.path, "offline", "alice.identity.v2.json");
    const store = new IdentityStore(paths.identities, passphrases.provider);
    await store.migrate("alice", backup);
    const wrongStore = new IdentityStore(paths.identities, async () => Buffer.from(wrong));
    let message = "";
    try {
      await wrongStore.unlock("alice");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.notEqual(message, "");
    assert.equal(message.includes(passphrases.passphrase.toString("base64url")), false);
    assert.equal(message.includes(wrong.toString("base64url")), false);
    assert.equal(message.includes(original.privateKeyPem), false);
    assert.doesNotMatch(message, /BEGIN PRIVATE KEY|encryptedPrivateKey|ciphertext/u);
  } finally {
    wrong.fill(0);
    passphrases.cleanup();
    await temporary.cleanup();
  }
});
