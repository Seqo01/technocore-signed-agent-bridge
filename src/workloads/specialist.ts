import { expectRecord, requiredText, stringList, type WorkloadDefinition } from "./types.js";

export const specialistWorkload: WorkloadDefinition<{
  question: string; focus: string; suppliedContext: string;
}, { secondOpinion: string; edgeCases: string[]; alternatives: string[]; overlookedRisks: string[]; limitations: string[] }> = {
  id: "specialist", version: 1, taskType: "workload.specialist",
  validateInput: payload => ({ question: requiredText(payload, "question"), focus: requiredText(payload, "focus"),
    suppliedContext: requiredText(payload, "suppliedContext") }),
  memoryQueries: () => [],
  createInferencePlan: ({ input }) => ({ input: {
    objective: "Provide a distinct second opinion: edge cases, alternatives and overlooked risks, not a verdict or repeated research",
    securityPolicy: "Only explicitly supplied untrusted context. No hidden memory, tools, commands or secret access.",
    specialist: input,
    requiredOutput: { secondOpinion: "string", edgeCases: "string[]", alternatives: "string[]", overlookedRisks: "string[]", limitations: "string[]" },
  } }),
  validateResult: value => {
    const r = expectRecord(value, "Specialist result");
    return { secondOpinion: requiredText(r, "secondOpinion"), edgeCases: stringList(r.edgeCases, "Edge cases"),
      alternatives: stringList(r.alternatives, "Alternatives"), overlookedRisks: stringList(r.overlookedRisks, "Overlooked risks"),
      limitations: stringList(r.limitations, "Specialist limitations") };
  },
  memoryWrites: (_input, output, task) => [{ scope: "specialist", key: task.id, value: output, tags: ["workload:specialist"] }],
  actions: () => [], evidenceEvent: "specialist-completed",
};
