# Workload layer

The workload layer adds bounded domain behavior without moving Research, Engineering or Collaboration policy into `AgentRuntime`. It is deliberately static: no dynamic imports, user-selected code paths, runtime evaluation, shell execution or repository mutation are supported.

```text
durable AgentTask
  -> explicit WorkloadRegistry
  -> input validation + relevant MemoryProvider reads
  -> structured InferenceRequest
  -> output and action-policy validation
  -> idempotent durable memory writes
  -> hash-only activity evidence
  -> completed AgentTask
```

## Contract

Every workload declares a stable ID and version, one accepted task type, input validation, memory queries, an inference plan, result validation, optional durable memory writes, optional structured actions and one journal event name. `WorkloadExecutor` supplies the common inference, hashing and persistence behavior. Unknown task types fail closed.

Inference requests carry a deterministic request ID plus the task type, workload ID/version, validated input and bounded relevant memory. Provider, model, provider session/result IDs, latency, usage and spend remain generic `InferenceMetadata`; there are no FLOP-specific placeholders or invented network values.

Successful execution persists a primary `workload-result` record and workload-specific memory. Journal entries contain the request ID, request/result hashes, memory-write hashes and final result hash, not raw prompts or responses.

## Workloads

### Research

`workload.research` accepts a topic, objective, optional context, bounded source metadata and output requirements. It uses supplied material and local memory only. The result must contain an answer, key claims, confidence with rationale, limitations and suggested follow-up.

### Engineering

`workload.engineering` accepts a problem statement, bounded project metadata, observed behavior, constraints, optional code snippets and one supported analysis objective. It returns findings, ranked causes, proposed tests/change, risks, unresolved questions and a recommendation. It has no mechanism to execute a command or change a repository.

### Collaboration

`workload.collaboration` accepts an identified peer message only after it has been persisted with the `untrusted-external-data` marker. The location is a public room name or a SHA-256 private-room reference—never the private capability. The workload classifies the request, applies explicit no-execution/no-secret-disclosure policy and produces a reviewed proposed response.

An optional `send-response` value is data, not an executed action. It is normalized to a structured action with `requiresApproval: true`; `WorkloadExecutor` never calls Technocore.

## Security and recovery

- Agent identity unlock, DID binding, nonce management and signed transport remain unchanged.
- Inference failure is retried only when the provider explicitly marks it safe and the task's existing retry bound allows it. Ambiguous inference is not retried blindly.
- Inbox ingestion writes the collaboration task and its journal record before advancing the cursor.
- Workload output is rejected if it contains recognizable private-key, capability, bearer-token or common secret-token material.
- Memory writes use task-derived idempotency keys, so repeating a safe local persistence step cannot create conflicting duplicate records.
- Core tests are deterministic and offline. The three-session scenario uses temporary encrypted identities and an in-memory Technocore transport.

Future live research, FLOP inference/memory and action execution belong behind their existing provider or host-policy boundaries and must wait for authoritative API and security documentation.
