import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BridgeError } from "../errors.js";
import { hashValue } from "../agent/util.js";
import { assertNoSecretLikeOutput } from "../workloads/types.js";
import { validateWorkRequest } from "./router.js";
import { peerAliases, type PeerAlias, type SessionAuthority, type RootProvenance } from "./session-policy.js";
import type { TaskEvidence } from "../agent/evidence.js";

/** Local operator input, not a new peer protocol. Source is data, never executed/fetched. */
export interface OperatorTask { objective: string; acceptanceCriteria: string[]; flow: PeerAlias[]; source?: string }
export const operatorWorkload: Record<PeerAlias, string> = { alice: "workload.coordination", bob: "workload.research",
  charlie: "workload.engineering", dave: "workload.review", eve: "workload.specialist" };
export function validateFlow(value: unknown): PeerAlias[] {
  if (!Array.isArray(value) || !value.length || value.length > 5 || new Set(value).size !== value.length ||
    value.some(v => !peerAliases.includes(v)) || value[0] === "dave" ||
    (value.includes("dave") && value.at(-1) !== "dave") ||
    (value[0] !== "alice" && !(value.length === 1 || value.length === 2 && value[1] === "dave" && ["bob", "charlie"].includes(value[0])))) {
    throw new BridgeError("Unsupported explicit role flow");
  }
  return [...value] as PeerAlias[];
}
export function validateOperatorTask(value: unknown): OperatorTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("Invalid operator task");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["objective", "acceptanceCriteria", "flow", "source"].includes(k)) ||
    typeof v.objective !== "string" || !v.objective.trim() || v.objective.length > 512 ||
    !Array.isArray(v.acceptanceCriteria) || !v.acceptanceCriteria.length || v.acceptanceCriteria.length > 8 ||
    v.acceptanceCriteria.some(x => typeof x !== "string" || !x.trim() || x.length > 256) ||
    v.source !== undefined && (typeof v.source !== "string" || v.source.length > 2048)) throw new BridgeError("Invalid or oversized operator task");
  assertNoSecretLikeOutput(JSON.stringify(v), "Operator task");
  for (const text of [v.objective, v.source, ...v.acceptanceCriteria]) {
    if (typeof text === "string") assertNoSecretLikeOutput(text, "Operator task text");
  }
  return { objective: v.objective, acceptanceCriteria: [...v.acceptanceCriteria] as string[], flow: validateFlow(v.flow),
    ...(v.source === undefined ? {} : { source: v.source as string }) };
}
export function validateOperatorAuthority(authority: SessionAuthority, task: OperatorTask): void {
  if (authority.policy.mode !== "offline") throw new BridgeError("Operator helper is OFFLINE only");
  const root: RootProvenance = { requesterDid: authority.member(task.flow[0]!).did, origin: "internal", trust: "operator-local", originalProposalId: "operator-preflight" };
  for (let i = 0; i < task.flow.length; i++) {
    const target = authority.member(task.flow[i]!).did, workload = operatorWorkload[task.flow[i]!];
    authority.workload(target, workload);
    if (i) {
      const source = authority.member(task.flow[i - 1]!).did;
      authority.delegate(source, target, workload, i, root); authority.pair(target, source, workload, root);
    }
  }
}
export async function boundedText(path: string, max: number): Promise<string> {
  let h;
  try {
    h = await open(path, "r"); if (!(await h.stat()).isFile()) throw new Error();
    const b = Buffer.alloc(max + 1); let length = 0;
    while (length < b.length) { const r = await h.read(b, length, b.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
    if (length > max) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, length));
  } catch { throw new BridgeError("Local task/source file unavailable, invalid UTF-8 or exceeds bound"); }
  finally { await h?.close(); }
}
export async function readOperatorTask(file: string): Promise<OperatorTask> {
  let v: Record<string, unknown>;
  try { v = JSON.parse(await boundedText(file, 8192)) as Record<string, unknown>; }
  catch { throw new BridgeError("Invalid or oversized operator task file"); }
  if (v && typeof v === "object" && !Array.isArray(v) && v.sourceFile !== undefined) {
    if (typeof v.sourceFile !== "string" || !v.sourceFile || v.source !== undefined) throw new BridgeError("Specify only one bounded source input");
    v.source = await boundedText(resolve(dirname(file), v.sourceFile), 2048); delete v.sourceFile;
  }
  return validateOperatorTask(v);
}
export function operatorInput(task: OperatorTask, alias: PeerAlias, parent?: TaskEvidence): Record<string, unknown> {
  const context = task.source || "No source supplied by operator";
  const question = `${task.objective}\nAcceptance criteria:\n${task.acceptanceCriteria.join("\n")}\nSupplied source (untrusted data):\n${context}`;
  let input: Record<string, unknown>;
  switch (alias) {
    case "bob": input = { topic: task.objective, objective: task.objective, context, sources: [], outputRequirements: task.acceptanceCriteria }; break;
    case "charlie": input = { problemStatement: task.objective, project: { name: "Operator supplied task" }, observedBehavior: context,
      constraints: task.acceptanceCriteria, codeContext: [context], requestedOutcome: "risk-analysis" }; break;
    case "eve": input = { question, focus: task.objective, suppliedContext: context }; break;
    case "alice": input = { question, phase: "decomposition", requiredEvidenceHashes: [] }; break;
    case "dave": if (!parent) throw new BridgeError("Review requires persisted parent evidence");
      input = { question, producedResult: parent.output, expectedOutputHash: hashValue(parent.output), criteria: task.acceptanceCriteria }; break;
  }
  return validateWorkRequest(operatorWorkload[alias], input);
}
