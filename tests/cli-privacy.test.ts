import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { createStores } from "../src/context.js";
import { temporaryDirectory } from "./helpers.js";

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
  try {
    const stores = createStores(temporary.path);
    await stores.identities.create("alice");
    await stores.identities.create("bob");
    const aliceIdentity = await stores.identities.load("alice");
    const bobIdentity = await stores.identities.load("bob");
    await stores.mailboxes.create("alice", aliceIdentity.did);
    const originalBobMailbox = await stores.mailboxes.create("bob", bobIdentity.did);
    const privateMaterial = [aliceIdentity.privateKeyPem, bobIdentity.privateKeyPem];

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
    await temporary.cleanup();
  }
});
