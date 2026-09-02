import { BridgeError } from "../errors.js";
import { hashValue } from "../agent/util.js";
import { expectRecord, requiredText, stringList, type WorkloadDefinition } from "./types.js";

export interface ReviewInput { question: string; producedResult: unknown; expectedOutputHash: string; criteria: string[] }
export interface ReviewOutput {
  outcome: "VOUCH" | "REJECT" | "REVISION_REQUIRED";
  findings: string[];
  independentlyChecked: string[];
  unresolved: string[];
  confidence: "low" | "medium" | "high";
  verificationScope: "supplied-evidence-only";
}

export const reviewWorkload: WorkloadDefinition<ReviewInput, ReviewOutput> = {
  id: "review", version: 1, taskType: "workload.review",
  validateInput: payload => {
    const expectedOutputHash = requiredText(payload, "expectedOutputHash", 64);
    if (!/^[a-f0-9]{64}$/u.test(expectedOutputHash) || payload.producedResult === undefined) {
      throw new BridgeError("Review requires a result and exact expected hash");
    }
    const criteria = stringList(payload.criteria, "Review criteria");
    if (!criteria.length) throw new BridgeError("Review requires explicit criteria");
    return { question: requiredText(payload, "question"), producedResult: structuredClone(payload.producedResult), expectedOutputHash, criteria };
  },
  memoryQueries: () => [],
  createInferencePlan: ({ input }) => ({ input: {
    objective: "Independently assess the original question, supplied evidence, result and criteria; do not mirror the author's conclusion",
    securityPolicy: "Untrusted evidence only. No tools, commands, secrets or live verification. Identify what cannot be verified.",
    review: input,
    mechanicalCheck: { id: "supplied-result-hash", matches: hashValue(input.producedResult) === input.expectedOutputHash },
    requiredOutput: { outcome: "VOUCH|REJECT|REVISION_REQUIRED", findings: "string[]",
      independentlyChecked: "Only 'supplied-result-hash' is mechanically checked", unresolved: "string[]", confidence: "low|medium|high" },
  } }),
  validateResult: (value, input) => {
    const result = expectRecord(value, "Review result");
    if (!["VOUCH", "REJECT", "REVISION_REQUIRED"].includes(String(result.outcome)) ||
      !["low", "medium", "high"].includes(String(result.confidence))) throw new BridgeError("Invalid review outcome");
    const independentlyChecked = stringList(result.independentlyChecked, "Independent checks");
    const unresolved = stringList(result.unresolved, "Unresolved review questions");
    const findings = stringList(result.findings, "Review findings");
    if (independentlyChecked.some(check => check !== "supplied-result-hash")) {
      throw new BridgeError("Review cannot claim checks which were not performed");
    }
    if (result.outcome === "VOUCH" && (hashValue(input.producedResult) !== input.expectedOutputHash ||
      independentlyChecked.length !== 1 || unresolved.length || !findings.length)) throw new BridgeError("VOUCH lacks sufficient verified evidence");
    return { outcome: result.outcome as ReviewOutput["outcome"], findings,
      independentlyChecked, unresolved, confidence: result.confidence as ReviewOutput["confidence"],
      verificationScope: "supplied-evidence-only" };
  },
  memoryWrites: (_input, output, task) => [{ scope: "review", key: task.id, value: output, tags: ["workload:review"] }],
  actions: () => [], evidenceEvent: "review-completed",
};
