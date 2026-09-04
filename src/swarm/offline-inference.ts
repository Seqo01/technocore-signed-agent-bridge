import { DeterministicInferenceProvider } from "../agent/inference.js";

/** Deliberately synthetic, no source fetching and no claim of live research. */
export function offlinePeerInference(): DeterministicInferenceProvider {
  return new DeterministicInferenceProvider(request => {
    const plan = (request.input as { plan: Record<string, any> }).plan;
    const limitation = "Deterministic offline analysis of supplied evidence only; no live observation";
    let output: unknown;
    switch (request.taskType) {
      case "workload.research": output = { answer: "Supplied evidence requires independent verification", keyClaims: [],
        confidence: { level: "low", rationale: limitation }, limitations: [limitation], suggestedFollowUp: ["Request peer review"] }; break;
      case "workload.engineering": output = { findings: [limitation], likelyCauses: [], proposedTests: ["Use isolated fixtures"],
        proposedChange: "Retain explicit evidence", risks: ["Unverified assumptions"], unresolvedQuestions: ["Live behavior unknown"], recommendation: "Review before acting" }; break;
      case "workload.review": output = { outcome: "REVISION_REQUIRED", findings: [limitation],
        independentlyChecked: plan.mechanicalCheck.matches ? ["supplied-result-hash"] : [], unresolved: ["Live verification outside scope"], confidence: "low" }; break;
      case "workload.specialist": output = { secondOpinion: limitation, edgeCases: ["Ambiguous delivery"], alternatives: ["Retain evidence"],
        overlookedRisks: ["Privilege laundering"], limitations: [limitation] }; break;
      case "workload.coordination": case "workload.synthesis": output = { summary: limitation, steps: ["Evaluate supplied evidence"],
        evidenceHashes: plan.coordination.requiredEvidenceHashes, limitations: [limitation] }; break;
      default: return { outcome: "failure", retrySafe: false, errorCode: "UNSUPPORTED_OFFLINE_WORKLOAD", metadata: { provider: "deterministic-local", model: "peer-fixture-v1" } };
    }
    return { outcome: "success", output, metadata: { provider: "deterministic-local", model: "peer-fixture-v1", latencyMs: 0, usage: { requests: "1" } } };
  });
}
