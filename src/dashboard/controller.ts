import { resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { atomicCreateJson, pathExists } from "../fs-safe.js";
import { hashValue } from "../agent/util.js";
import type { PassphraseProvider } from "../passphrase.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { assertSessionId, type SessionPolicy } from "../swarm/session-policy.js";
import { SessionStateStore, sessionDirectory } from "../swarm/session-state.js";
import { operatorView } from "../swarm/operator-view.js";
import { queueOperatorTask, validateOperatorTask, type OperatorTask } from "../swarm/operator-task.js";
import { SwarmSessionSupervisor } from "../swarm/supervisor.js";

export type DashboardAction = "start" | "stop" | "pause" | "resume";
export const DASHBOARD_ACTIONS: readonly DashboardAction[] = ["start", "stop", "pause", "resume"];
type Projection = { exists: boolean; view: Awaited<ReturnType<typeof operatorView>> | null; operatorTask: OperatorTask | null };

/** One explicitly selected policy/session, not an autonomous orchestrator or remote control plane. */
export class DashboardController {
  private readonly policy: SessionPolicy;
  private readonly policyHash: string;
  private session: SwarmSessionSupervisor | undefined;
  private running: Promise<void> | undefined;
  private operation: Promise<void> | undefined;
  private phase: DashboardAction | null = null;
  private error: string | null = null;
  private closing = false;
  private cached: Projection = { exists: false, view: null, operatorTask: null };
  private readonly reads = new Set<Promise<Projection>>();

  constructor(private readonly root: string, policy: SessionPolicy, private readonly passphrases: PassphraseProvider) {
    assertSessionId(policy.sessionId);
    if (policy.mode !== "offline" || policy.network.origin !== "offline") throw new BridgeError("Dashboard v1 requires an OFFLINE policy");
    this.policy = structuredClone(policy); this.policyHash = hashValue(this.policy);
  }

  private async stored() {
    if (!await pathExists(resolve(sessionDirectory(this.root, this.policy.sessionId), "session.json"))) return null;
    const state = await SessionStateStore.read(this.root, this.policy.sessionId);
    if (state.policyHash !== this.policyHash) throw new BridgeError("Dashboard policy does not match stored session");
    return state;
  }

  private async project(jobId?: string): Promise<Projection> {
    const stored = await this.stored();
    const view = stored ? await operatorView(this.root, this.policy.sessionId, jobId) : null;
    return { exists: !!stored, view, operatorTask: jobId ? stored?.jobs[jobId]?.operator ?? null : null };
  }

  async view(jobId?: string) {
    if (jobId && !/^[a-f0-9]{64}$/u.test(jobId)) throw new BridgeError("Invalid job id");
    let projection = this.cached;
    if (this.phase || this.closing && (this.session || this.running)) {
      if (jobId) throw new BridgeError("Wait for the local lifecycle operation before inspecting a result");
    } else {
      const pending = this.session ? this.session.atOperatorBoundary(() => this.project(jobId)) : this.project(jobId);
      this.reads.add(pending);
      try { projection = await pending; if (!jobId) this.cached = projection; }
      finally { this.reads.delete(pending); }
    }
    const { exists, view, operatorTask } = projection;
    const state = this.session?.snapshot().lifecycle;
    const can = !this.phase && !this.closing;
    const result = { sessionId: this.policy.sessionId, mode: "offline", testingOnly: true, provider: "deterministic/mock — testing-only",
      network: "disabled", phase: this.phase, error: this.error, expiresAt: this.policy.expiresAt,
      allowed: { start: can && !exists, stop: can && !!this.session && ["active", "paused"].includes(state!),
        pause: can && state === "active", resume: can && (state === "paused" || exists && ["stopped", "halted"].includes(view!.lifecycle)),
        submit: can && !!this.session && ["active", "paused"].includes(state!) && Date.now() < Date.parse(this.policy.expiresAt) },
      agents: view?.agents ?? this.policy.members.map(m => ({ alias: m.alias, state: "not-started", currentTasks: [] })),
      view, operatorTask };
    assertNoSecretLikeOutput(JSON.stringify(result), "Dashboard view");
    return result;
  }

  async request(action: DashboardAction): Promise<void> {
    if (!DASHBOARD_ACTIONS.includes(action) || !(await this.view()).allowed[action]) throw new BridgeError("Action is not available in this session state");
    // Re-check after asynchronous projection: overlapping requests must not enqueue a second start/unlock.
    if (this.phase || this.closing) throw new BridgeError("A dashboard operation is already in progress");
    this.phase = action; this.error = null;
    // Finish prior file reads before startup/shutdown; new reads use the last safe projection.
    this.operation = Promise.allSettled([...this.reads]).then(() => this.perform(action)).catch((error: unknown) => {
      const code = error instanceof Error && error.message === "Session checkpoint changed outside its owner" ? "checkpoint-conflict" :
        error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOENT"].includes(String(error.code)) ? "local-file-access" : "operation-rejected";
      this.error = `Operation failed (${code}). No automatic retry. Check policy expiry, existing bindings, session ownership and terminal unlock; inspect session state before proceeding.`;
    }).finally(() => { this.phase = null; this.operation = undefined; });
  }

  private async perform(action: DashboardAction): Promise<void> {
    if (action === "pause") { await this.lifecycleMarker("pause", "paused"); return; }
    if (action === "stop") { await this.stopOwned(); return; }
    if (action === "resume" && this.session?.snapshot().lifecycle === "paused") { await this.lifecycleMarker("continue", "active"); return; }
    const options = { root: this.root, policy: this.policy, reviewedPolicyHash: this.policyHash, passphrases: this.passphrases };
    const session = action === "start" ? await SwarmSessionSupervisor.start(options) : await SwarmSessionSupervisor.resume(options);
    this.session = session;
    // Shutdown never leaves a freshly unlocked session running.
    if (this.closing) { await session.stop(); this.session = undefined; return; }
    this.running = session.run().catch((error: unknown) => {
      // The existing run loop can race its stop-file timer before step(). Its finalizer
      // still persists STOPPED. Only that exact, completed operator stop is expected.
      if ((this.phase === "stop" || this.closing) && session.snapshot().lifecycle === "stopped" &&
        error instanceof BridgeError && error.message === "Session authority inactive") return;
      this.error = "Runtime stopped after an error. Inspect persisted task state; no automatic restart.";
    }).finally(() => { if (this.session === session) this.session = undefined; });
  }

  private async lifecycleMarker(kind: "pause" | "continue", expected: "paused" | "active"): Promise<void> {
    const session = this.session!;
    const path = resolve(sessionDirectory(this.root, this.policy.sessionId), `${kind}.json`);
    if (!await pathExists(path)) await atomicCreateJson(path, { version: 1, sessionId: this.policy.sessionId, policyHash: this.policyHash });
    // Same boundary as swarm:pause/continue. Direct supervisor calls can otherwise
    // pause between reading a queued submission and its serialized acceptance.
    const deadline = Date.now() + Math.max(30000, this.policy.limits.inferenceTimeoutMs + 5000);
    while (!this.closing && this.session === session && Date.now() < deadline) {
      if (!await pathExists(path) && session.snapshot().lifecycle === expected) return;
      if (!["active", "paused"].includes(session.snapshot().lifecycle)) break;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new BridgeError("Local lifecycle transition needs inspection");
  }

  private async stopOwned(): Promise<void> {
    if (this.session) {
      const path = resolve(sessionDirectory(this.root, this.policy.sessionId), "stop.json");
      if (!await pathExists(path)) await atomicCreateJson(path, { version: 1, sessionId: this.policy.sessionId, policyHash: this.policyHash });
    }
    await this.running; this.running = undefined; this.session = undefined;
  }

  async submit(value: unknown) {
    if (!(await this.view()).allowed.submit) throw new BridgeError("Start or resume this dashboard session before submitting");
    const session = this.session;
    if (!session || this.phase || this.closing) throw new BridgeError("Wait for the local lifecycle operation before submitting");
    return session.atOperatorBoundary(() => {
      if (this.phase || this.closing) throw new BridgeError("Local lifecycle operation in progress");
      return queueOperatorTask(this.root, this.policy.sessionId, validateOperatorTask(value));
    });
  }

  async close(): Promise<void> {
    this.closing = true; await this.operation; await this.stopOwned();
  }
}
