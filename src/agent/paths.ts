import { resolve } from "node:path";
import { assertLocalAlias } from "../names.js";

export interface AgentPaths {
  directory: string;
  state: string;
  journal: string;
  memory: string;
  runtimeLock: string;
}

export function agentPaths(root: string, identityAlias: string): AgentPaths {
  const alias = assertLocalAlias(identityAlias, "agent identity alias");
  const directory = resolve(root, "agents", alias);
  return {
    directory,
    state: resolve(directory, "state.json"),
    journal: resolve(directory, "journal.jsonl"),
    memory: resolve(directory, "memory.json"),
    runtimeLock: resolve(directory, "runtime.lock"),
  };
}
