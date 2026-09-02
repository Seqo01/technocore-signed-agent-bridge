import { resolve } from "node:path";

export interface BridgePaths {
  root: string;
  identities: string;
  mailboxes: string;
  contacts: string;
  cursors: string;
  nonces: string;
  approvals: string;
}
export function bridgePaths(root?: string): BridgePaths {
  const resolved = resolve(
    root ?? process.env.TECHNOCORE_HOME ?? resolve(process.cwd(), ".technocore"),
  );
  return {
    root: resolved,
    identities: resolve(resolved, "identities"),
    mailboxes: resolve(resolved, "mailboxes"),
    contacts: resolve(resolved, "contacts"),
    cursors: resolve(resolved, "cursors"),
    nonces: resolve(resolved, "nonces.json"),
    approvals: resolve(resolved, "approvals"),
  };
}
