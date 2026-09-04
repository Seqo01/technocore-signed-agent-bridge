import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { AgentRuntimeLock } from "../agent/runtime-lock.js";
import { hashValue } from "../agent/util.js";

const held = new AsyncLocalStorage<ReadonlySet<string>>();
export function mailboxOwnerPath(root: string, room: string): string {
  return resolve(root, "swarm", "mailbox-owners", `${hashValue(room)}.lock`);
}
/** Shared by legacy inbox readers and new sessions. No TTL stealing and no secret path components. */
export async function withMailboxOwner<T>(root: string, room: string, operation: () => Promise<T>): Promise<T> {
  const path = mailboxOwnerPath(root, room);
  if (held.getStore()?.has(path)) return operation();
  const lock = await AgentRuntimeLock.acquire(path);
  try { return await held.run(new Set([...(held.getStore() ?? []), path]), operation); }
  finally { await lock.release(); }
}
