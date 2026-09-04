import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { createStores } from "../context.js";
import { hiddenPassphraseProvider } from "../passphrase.js";
import { atomicCreateJson, pathExists } from "../fs-safe.js";
import { hashValue } from "../agent/util.js";
import { CapabilityRegistry, SessionAuthority, type PeerAlias, type SessionPolicy } from "./session-policy.js";
import { SessionStateStore, sessionDirectory, classifyInterruptedSession } from "./session-state.js";
import { SwarmSessionSupervisor } from "./supervisor.js";
import { validateProposal } from "./proposal.js";

async function readBoundedJson(path: string, limit: number): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new BridgeError("Local input file exceeds bound");
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new BridgeError("Invalid local JSON input"); }
}
function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new BridgeError(`Required option: ${name}`);
  return args[index + 1]!;
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
/** Status deliberately excludes raw proposals, effects, and operational rooms. */
export async function peerSessionCommand(command: string, args: string[]): Promise<void> {
  const root = createStores().paths.root;
  if (command === "swarm:start") {
    const offline = args.includes("--offline");
    const policy = await readBoundedJson(option(args, "--policy"), 32768) as SessionPolicy;
    const reviewedPolicyHash = option(args, "--policy-hash");
    if (!offline) throw new BridgeError("No real inference provider is wired into the CLI; configure the provider through the host API. No session started");
    if (policy.mode !== "offline") throw new BridgeError("Offline flag/policy mismatch");
    const session = await SwarmSessionSupervisor.start({ root, policy, reviewedPolicyHash, passphrases: hiddenPassphraseProvider });
    console.log(JSON.stringify({ sessionId: policy.sessionId, mode: "offline", network: "disabled", status: "started" }));
    await session.run();
    console.log(JSON.stringify({ sessionId: policy.sessionId, status: session.snapshot().lifecycle }));
    return;
  }
  if (command === "swarm:status" || command === "swarm:stop") {
    if (args.length !== 1) throw new BridgeError("Expected one session id");
    const state = await SessionStateStore.read(root, args[0]!);
    const active = alive(state.pid) && state.lifecycle === "active";
    if (command === "swarm:stop") {
      if (!active) throw new BridgeError("No active session; no authority resumed");
      const path = resolve(sessionDirectory(root, state.sessionId), "stop.json");
      if (!await pathExists(path)) await atomicCreateJson(path, { version: 1, sessionId: state.sessionId, policyHash: state.policyHash });
      console.log(JSON.stringify({ sessionId: state.sessionId, status: "stop-requested" })); return;
    }
    const view = active ? state : classifyInterruptedSession(state);
    console.log(JSON.stringify({ sessionId: view.sessionId, mode: view.policy.mode, lifecycle: view.lifecycle,
      policyHash: view.policyHash, budgets: view.budgets, jobs: Object.values(view.jobs).map(j => ({ id: j.id, status: j.status })),
      tasks: Object.values(view.tasks).map(t => ({ id: t.id, alias: t.alias, compute: t.compute, delivery: t.delivery })),
      effects: Object.values(view.effects).map(e => ({ id: e.id, source: e.source, target: e.target, status: e.status, ...(e.seq ? { seq: e.seq } : {}) })) }, null, 2)); return;
  }
  if (command === "peer:capabilities") {
    const alias = args[0];
    if (!alias) throw new BridgeError("Expected peer alias");
    if (args.includes("--session")) {
      const state = await SessionStateStore.read(root, option(args, "--session"));
      const registry = new CapabilityRegistry(state.policy);
      registry.availability(state.lifecycle === "active" && alive(state.pid) && Date.now() < Date.parse(state.policy.expiresAt) ? "available" : "stopped");
      console.log(JSON.stringify(registry.get(alias), null, 2)); return;
    }
    const policy = await readBoundedJson(option(args, "--policy"), 32768) as SessionPolicy;
    const authority = new SessionAuthority(policy, option(args, "--policy-hash"));
    console.log(JSON.stringify(authority.capabilities.get(alias), null, 2)); return;
  }
  if (command === "peer:submit") {
    const alias = args[0] as PeerAlias, file = args[1];
    if (!alias || !file) throw new BridgeError("Expected recipient alias and local proposal file");
    const sessionId = option(args, "--session");
    const state = await SessionStateStore.read(root, sessionId);
    if (state.policy.mode !== "offline" || state.lifecycle !== "active" || !alive(state.pid)) throw new BridgeError("Local helper requires an active OFFLINE session");
    const p = validateProposal(await readBoundedJson(file, state.policy.limits.payloadBytes), state.policy.limits.payloadBytes);
    if (state.policy.members.find(m => m.alias === alias)?.did !== p.recipientDid) throw new BridgeError("Recipient alias/DID mismatch");
    const id = hashValue({ alias, proposal: p });
    const path = resolve(sessionDirectory(root, sessionId), "submissions", `${id}.json`);
    if (!await pathExists(path)) await atomicCreateJson(path, { alias, proposal: p });
    console.log(JSON.stringify({ submissionId: id, recipient: alias, status: "queued-local-only" })); return;
  }
  throw new BridgeError("Unsupported peer session command");
}
