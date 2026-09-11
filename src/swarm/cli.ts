import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { createStores } from "../context.js";
import { hiddenPassphraseProvider } from "../passphrase.js";
import { atomicCreateJson, pathExists } from "../fs-safe.js";
import { hashValue } from "../agent/util.js";
import { CapabilityRegistry, SessionAuthority, PEER_ROLES, peerAliases, type PeerAlias, type SessionPolicy } from "./session-policy.js";
import { SessionStateStore, sessionDirectory, classifyInterruptedSession } from "./session-state.js";
import { SwarmSessionSupervisor } from "./supervisor.js";
import { validateProposal } from "./proposal.js";
import { operatorWorkload, readOperatorTask, validateFlow, queueOperatorTask } from "./operator-task.js";
import { operatorView } from "./operator-view.js";
import { AgentRoleStore } from "../agent/roles.js";
import { agentPaths } from "../agent/paths.js";

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
  if (command === "swarm:policy") {
    const file = args[0]; if (!file || args.length !== 5) throw new BridgeError("Expected policy file --session id --flow aliases");
    const flow = validateFlow(option(args, "--flow").split(",")), stores = createStores();
    const policy: SessionPolicy = { version: 1, sessionId: option(args, "--session"), mode: "offline", members: [], pairs: [],
      schemas: ["peer-work/v1", "peer-result/v1"], workloads: [...new Set(flow.map(a => operatorWorkload[a]))].map(type => ({ type, version: 1 })),
      expiresAt: new Date(Date.now() + 23 * 3600000).toISOString(),
      limits: { tasks: 32, outbound: 32, gets: 32, inference: 32, payloadBytes: 4096, depth: 4, concurrency: 1, inferenceTimeoutMs: 1000 },
      network: { origin: "offline", pathClass: "signed-mailbox-only", postRetries: 0 } };
    for (const alias of peerAliases) {
      const identity = await stores.identities.inspect(alias);
      const role = await new AgentRoleStore(agentPaths(root, alias).directory).load(identity);
      if (role !== PEER_ROLES[alias]) throw new BridgeError("Existing role binding mismatch");
      policy.members.push({ alias, did: identity.did, role, mayDelegate: flow.includes(alias) });
    }
    for (let i = 1; i < flow.length; i++) for (const [from, to] of [[flow[i - 1]!, flow[i]!], [flow[i]!, flow[i - 1]!]]) {
      const target = policy.members.find(m => m.alias === to)!.did;
      const contact = await stores.contacts.findByDid(from!, target);
      const mailbox = await stores.mailboxes.load(to!);
      if (!contact || contact.mailbox !== mailbox.room || mailbox.did !== target) throw new BridgeError("Required existing directional contact is missing or mismatched; no contact created");
      policy.pairs.push({ sourceDid: policy.members.find(m => m.alias === from)!.did, targetDid: target, contactId: contact.contactId,
        destinationHash: hashValue({ room: mailbox.room, did: target, contactId: contact.contactId }), workloads: [operatorWorkload[flow[i]!]] });
    }
    new SessionAuthority(policy, hashValue(policy)); await atomicCreateJson(resolve(file), policy);
    console.log(JSON.stringify({ status: "offline-policy-created", policyHash: hashValue(policy), roleFlow: flow, network: "disabled" })); return;
  }
  if (command === "swarm:task") {
    if (args.length !== 3) throw new BridgeError("Expected task file --session id");
    console.log(JSON.stringify(await queueOperatorTask(root, option(args, "--session"), await readOperatorTask(args[0]!)))); return;
  }
  if (command === "swarm:result") {
    if (args.length !== 2) throw new BridgeError("Expected session id and job id");
    console.log(JSON.stringify(await operatorView(root, args[0]!, args[1]!), null, 2)); return;
  }
  if (command === "swarm:pause" || command === "swarm:continue") {
    if (args.length !== 1) throw new BridgeError("Expected session id");
    const state = await SessionStateStore.read(root, args[0]!);
    if (state.policy.mode !== "offline" || !["active", "paused"].includes(state.lifecycle) || !alive(state.pid)) throw new BridgeError("No active OFFLINE process");
    const action = command === "swarm:pause" ? "pause" : "continue";
    const path = resolve(sessionDirectory(root, state.sessionId), `${action}.json`);
    if (!await pathExists(path)) await atomicCreateJson(path, { sessionId: state.sessionId, policyHash: state.policyHash });
    console.log(JSON.stringify({ sessionId: state.sessionId, status: `${action}-requested` })); return;
  }
  if (command === "swarm:resume") {
    if (args.length !== 1) throw new BridgeError("Expected stopped offline session id");
    const state = await SessionStateStore.read(root, args[0]!);
    const session = await SwarmSessionSupervisor.resume({ root, policy: state.policy, reviewedPolicyHash: state.policyHash, passphrases: hiddenPassphraseProvider });
    console.log(JSON.stringify({ sessionId: state.sessionId, status: "reopened", network: "disabled", testingOnly: true }));
    await session.run(); return;
  }
  if (command === "swarm:start") {
    const offline = args.includes("--offline");
    const policy = await readBoundedJson(option(args, "--policy"), 32768) as SessionPolicy;
    const reviewedPolicyHash = args.includes("--policy-hash") ? option(args, "--policy-hash") : hashValue(policy);
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
    const active = alive(state.pid) && ["active", "paused"].includes(state.lifecycle);
    if (command === "swarm:stop") {
      if (!active) throw new BridgeError("No active session; no authority resumed");
      const path = resolve(sessionDirectory(root, state.sessionId), "stop.json");
      if (!await pathExists(path)) await atomicCreateJson(path, { version: 1, sessionId: state.sessionId, policyHash: state.policyHash });
      console.log(JSON.stringify({ sessionId: state.sessionId, status: "stop-requested" })); return;
    }
    if (state.policy.mode === "offline") { console.log(JSON.stringify(await operatorView(root, args[0]!), null, 2)); return; }
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
