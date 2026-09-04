#!/usr/bin/env node
import { SignedAgentBridge } from "./bridge.js";
import { createStores } from "./context.js";
import { runOfflineDemo } from "./demo.js";
import { BridgeError } from "./errors.js";
import { HttpTechnocoreTransport } from "./transport.js";
import { abbreviatePublicDid, safeErrorMessage } from "./redact.js";
import { hiddenPassphraseProvider } from "./passphrase.js";
import { initializeAgent } from "./agent/runtime.js";
import { AgentRoleStore, type AgentRole } from "./agent/roles.js";
import { AgentStateStore } from "./agent/state-store.js";
import { agentPaths } from "./agent/paths.js";
import { InMemoryTechnocoreTransport } from "./mock-transport.js";
import { pathExists } from "./fs-safe.js";
import { readJsonFile } from "./fs-safe.js";
import { resolve } from "node:path";
import { FirstRehearsal, type AnalysisPacket } from "./rehearsal/runner.js";
import { ALIASES, type Alias } from "./rehearsal/setup.js";
import { FirstReceiptReconciliation } from "./rehearsal/reconciliation.js";
import { SendReconciliation } from "./rehearsal/send-reconciliation.js";
import { peerSessionCommand } from "./swarm/cli.js";

function usage(): never {
  throw new BridgeError(
    "usage: identity:create <name> | identity:inspect <name> | " +
    "swarm:start --offline --policy <file> --policy-hash <hash> | swarm:status <id> | swarm:stop <id> | " +
    "peer:capabilities <alias> --policy <file> --policy-hash <hash> | peer:submit <alias> <file> --session <id> | " +
    "identity:migrate <name> --backup <path> | identity:restore <name> --backup <path> | " +
    "agent:init <existing-identity> | agent:role <alias> <role> <expected-did> | " +
    "rehearsal:prepare | rehearsal:status | rehearsal:send <action-id> <action-hash> | " +
    "rehearsal:receive <step> | rehearsal:work <alias> | rehearsal:finalize | " +
    "rehearsal:reconcile-prepare | rehearsal:reconcile-status | " +
    "rehearsal:reconcile-authorize <id> <hash> | rehearsal:reconcile-observe <id> <hash> | rehearsal:reconcile-complete <id> <hash> | " +
    "rehearsal:reconcile-apply <authorization-id> <authorization-hash> | " +
    "rehearsal:send-reconcile-prepare <step> | rehearsal:send-reconcile-authorize <id> <hash> | " +
    "rehearsal:send-reconcile-observe <id> <hash> | rehearsal:send-reconcile-apply <id> <hash> | rehearsal:send-reconcile-status <id> <hash> | " +
    "action:prepare-contact <sender> <contact-id> <text> | action:prepare-public <sender> <room> <text> | " +
    "action:approve <alias> <action-id> <action-hash> | " +
    "mailbox:create <owner> | " +
    "mailbox:show <owner> | mailbox:rotate <owner> | " +
    "contact:add <owner> <contact-id> <did:key> <mb-p-room> | " +
    "contact:link-local <owner> <contact> | " +
    "message:send <sender> <contact-id> <text> [--action <id>] | " +
    "room:send-signed <identity> <room> <text> [--action <id>] | inbox:read <owner> | demo",
  );
}

function requireArg(args: string[], index: number): string {
  return args[index] ?? usage();
}

function requireBackupPath(args: string[]): string {
  if (args.length !== 3 || args[1] !== "--backup") usage();
  return requireArg(args, 2);
}

function liveTransport(): HttpTechnocoreTransport {
  const baseUrl = process.env.TECHNOCORE_URL;
  if (!baseUrl) {
    throw new BridgeError("TECHNOCORE_URL is required; there is deliberately no live default");
  }
  return new HttpTechnocoreTransport(baseUrl);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  if (["swarm:start", "swarm:status", "swarm:stop", "peer:capabilities", "peer:submit"].includes(command)) {
    await peerSessionCommand(command, args); return;
  }
  const { paths: _paths, ...stores } = createStores(undefined, hiddenPassphraseProvider);

  switch (command) {
    case "rehearsal:send-reconcile-prepare":
    case "rehearsal:send-reconcile-authorize":
    case "rehearsal:send-reconcile-observe":
    case "rehearsal:send-reconcile-apply":
    case "rehearsal:send-reconcile-status": {
      const recovery = new SendReconciliation({ root: _paths.root, passphrases: hiddenPassphraseProvider });
      const prepare = command === "rehearsal:send-reconcile-prepare";
      if (args.length !== (prepare ? 1 : 2) || (prepare && !/^[1-8]$/u.test(args[0]!))) usage();
      const result = prepare ? await recovery.prepare(Number(args[0])) :
        command === "rehearsal:send-reconcile-authorize" ? await recovery.authorize(args[0]!, args[1]!) :
        command === "rehearsal:send-reconcile-observe" ? await recovery.observe(args[0]!, args[1]!) :
        command === "rehearsal:send-reconcile-apply" ? await recovery.apply(args[0]!, args[1]!) : await recovery.status(args[0]!, args[1]!);
      console.log(JSON.stringify(result, null, 2)); return;
    }
    case "rehearsal:reconcile-apply": {
      if (args.length !== 2) usage();
      const runner = new FirstRehearsal({ root: _paths.root, passphrases: hiddenPassphraseProvider });
      console.log(JSON.stringify(await runner.applyReconciliation(args[0]!, args[1]!), null, 2));
      return;
    }
    case "rehearsal:reconcile-prepare":
    case "rehearsal:reconcile-status":
    case "rehearsal:reconcile-authorize":
    case "rehearsal:reconcile-observe":
    case "rehearsal:reconcile-complete": {
      const reconciliation = new FirstReceiptReconciliation({ root: _paths.root, passphrases: hiddenPassphraseProvider });
      const localRead = command === "rehearsal:reconcile-prepare" || command === "rehearsal:reconcile-status";
      if (args.length !== (localRead ? 0 : 2)) usage();
      const result = command === "rehearsal:reconcile-prepare" ? await reconciliation.prepare() :
        command === "rehearsal:reconcile-status" ? await reconciliation.status() :
        command === "rehearsal:reconcile-authorize" ? await reconciliation.authorize(args[0]!, args[1]!) :
        command === "rehearsal:reconcile-observe" ? await reconciliation.observe(args[0]!, args[1]!) :
        await reconciliation.complete(args[0]!, args[1]!);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "rehearsal:prepare":
    case "rehearsal:status":
    case "rehearsal:send":
    case "rehearsal:receive":
    case "rehearsal:work":
    case "rehearsal:finalize": {
      const runner = new FirstRehearsal({ root: _paths.root, passphrases: hiddenPassphraseProvider });
      let result;
      if (command === "rehearsal:send") {
        if (args.length !== 2) usage();
        result = await runner.send(args[0]!, args[1]!);
      } else if (command === "rehearsal:receive") {
        if (args.length !== 1 || !/^[1-8]$/u.test(args[0]!)) usage();
        result = await runner.receive(Number(args[0]));
      } else if (command === "rehearsal:work" || command === "rehearsal:finalize") {
        const alias = command === "rehearsal:finalize" ? "alice" : args[0] as Alias;
        if (args.length !== (command === "rehearsal:finalize" ? 0 : 1) || !ALIASES.includes(alias)) usage();
        const input = await readJsonFile<AnalysisPacket | null>(resolve(_paths.root, "rehearsal-inputs", `${alias}.json`), null);
        if (!input) throw new BridgeError("Operator analysis file is required under ignored rehearsal-inputs");
        result = await runner.work(alias, input);
      } else {
        if (args.length !== 0) usage();
        result = command === "rehearsal:prepare" ? await runner.prepare() : await runner.status();
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "agent:role": {
      if (args.length !== 3) usage();
      const identity = await stores.identities.inspect(requireArg(args, 0));
      if (identity.did !== requireArg(args, 2)) throw new BridgeError("Expected DID does not match identity");
      const paths = agentPaths(_paths.root, identity.name);
      const state = await new AgentStateStore(paths.state).load();
      if (state.profile.identityAlias !== identity.name || state.profile.did !== identity.did) {
        throw new BridgeError("Role assignment requires a matching initialized profile");
      }
      if (await pathExists(paths.runtimeLock)) throw new BridgeError("Stop the agent before configuring its role");
      await new AgentRoleStore(paths.directory).assign(identity, requireArg(args, 1) as AgentRole);
      console.log(JSON.stringify({ alias: identity.name, did: identity.did, role: args[1], liveActivity: false }, null, 2));
      return;
    }
    case "action:prepare-contact":
    case "action:prepare-public": {
      if (args.length !== 3) usage();
      // Preparation must never construct a live transport or unlock a key.
      const bridge = new SignedAgentBridge(stores, new InMemoryTechnocoreTransport());
      const action = command === "action:prepare-contact"
        ? await bridge.prepareContactSend(requireArg(args, 0), requireArg(args, 1), requireArg(args, 2))
        : await bridge.preparePublicSend(requireArg(args, 0), requireArg(args, 1), requireArg(args, 2));
      console.log(JSON.stringify(action, null, 2));
      return;
    }
    case "action:approve": {
      if (args.length !== 3) usage();
      const identity = await stores.identities.inspect(requireArg(args, 0));
      const record = await stores.approvals.read(identity.name, requireArg(args, 1));
      if (record.agentDid !== identity.did) throw new BridgeError("Approval identity binding mismatch");
      console.log(JSON.stringify(await stores.approvals.grant(identity.name, record.actionId, requireArg(args, 2)), null, 2));
      return;
    }
    case "identity:create": {
      const identity = await stores.identities.create(requireArg(args, 0));
      console.log(JSON.stringify(identity, null, 2));
      return;
    }
    case "identity:inspect": {
      console.log(JSON.stringify(await stores.identities.inspect(requireArg(args, 0)), null, 2));
      return;
    }
    case "identity:migrate": {
      const name = requireArg(args, 0);
      const result = await stores.identities.migrate(name, requireBackupPath(args));
      console.log(JSON.stringify({
        name: result.name,
        did: result.did,
        fingerprint: result.fingerprint,
        migrated: result.migrated,
        backupVerified: result.backupVerified,
        recovered: result.recovered,
        liveActivity: false,
      }, null, 2));
      return;
    }
    case "identity:restore": {
      const name = requireArg(args, 0);
      const identity = await stores.identities.restore(name, requireBackupPath(args));
      console.log(JSON.stringify({
        ...identity,
        restored: true,
        liveActivity: false,
      }, null, 2));
      return;
    }
    case "agent:init": {
      const result = await initializeAgent({
        identityAlias: requireArg(args, 0),
        passphrases: hiddenPassphraseProvider,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "mailbox:create": {
      const owner = requireArg(args, 0);
      const identity = await stores.identities.inspect(owner);
      const mailbox = await stores.mailboxes.create(owner, identity.did);
      console.log(JSON.stringify({
        owner: mailbox.owner,
        did: abbreviatePublicDid(mailbox.did),
        createdAt: mailbox.createdAt,
        room: "[REDACTED_CAPABILITY]",
        note: "Use mailbox:show explicitly to reveal the local capability.",
      }, null, 2));
      return;
    }
    case "mailbox:show": {
      console.log(JSON.stringify(await stores.mailboxes.load(requireArg(args, 0)), null, 2));
      return;
    }
    case "mailbox:rotate": {
      const mailbox = await stores.mailboxes.rotate(requireArg(args, 0));
      console.log(JSON.stringify({
        owner: mailbox.owner,
        did: abbreviatePublicDid(mailbox.did),
        rotatedAt: mailbox.createdAt,
        room: "[REDACTED_CAPABILITY]",
        warning: "Contacts referencing the old mailbox must be relinked.",
        liveActivity: false,
      }, null, 2));
      return;
    }
    case "contact:add": {
      const contact = await stores.contacts.add(
        requireArg(args, 0),
        requireArg(args, 1),
        requireArg(args, 2),
        requireArg(args, 3),
      );
      console.log(JSON.stringify({
        contactId: contact.contactId,
        did: contact.did,
        mailbox: "[REDACTED_CAPABILITY]",
        addedAt: contact.addedAt,
      }, null, 2));
      return;
    }
    case "contact:link-local": {
      const owner = requireArg(args, 0);
      const contactId = requireArg(args, 1);
      const contactIdentity = await stores.identities.inspect(contactId);
      const contactMailbox = await stores.mailboxes.load(contactId);
      if (contactMailbox.did !== contactIdentity.did) {
        throw new BridgeError(`Local identity and mailbox for ${contactId} do not match`);
      }
      const contact = await stores.contacts.add(
        owner,
        contactId,
        contactIdentity.did,
        contactMailbox.room,
      );
      console.log(JSON.stringify({
        owner,
        contactId: contact.contactId,
        did: contact.did,
        mailbox: "[REDACTED_CAPABILITY]",
        linkedFrom: "local-state",
        addedAt: contact.addedAt,
      }, null, 2));
      return;
    }
    case "message:send": {
      if (args.length !== 3 && !(args.length === 5 && args[3] === "--action")) usage();
      const bridge = new SignedAgentBridge(stores, liveTransport());
      const response = await bridge.sendTo(
        requireArg(args, 0),
        requireArg(args, 1),
        requireArg(args, 2),
        args[4],
      );
      console.log(JSON.stringify({ sent: true, seq: response.posted?.seq ?? response.last_seq }, null, 2));
      return;
    }
    case "room:send-signed": {
      if (args.length !== 3 && !(args.length === 5 && args[3] === "--action")) usage();
      const identity = requireArg(args, 0);
      const room = requireArg(args, 1);
      const bridge = new SignedAgentBridge(stores, liveTransport());
      const response = await bridge.sendSignedToRoom(identity, room, requireArg(args, 2), args[4]);
      console.log(JSON.stringify({
        sent: true,
        room,
        seq: response.posted?.seq ?? response.last_seq,
      }, null, 2));
      return;
    }
    case "inbox:read": {
      const bridge = new SignedAgentBridge(stores, liveTransport());
      console.log(JSON.stringify(await bridge.readInbox(requireArg(args, 0)), null, 2));
      return;
    }
    case "demo": {
      console.log(JSON.stringify(await runOfflineDemo(), null, 2));
      return;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});
