import { resolve } from "node:path";
import { createStores } from "../context.js";
import { BridgeError } from "../errors.js";
import { readJsonFile, withFileLock } from "../fs-safe.js";
import { AgentRoleStore } from "../agent/roles.js";
import { AgentStateStore } from "../agent/state-store.js";
import { agentPaths } from "../agent/paths.js";

export const TEAM = { alice: "coordinator", bob: "researcher", charlie: "engineer", dave: "reviewer", eve: "specialist" } as const;
export type Alias = keyof typeof TEAM;
export const ALIASES = Object.keys(TEAM) as Alias[];

/** Explicit local setup only. No unlock, transport, rotations, or full mesh. */
export async function prepareRehearsalContacts(root?: string): Promise<void> {
  const stores = createStores(root);
  const identities = new Map();
  for (const alias of ALIASES) {
    const identity = await stores.identities.inspect(alias);
    const paths = agentPaths(stores.paths.root, alias);
    const state = await new AgentStateStore(paths.state).load();
    if (state.profile.did !== identity.did || state.profile.identityAlias !== alias ||
      await new AgentRoleStore(paths.directory).load(identity) !== TEAM[alias]) throw new BridgeError("Rehearsal profile binding mismatch");
    identities.set(alias, identity);
  }
  for (const alias of ["charlie", "dave", "eve"] as const) {
    const path = resolve(stores.paths.mailboxes, `${alias}.json`);
    await withFileLock(path, async () => {
      if (await readJsonFile(path, null) === null) await stores.mailboxes.create(alias, identities.get(alias).did);
      if ((await stores.mailboxes.load(alias)).did !== identities.get(alias).did) throw new BridgeError("Existing mailbox binding mismatch");
    });
  }
  // Pre-existing entries are inspected, never rewritten, including their timestamps.
  for (const peer of ["charlie", "dave", "eve"] as const) {
    for (const [owner, target] of [["alice", peer], [peer, "alice"]] as const) {
      const mailbox = await stores.mailboxes.load(target);
      const did = identities.get(target).did;
      if (mailbox.did !== did) throw new BridgeError("Mailbox identity mismatch");
      const state = await readJsonFile<{ contacts: Record<string, { did: string; mailbox: string }> }>(
        resolve(stores.paths.contacts, `${owner}.json`), { contacts: {} });
      const existing = state.contacts[target];
      if (existing) {
        if (existing.did !== did || existing.mailbox !== mailbox.room) throw new BridgeError("Existing contact differs; manual reconciliation required");
      } else await stores.contacts.add(owner, target, did, mailbox.room);
    }
  }
}
