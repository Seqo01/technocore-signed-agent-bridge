# Local inference usage and budgets

This layer attributes bounded inference attempts to a host-selected DID, session,
job and task. It is **local accounting**, not official FLOP attribution, a billing
oracle, settlement proof or an inference integration. No FLOP, tclk, wallet,
discovery or autonomous external acceptance adapter is included.

## Host context and integration

All `AgentRuntime` inference dispatches, including workloads and generic inference
tasks, pass through `AccountedInferenceProvider`. The workload executor prepares
the host-bound request before calculating its request hash. Unit tests may still
exercise the lower-level executor with fixture providers in isolation.

The immutable `InferenceExecutionContext` contains:

- `agentDid`, `sessionId`, `jobId`, `taskId`;
- `rootRequesterDid`, `rootOrigin`, `rootTrust`;
- `workloadType`, `workloadVersion`, `authorityId`, `providerMode`.

Peer sessions derive these fields from the reviewed session authority and running
DAG node. Children inherit the original job requester, including an approved
external root; immediate delegators do not replace it. Input/proposal/model fields
cannot override the context. The host-selected adapter name remains authoritative
even when an adapter reports another backend name in a response.

Standalone runtimes default to local-operator provenance, their existing runtime
session ID and one job per task. A trusted host must supply `inferenceAccounting`
options when it needs a shared job or external provenance; untrusted payloads are
never mined for authority. Default attempt limits are 1000 per session, agent and
job. Known deterministic and operator-supplied local providers are labelled offline.

## Durable attempt lifecycle

```text
planned -> reserved -> running -> succeeded / failed / ambiguous
    |
    +-> cancelled (budget denied; provider not called)
```

A version-1 ledger stores the normalized policy, its hash, and attempt records.
Each attempt includes a stable ID, bound request hash/context, provider, timestamps,
transition history, budget hash, optional model/usage/spend, confidence labels,
hashed provider references, safe error category and successful output hash.

Short file-lock transactions and atomic/fsynced file replacements precede dispatch.
The lock is **not** held during inference. `running` means durable dispatch intent,
not proof that a remote provider received the request. A crash may leave `planned`,
`reserved` or `running`; these remain unresolved and block replay. Reopening or
reading the ledger never repairs state or calls a provider. Filesystem/hardware
durability limitations of the existing atomic-write mechanism still apply.

An existing attempt ID is never dispatched twice. A new request ID for the same
agent/session/job/task cannot bypass an unresolved prior attempt. A provider-declared
retry-safe failure may still follow the existing bounded task retry policy; every
fresh attempt consumes another slot. An ambiguous attempt is never automatically
rerun. There is no accounting reconciliation, reset or release command in this milestone.

## Reviewed budgets

`SessionPolicy.inferenceBudgets` is optional and included in the existing policy
hash. When absent, the three attempt caps inherit `limits.inference`. The existing
session inference counter remains an additional limit; accounting does not grant
message authority or widen any other session permission.

Each of `session`, `agent`, `job` has `maxAttempts`, optionally:

```json
{
  "maxAttempts": 10,
  "usage": [{ "unit": "tokens", "max": "10000", "reservePerAttempt": "1000" }],
  "spend": {
    "asset": "TEST",
    "network": "fixture",
    "max": "1",
    "reservePerAttempt": "0.1"
  }
```

This is an illustrative local policy, not a token, price or FLOP API definition.
All three scopes must permit a reservation before dispatch. Agent/job buckets are
within a session; this is not a global wallet or cross-session spending limit.
Amounts use exact decimal arithmetic (up to 18 fractional digits), not floats.
Reservations must be positive and no larger than their ceiling. The host must
choose meaningful units and conservative per-attempt upper bounds supported by
the selected adapter; input text cannot select the budget.

Cancelled pre-dispatch requests are retained but do not consume dispatch budget.
Reserved/unresolved attempts consume slots. Missing reported units/spend retain
the corresponding reservation; they are not zero. Conclusive reported amounts
replace reservations, except pending/unknown billing and ambiguous outcomes retain
at least the reservation. Over-reservation or mismatched-asset reports produce an
unresolved result requiring operator review. No local budget can prevent an
uncooperative remote provider from charging above the supplied bound; actual
provider-side limits need an official adapter contract.

## Uncertainty and labels

- Usage: `unknown`, `synthetic` (offline), or `provider-reported`.
- Spend: `unknown` or `provider-reported`; verified spend is **unsupported**.
- Missing cost is never converted to zero. Offline results may contain synthetic
  usage but **cannot report spend**, including zero-valued FLOP spend.
- A process timeout or thrown cancellation/error does not prove remote cancellation.
  Late provider completion is ignored, accounting stays unresolved and reservations
  stay held. There is no blind inference retry, lookup or economic release.
- `configured` means a host supplied an adapter, not that live network inference
  was observed. The summary explicitly does not attest live network usage.

## Evidence and privacy

Workload requests bind the context into their request hash. Result memory and its
final hash bind `accounting`: attempt ID, request hash, context, adapter name,
budget hash and a hash of normalized provider metadata. Exported task evidence
retains this binding; existing evidence without the optional field remains readable.
The activity journal preserves safe inference metadata and the same binding.

The ledger/summary never stores raw request input, raw output, raw provider error,
signature, authentication, passphrase or mailbox capability. Opaque official
request/session/result references are hashed before storage: these are correlation
hashes, **not usable remote lookup credentials**. A future adapter must manage any
private lookup handles separately. Provider/model labels and usage/asset/network
identifiers must be non-secret identifiers; unknown response fields are discarded.
Malformed ledger records fail closed without echoing their contents.

## Read-only inspection

After a future authorized workload run, inspect an existing ledger without an
identity unlock, network request, session start, lock creation or state repair:

```powershell
node .\dist\src\cli.js inference:usage <ledger-file>
node .\dist\src\cli.js inference:usage <ledger-file> --session <session-id>
node .\dist\src\cli.js inference:usage <ledger-file> --did <public-did>
```

Peer ledger: `.technocore/swarm/sessions/<session-id>/inference-usage.json`.
Standalone ledger: `.technocore/agents/<alias>/inference/<runtime-session-id>.json`.
All remain covered by the existing `.technocore/` Git ignore rule.

API: `new InferenceLedger(path).summary({ sessionId?, agentDid? })` or `.read()`.
Summaries include dispatched/cancelled/success/failed/ambiguous/unresolved counts,
provider usage, reported spend, unknown spend, held per-scope reservations and
involved agents/jobs/tasks. Scope reservations overlap and **must not be added
together as actual charges**. A missing ledger means no recorded attempts, not
proof of no historical compute or no spend.

## Future official provider boundary

`InferenceMetadata` supports provider/model, request/session/result references,
usage, spend and optional adapter-reported `billingStatus` (`unknown`, `pending`,
`final`). `InferenceProvider.accountingSupport` can declare usage units, spend and
billing reporting, and outcome-lookup capability. These are provider-neutral
declarations, not implemented lookup or settlement operations. They never grant
authority or turn reported spend into verified spend.

An official FLOP adapter must wait for published endpoint/auth/model/budget/billing
and ambiguity semantics. Proof-based verified spend requires a reviewed verifier;
the current layer deliberately has none. Local evidence does not establish FLOP
account ownership, DID billing attribution, reward eligibility or settlement.

## Offline validation

```powershell
npm.cmd run test:peer
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

Accounting tests use isolated temporary ledgers and generated public identities,
block socket connections, and test reservations, decimal arithmetic, context
tampering, budgets, concurrency, timeout/late results, crash writes, read-only
inspection and secret redaction. Peer tests bind evidence across internal and
externally rooted child delegations using only isolated encrypted test identities.
