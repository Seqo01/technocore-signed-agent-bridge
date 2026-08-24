import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { BridgeError } from "./errors.js";
import { atomicWriteJson, readJsonFile, withFileLock } from "./fs-safe.js";
import { assertLocalAlias, assertSignedPrivateMailbox } from "./names.js";
import type { StoredMailbox } from "./types.js";

export class MailboxStore {
  constructor(private readonly directory: string) {}

  private path(owner: string): string {
    return resolve(this.directory, `${assertLocalAlias(owner, "owner")}.json`);
  }

  async create(owner: string, did: string): Promise<StoredMailbox> {
    const path = this.path(owner);
    try {
      await access(path);
      throw new BridgeError(`Mailbox for ${owner} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const mailbox = this.fresh(owner, did);
    await atomicWriteJson(path, mailbox);
    return mailbox;
  }

  async rotate(owner: string): Promise<StoredMailbox> {
    const path = this.path(owner);
    return withFileLock(path, async () => {
      const current = await this.load(owner);
      let replacement = this.fresh(owner, current.did);
      while (replacement.room === current.room) {
        replacement = this.fresh(owner, current.did);
      }
      await atomicWriteJson(path, replacement);
      return replacement;
    });
  }

  async load(owner: string): Promise<StoredMailbox> {
    const mailbox = await readJsonFile<StoredMailbox | null>(this.path(owner), null);
    if (!mailbox) throw new BridgeError(`Mailbox for ${owner} does not exist`);
    if (mailbox.version !== 1 || mailbox.owner !== owner) {
      throw new BridgeError(`Mailbox for ${owner} has an unsupported local format`);
    }
    assertSignedPrivateMailbox(mailbox.room);
    return mailbox;
  }

  private fresh(owner: string, did: string): StoredMailbox {
    const mailbox: StoredMailbox = {
      version: 1,
      owner,
      did,
      room: `mb-p-${randomBytes(20).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    assertSignedPrivateMailbox(mailbox.room);
    return mailbox;
  }
}
