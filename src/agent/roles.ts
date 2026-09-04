import { resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { atomicWriteJson, readJsonFile, withFileLock } from "../fs-safe.js";
import type { PublicIdentity } from "../types.js";

export const AGENT_ROLES = ["coordinator", "researcher", "engineer", "reviewer", "specialist"] as const;
export type AgentRole = typeof AGENT_ROLES[number];
export const ROLE_WORKLOADS: Readonly<Record<AgentRole, readonly string[]>> = Object.freeze({
  coordinator: Object.freeze(["workload.coordination", "workload.synthesis", "workload.collaboration"]),
  researcher: Object.freeze(["workload.research", "workload.synthesis", "workload.collaboration"]),
  engineer: Object.freeze(["workload.engineering", "workload.collaboration"]),
  reviewer: Object.freeze(["workload.review", "workload.collaboration"]),
  specialist: Object.freeze(["workload.specialist", "workload.collaboration"]),
});

export function assertRoleWorkload(role: AgentRole, type: string): void {
  if (!ROLE_WORKLOADS[role].includes(type)) throw new BridgeError("Workload is not supported by this agent role");
}

interface RoleRecord { version: 1; identityAlias: string; did: string; role: AgentRole }

/** Operator-owned local metadata, not part of identity or peer data. No implicit role. */
export class AgentRoleStore {
  private readonly path: string;
  constructor(directory: string) { this.path = resolve(directory, "role.json"); }

  async load(identity: Pick<PublicIdentity, "name" | "did">): Promise<AgentRole | undefined> {
    const value = await readJsonFile<RoleRecord | null>(this.path, null);
    if (!value) return undefined;
    if (value.version !== 1 || value.identityAlias !== identity.name || value.did !== identity.did ||
      !AGENT_ROLES.includes(value.role)) throw new BridgeError("Role metadata does not match the selected profile DID");
    return value.role;
  }

  async assign(identity: Pick<PublicIdentity, "name" | "did">, role: AgentRole): Promise<void> {
    if (!AGENT_ROLES.includes(role)) throw new BridgeError("Unsupported agent role");
    await withFileLock(this.path, async () => {
      const existing = await this.load(identity);
      if (existing && existing !== role) throw new BridgeError("Existing role differs; explicit policy migration required");
      await atomicWriteJson(this.path, { version: 1, identityAlias: identity.name, did: identity.did, role });
    });
  }
}
