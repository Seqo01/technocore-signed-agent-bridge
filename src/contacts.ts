import { resolve } from "node:path";
import { atomicWriteJson, readJsonFile, withFileLock } from "./fs-safe.js";
import { BridgeError } from "./errors.js";
import { assertLocalAlias, assertSignedPrivateMailbox } from "./names.js";
import { didToPublicKeyBytes } from "./protocol.js";
import type { Contact } from "./types.js";

interface ContactState {
  version: 1;
  contacts: Record<string, Contact>;
}

export class ContactStore {
  constructor(private readonly directory: string) {}

  private path(owner: string): string {
    return resolve(this.directory, `${assertLocalAlias(owner, "owner")}.json`);
  }

  async add(owner: string, contactId: string, did: string, mailbox: string): Promise<Contact> {
    assertLocalAlias(contactId, "contact id");
    didToPublicKeyBytes(did);
    assertSignedPrivateMailbox(mailbox);
    const path = this.path(owner);
    return withFileLock(path, async () => {
      const state = await readJsonFile<ContactState>(path, { version: 1, contacts: {} });
      if (state.version !== 1 || typeof state.contacts !== "object") {
        throw new BridgeError(`Contacts for ${owner} have an unsupported local format`);
      }
      const contact: Contact = {
        contactId,
        did,
        mailbox,
        lastSeenSeq: state.contacts[contactId]?.lastSeenSeq ?? 0,
        addedAt: new Date().toISOString(),
      };
      state.contacts[contactId] = contact;
      await atomicWriteJson(path, state);
      return contact;
    });
  }

  async get(owner: string, contactId: string): Promise<Contact> {
    const state = await this.load(owner);
    const contact = state.contacts[assertLocalAlias(contactId, "contact id")];
    if (!contact) throw new BridgeError(`Contact ${contactId} does not exist for ${owner}`);
    return contact;
  }

  async findByDid(owner: string, did: string): Promise<Contact | undefined> {
    const state = await this.load(owner);
    return Object.values(state.contacts).find((contact) => contact.did === did);
  }

  private async load(owner: string): Promise<ContactState> {
    const state = await readJsonFile<ContactState>(this.path(owner), { version: 1, contacts: {} });
    if (state.version !== 1 || typeof state.contacts !== "object") {
      throw new BridgeError(`Contacts for ${owner} have an unsupported local format`);
    }
    return state;
  }
}
