import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
} from "./types.js";

export type DeterministicInferenceHandler = (
  request: InferenceRequest,
  callIndex: number,
) => InferenceResult | Promise<InferenceResult>;

export class DeterministicInferenceProvider implements InferenceProvider {
  readonly name = "deterministic-local";
  readonly requests: InferenceRequest[] = [];

  constructor(private readonly handler: DeterministicInferenceHandler = (request) => ({
    outcome: "success",
    output: { taskId: request.taskId, input: request.input },
    metadata: {
      provider: "deterministic-local",
      model: "fixture-v1",
      latencyMs: 0,
      usage: { requests: "1" },
    },
  })) {}

  async infer(request: InferenceRequest): Promise<InferenceResult> {
    const copy = structuredClone(request);
    this.requests.push(copy);
    return this.handler(copy, this.requests.length - 1);
  }
}
