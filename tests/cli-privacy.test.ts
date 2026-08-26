import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { createStores } from "../src/context.js";
import { generatedPassphraseProvider, temporaryDirectory } from "./helpers.js";

function invokeCli(stateRoot: string, ...args: string[]) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TECHNOCORE_HOME: stateRoot,
  };
  delete environment.TECHNOCORE_URL;
  return spawnSync(process.execPath, [resolve("dist/src/cli.js"), ...args], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
  });
}

function assertNoSecrets(output: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    assert.equal(output.includes(secret), false, "normal CLI output disclosed local secret material");
  }
  assert.doesNotMatch(output, /-----BEGIN PRIVATE KEY-----/u);
}

test("local contact linking and mailbox rotation keep capabilities and private keys out of stdout/stderr", async () => {
  const temporary = await temporaryDirectory();
  const passphrases = generatedPassphraseProvider();
  try {
    const stores = createStores(temporary.path, passphrases.provider);
    await stores.identities.create("alice");
    await stores.identities.create("bob");
    const aliceIdentity = await stores.identities.inspect("alice");
    const bobIdentity = await stores.identities.inspect("bob");
    const privateMaterial = [passphrases.passphrase.toString("base64url")];
    const mailboxCreated = invokeCli(temporary.path, "mailbox:create", "alice");
    assert.equal(mailboxCreated.status, 0, mailboxCreated.stderr);
    assert.equal(mailboxCreated.stderr, "");
    assertNoSecrets(`${mailboxCreated.stdout}${mailboxCreated.stderr}`, privateMaterial);
    assert.equal((await stores.mailboxes.load("alice")).did, aliceIdentity.did);
    const originalBobMailbox = await stores.mailboxes.create("bob", bobIdentity.did);

    const inspected = invokeCli(temporary.path, "identity:inspect", "alice");
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.stderr, "");
    assertNoSecrets(`${inspected.stdout}${inspected.stderr}`, privateMaterial);
    assert.equal(JSON.parse(inspected.stdout).did, aliceIdentity.did);

    const nonInteractiveCreate = invokeCli(temporary.path, "identity:create", "charlie");
    assert.equal(nonInteractiveCreate.status, 1);
    assert.match(nonInteractiveCreate.stderr, /private interactive TTY/u);
    assertNoSecrets(
      `${nonInteractiveCreate.stdout}${nonInteractiveCreate.stderr}`,
      privateMaterial,
    );

    const linked = invokeCli(temporary.path, "contact:link-local", "alice", "bob");
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(linked.stderr, "");
    assertNoSecrets(`${linked.stdout}${linked.stderr}`, [originalBobMailbox.room, ...privateMaterial]);
    assert.match(linked.stdout, /\[REDACTED_CAPABILITY\]/u);
    assert.equal((await stores.contacts.get("alice", "bob")).mailbox, originalBobMailbox.room);

    const rotated = invokeCli(temporary.path, "mailbox:rotate", "bob");
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.equal(rotated.stderr, "");
    const replacementBobMailbox = await stores.mailboxes.load("bob");
    assert.notEqual(replacementBobMailbox.room, originalBobMailbox.room);
    assertNoSecrets(`${rotated.stdout}${rotated.stderr}`, [
      originalBobMailbox.room,
      replacementBobMailbox.room,
      ...privateMaterial,
    ]);
    assert.match(rotated.stdout, /Contacts referencing the old mailbox must be relinked/u);
    assert.match(rotated.stdout, /"liveActivity": false/u);
  } finally {
    passphrases.cleanup();
    await temporary.cleanup();
  }
});
