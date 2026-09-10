import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { AgentStateStore } from "../agent/state-store.js";
import { ActivityJournal } from "../agent/journal.js";
import { LocalMemoryProvider } from "../agent/memory.js";
import { readCompletedTaskEvidence } from "../agent/evidence.js";
import { InferenceLedger } from "../agent/inference-accounting.js";
import { agentPaths } from "../agent/paths.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { BridgeError } from "../errors.js";
import { SessionStateStore, sessionDirectory, classifyInterruptedSession } from "./session-state.js";
import type { TaskEvidence } from "../agent/evidence.js";
import { readJsonFile, pathExists } from "../fs-safe.js";
interface TaskView { taskId: string; jobId: string; agent: string; compute: string; delivery: string; createdAt: string;
  runtimeStatus?: string; updatedAt?: string; startedAt?: string; finishedAt?: string; result?: unknown; provenance?: TaskEvidence; reviewOutcome?: unknown;
  reviewReasons?: unknown; unresolved?: unknown; failureCode?: string }

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** Read-only projection. Never unlocks, repairs, executes or prints a raw effect/state. */
export async function operatorView(root: string, id: string, jobId?: string) {
  const stored = await SessionStateStore.read(root, id);
  const live = processAlive(stored.pid) && ["starting", "active", "paused", "stopping"].includes(stored.lifecycle);
  const session = live ? stored : classifyInterruptedSession(stored);
  if (jobId && !session.jobs[jobId]) throw new BridgeError("Unknown session job");
  const directory = sessionDirectory(root, id);
  const submissions: { submissionId: string; status: string; taskId?: string }[] = [];
  let names: string[] = [];
  try { names = await readdir(resolve(directory, "submissions")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new BridgeError("Submission status unavailable"); }
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/u.test(n)).sort().slice(0, session.policy.limits.tasks)) {
    const marker = await readJsonFile<{ status: string; taskId?: string } | null>(resolve(directory, "submission-results", name), null);
    submissions.push({ submissionId: name.slice(0, -5), status: marker?.status === "accepted" ? "accepted" : marker ? "rejected" : "queued",
      ...(marker?.taskId && /^[a-f0-9]{64}$/u.test(marker.taskId) ? { taskId: marker.taskId } : {}) });
  }
  const tasks: TaskView[] = [];
  const unavailable = new Set<string>();
  const recent: { timestamp: string; agent: string; taskId?: string; event: string; outcome: string }[] = [];
  for (const member of session.policy.members) {
    const paths = agentPaths(directory, member.alias), state = new AgentStateStore(paths.state);
    const journal = new ActivityJournal(paths.journal), memory = new LocalMemoryProvider(paths.memory);
    if (!await pathExists(paths.state)) { unavailable.add(member.alias); continue; }
    const relevant = Object.values(session.tasks).filter(t => t.alias === member.alias && (!jobId || t.jobId === jobId));
    const runtime = await state.load();
    for (const node of relevant) {
      const task = runtime.tasks[node.runtimeTaskId ?? ""];
      const checked = node.compute === "result-ready" && task?.status === "succeeded" ?
        await readCompletedTaskEvidence({ state, journal, memory }, member.alias, member.did, task.id) : undefined;
      const evidence = checked?.evidence;
      const output = evidence?.output as Record<string, unknown> | undefined;
      tasks.push({ taskId: node.id, jobId: node.jobId, agent: member.alias, compute: node.compute, delivery: node.delivery,
        createdAt: node.createdAt, ...(task ? { runtimeStatus: task.status, updatedAt: task.updatedAt,
          ...(task.startedAt ? { startedAt: task.startedAt } : {}), ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}) } : {}),
        ...(jobId && evidence ? { result: evidence.output, provenance: evidence } : {}),
        ...(node.workload === "workload.review" && output ? { reviewOutcome: output.outcome, reviewReasons: output.findings, unresolved: output.unresolved } : {}),
        ...(task?.error ? { failureCode: task.error.code } : {}) });
    }
    for (const entry of (await journal.read()).filter(e => !jobId || relevant.some(t => t.runtimeTaskId === e.taskId)).slice(-10)) {
      recent.push({ timestamp: entry.timestamp, agent: member.alias, ...(entry.taskId ? { taskId: entry.taskId } : {}), event: entry.event, outcome: entry.outcome });
    }
  }
  const ledger = await new InferenceLedger(resolve(directory, "inference-usage.json")).summary({ sessionId: id });
  const result = { sessionId: id, mode: session.policy.mode, testingOnly: session.policy.mode === "offline",
    lifecycle: session.lifecycle, state: session.lifecycle === "active" ? "RUNNING" : session.lifecycle.toUpperCase(),
    createdAt: session.createdAt, updatedAt: session.updatedAt, expiresAt: session.policy.expiresAt,
    ...(session.reason ? { reason: session.reason } : {}),
    jobs: Object.values(session.jobs).filter(j => !jobId || j.id === jobId).map(j => ({ jobId: j.id, status: j.status,
      roleFlow: j.operator?.flow ?? j.tasks.map(t => session.tasks[t]!.alias), ...(j.blockedReason ? { blockedReason: j.blockedReason } : {}) })),
    submissions, tasks, agents: session.policy.members.map(m => ({ alias: m.alias, state: unavailable.has(m.alias) ? "not-loaded" : !live || session.lifecycle !== "active" ? session.lifecycle : tasks.some(t => t.agent === m.alias && t.compute === "running") ? "running" : tasks.some(t => t.agent === m.alias && (t.compute === "ambiguous" || t.delivery === "needs-operator")) ? "blocked" : "idle",
      currentTasks: tasks.filter(t => t.agent === m.alias && t.compute === "running").map(t => t.taskId) })),
    counts: { queuedSubmissions: submissions.filter(s => s.status === "queued").length,
      queued: tasks.filter(t => ["planned", "accepted"].includes(t.compute) && t.delivery !== "needs-operator" && session.jobs[t.jobId]?.status !== "needs-operator").length,
      completed: tasks.filter(t => t.compute === "result-ready").length, failed: tasks.filter(t => t.compute === "failed").length,
      ambiguous: tasks.filter(t => t.compute === "ambiguous" || t.delivery === "needs-operator").length,
      revisionRequired: tasks.filter(t => t.reviewOutcome === "REVISION_REQUIRED").length,
      externalJobs: Object.values(session.jobs).filter(j => j.root.origin === "external").length },
    inference: { scope: "session", attempts: ledger.attempts, successes: ledger.successes, failures: ledger.failures,
      ambiguous: ledger.ambiguous, offlineAttempts: ledger.offlineAttempts, usefulInferenceSpend: "not-claimed" },
    recentActivity: recent.sort((a,b) => a.timestamp.localeCompare(b.timestamp)).slice(-20) };
  assertNoSecretLikeOutput(JSON.stringify(result), "Operator view"); return result;
}
