#!/usr/bin/env node
import { SignedAgentBridge } from "./bridge.js";
import { createStores } from "./context.js";
import { runOfflineDemo } from "./demo.js";
import { BridgeError } from "./errors.js";
import { HttpTechnocoreTransport } from "./transport.js";
import { abbreviatePublicDid, safeErrorMessage } from "./redact.js";

function usage(): never {
  throw new BridgeError(
    "usage: identity:create <name> | identity:inspect <name> | mailbox:create <owner> | " +
    "mailbox:show <owner> | mailbox:rotate <owner> | " +
    "contact:add <owner> <contact-id> <did:key> <mb-p-room> | " +
    "contact:link-local <owner> <contact> | " +
    "message:send <sender> <contact-id> <text> | " +
    "room:send-signed <identity> <room> <text> | inbox:read <owner> | demo",
  );
}

function requireArg(args: string[], index: number): string {
  return args[index] ?? usage();
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
  const { paths: _paths, ...stores } = createStores();

  switch (command) {
    case "identity:create": {
      const identity = await stores.identities.create(requireArg(args, 0));
      console.log(JSON.stringify(identity, null, 2));
      return;
    }
    case "identity:inspect": {
      console.log(JSON.stringify(await stores.identities.inspect(requireArg(args, 0)), null, 2));
      return;
    }
    case "mailbox:create": {
      const owner = requireArg(args, 0);
      const identity = await stores.identities.load(owner);
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
      const bridge = new SignedAgentBridge(stores, liveTransport());
      const response = await bridge.sendTo(
        requireArg(args, 0),
        requireArg(args, 1),
        requireArg(args, 2),
      );
      console.log(JSON.stringify({ sent: true, seq: response.posted?.seq ?? response.last_seq }, null, 2));
      return;
    }
    case "room:send-signed": {
      const identity = requireArg(args, 0);
      const room = requireArg(args, 1);
      const bridge = new SignedAgentBridge(stores, liveTransport());
      const response = await bridge.sendSignedToRoom(identity, room, requireArg(args, 2));
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
