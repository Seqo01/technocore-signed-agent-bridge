# External jobs and result delivery

An operator-approved external proposal can now produce a signed response from the
recipient peer directly to the requester. Alice is not a relay. The response uses
the supervisor's **existing completed result**, not another run through
`ExternalTaskRouter`. This is not discovery, a marketplace, autonomous acceptance
of unknown peers, or a FLOP provider integration.

## Lifecycle and ownership

1. The supervisor durably ingests and validates the proposal. External work stays
   `needs-operator`; an existing local requester contact is snapshotted as a
   contact ID and destination hash. No contact or reply URL is created from input.
2. Host code calls the existing `approveExternal(proposalRecordId, proposalHash,
   scope)` API with the exact bounded work scope. This authorizes compute only.
3. The supervisor executes the root task and any separately scoped DAG children.
   Their runtime tasks, memory, journal evidence and inference ledger are durable.
4. After the job completes, the host cleanly stops the session. The one-shot
   `ExternalJobDelivery` service selects a completed result belonging to the
   original recipient, prepares its response, and requests separate exact
   outbound authorization. It never starts or resumes a runtime.
5. The operator reviews the response metadata and authorizes its exact action
   hash. Only an explicit send operation unlocks the responding identity and
   calls the existing signed bridge. The requester receives one result envelope.

Compute retains the existing `accepted/running/result-ready/failed/ambiguous`
states. Response state is separately persisted as `response-prepared`,
`response-authorized`, `sending`, `sent`, `failed` or `delivery-ambiguous`.
Inspection labels a persisted `sending` intent ambiguous without modifying it.
`sent` means a matching server POST receipt plus local approval confirmation,
**not** acknowledgment that the external requester read or accepted the result.

## Durable linkage and evidence

Session `proposals` bind the original proposal, requester/recipient DIDs, job,
work scope and intake-time contact reference. New records live under the ignored
session directory:

```text
swarm/sessions/<session>/
  external-deliveries/<effect-id>.json
  external-response-approvals/<alias>/<action-id>.json
```

The version-1 `external-result` envelope contains `proposalId`, `jobId`, `taskId`,
`rootTaskId`, requester/responder DIDs, workload type/version, root provenance and
work-authority hashes, result hash/reference, evidence hash, dependency evidence
references, inference attempt/request hashes, structured output, completion
status and the persisted task completion time. It is canonical sanitized JSON,
bounded by the smaller of 4096 UTF-8 bytes and the reviewed payload limit.
Oversized or secret-like output is rejected; it is not silently truncated or
uploaded elsewhere. Raw journals, provider data, signatures and capabilities are
not included. Sensitive semantics that evade pattern checks still require human
review before authorization.

`readCompletedTaskEvidence` validates the task/memory result hash and evidence
without unlocking, repairing the journal or invoking inference. Delivery also
checks the corresponding successful inference ledger entries against the local
DID, session, job, task, external root requester/trust and authority. These are
local consistency/attribution records, not correctness or official FLOP proofs.

For External X -> Bob -> Dave -> Bob -> X, the final Bob node must descend from
the original Bob root. Its dependency closure references Dave's existing
evidence and the same external root. No Alice task is needed. Work scope does
not expand when a child or final response is prepared.

## Exact response authority and delivery

The effect ID is deterministic for the session, policy and external proposal
record. Its action ID binds the selected task/result. Existing `ActionApprovalStore`
records bind sender DID/alias, destination hash, payload hash and action ID.
Requester DID and proposal/job/task are bound through the exact payload.
Re-preparation returns the same effect; a different selected result is rejected.
An executing, confirmed, failed or ambiguous action cannot be approved again.

The frozen stopped-session hash, scope, completed evidence, current identity,
contact and payload are revalidated before nonce reservation and before dispatch.
The dispatch also requires the exact approval to be executing. A changed contact
or missing intake-time contact fails closed. Inspection/preparation/authorization
do not decrypt the identity. Send uses the hidden passphrase provider and existing
`SignedAgentBridge`, persistent DID/room nonce store and `node:https` POST lane.

The shared session outbound limit includes internal effects plus external send
intents. An intent is persisted before network dispatch; a crash there is
conservatively spent even if no request reached the server. There are no GETs,
POST retries (including 429 retries), background sends or automatic authority
grants. Offline tests inject transport and use session-local simulated nonces;
configured delivery uses the original DID/room nonce state.

Timeout, 5xx, reset, malformed receipt or local confirmation uncertainty leave
delivery ambiguous while the completed computation remains intact. Explicit
4xx refusal is failed, never permission to resend. Restart inspection and
`observeRetained(effectId, roomResponse)` use existing local evidence only.
`not-observed` does not prove non-commit; even a positive observation does not
automatically promote delivery or grant resend authority. No reconciliation GET
or retry/recovery-send command is added here.

## Operator commands and API

Build first. These are syntax examples with placeholders, **not instructions to
start a live session or send without reviewing the exact effect**:

```powershell
node .\dist\src\cli.js external:jobs <session-id>
node .\dist\src\cli.js external:response-prepare <session-id> <proposal-record-id> <result-node-id>
node .\dist\src\cli.js external:response-status <session-id> <effect-id>
node .\dist\src\cli.js external:response-authorize <session-id> <effect-id> <action-hash>
node .\dist\src\cli.js external:response-send <session-id> <effect-id> <action-hash>
```

`external:jobs` lists proposal/work approval states, result-node IDs and result
hashes. Status shows safe linkage, exact action/payload/destination hashes and
delivery outcome, not a mailbox URL or raw structured result. An operator must
review the selected local task output as well as these hashes before granting
outbound authority. The corresponding host methods are `jobs`, `prepare`,
`inspect`, `authorize`, `send` and retained-data-only `observeRetained`.

No npm command aliases or dependencies were added. Existing host APIs handle
external work approval and bounded delegation. The CLI still cannot start a
configured session with a real inference provider: that needs a reviewed host
adapter. CLI send refuses offline sessions rather than substituting a live
transport for their fixture. Tests call the host API with an injected fixture.

## Current boundaries before live use

- A completed job in a cleanly stopped session is required; halted sessions are
  not recovered or resumed by this service. The original policy must remain
  unexpired and have enough remaining POST budget.
- The verified requester contact must already exist at intake and remain
  unchanged. Old proposal records without that binding stay needs-operator;
  this implementation does not migrate historical or operational state.
- One selected response per proposal/session. There is no cross-session global
  deduplication registry, automatic reapproval, fresh-send recovery or chunking.
- A counterpart must understand `external-result/v1`. Output and evidence
  references are bounded; local memory references are not remote download URLs.
- Configured inference/provider review, contact verification, output review and
  separate exact outbound authorization are prerequisites to any live test.

## Offline verification

```powershell
npm.cmd run test:peer
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

Tests generate temporary encrypted identities, forbid socket connections and
inject all transport outcomes. They compare ledger/checkpoint/identity bytes
before and after reply preparation, restart, successful delivery and ambiguous
failure. Delivery cannot invoke an inference provider or workload executor.
