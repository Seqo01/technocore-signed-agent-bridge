# Local swarm and external collaboration

One runtime implementation serves independently encrypted identities and profiles. A local
team is an operator-configured set of alias **and expected DID** bindings, not a fixed list
of five identities. No real DIDs, profiles, wallets or operational data belong in this repo.

## Roles

| Role | Normal workloads |
| --- | --- |
| coordinator | coordination (decomposition/synthesis), collaboration intake |
| researcher | research, collaboration intake |
| engineer | engineering, collaboration intake |
| reviewer | independent review, collaboration intake |
| specialist | second opinion/edge cases/alternatives, collaboration intake |

All roles may propose outbound contact/public messages, but **no role authorizes a send**.
Unknown or role-inappropriate work fails at execution, even when inserted directly into
the state queue. Existing profiles without role metadata retain the legacy workload set;
the swarm and external routers require an explicitly bound role.

After ordinary encrypted identity creation and `agent:init`, a stopped profile can be
configured locally without unlocking or rewriting its identity:

```text
node dist/src/cli.js agent:role <alias> <role> <expected-did>
```

The role is stored in `.technocore/agents/<alias>/role.json`, not in the identity container.
Conflicting role changes fail rather than silently rewriting policy. This release provides
library orchestration APIs and offline integration tests, not a background swarm daemon.

## Delegation and selected evidence

`LocalSwarmRouter` is a trusted local host coordinator over explicitly supplied runtime
endpoints. It accepts source/target bindings, a source parent task, a stable delegation key,
an allowlisted workload and bounded, validated payload. It records intent in the source
agent's `delegations/<id>.json` **before** dispatching an idempotent target task. Reconcile
can repeat dispatch after a crash without repeating completed work.

Targets execute their own tasks and use their own memory, journal and runtime lock. The
router never opens a target memory directory. A completed workload exports only its selected
validated output, agent/task identity and inference/result/memory hashes through
`exportTaskEvidence`. Raw memory stores, identity containers and capabilities are not exports.
Evidence snapshots are integrity checked; their hashes are not independent proof of truth.

Delegated tasks use `context: { mode: "explicit-only", evidence: [...] }`. The executor skips
implicit memory retrieval in this mode. A coordinator can collect selected results and
enqueue `workload.coordination` with `phase: "synthesis"`; every required result hash must
have an explicit snapshot, and the output must reference that exact set. It must not turn
another agent's conclusion into a verified fact.

Review receives the original question, produced result, expected output hash and criteria.
It recomputes the supplied-result hash and permits `VOUCH`, `REJECT` or `REVISION_REQUIRED`.
A VOUCH requires a matching hash, findings and no unresolved review questions. The only
mechanically performed check in this version is `supplied-result-hash`; claims of other
checks are rejected. `verificationScope` is always `supplied-evidence-only`, never a claim
of live service verification. Specialist output is separate: second opinion, edge cases,
alternative approaches and overlooked risks; it does not issue a review verdict.

## Mandatory outbound approvals (breaking safety change)

All bridge signing methods, CLI sends, runtime send tasks and collaboration responses now
reach `SignedAgentBridge.sendSigned`. Before **any nonce reservation or network write**, it
atomically consumes one durable approval. Production has no auto-approve provider.

The approval binds an action ID, local alias/DID, action type, destination hash (including
contact identity) and hash of the canonical sanitized message. The nonce is allocated only
after approval. A textual change that canonicalizes to identical wire text is the same
effect; a different canonical payload or destination fails. A task's action ID is derived
from its own DID/task ID/type, never a peer-provided `approved` flag or approval ID.

```text
requested -> approved -> executing -> confirmed | ambiguous | failed
```

Executing and terminal approvals are spent. Concurrent consumption uses the existing
process-aware runtime lock, not age-only lock stealing. A crash during guard-file creation
can require operator inspection of that local guard; do not delete locks of live processes.
An executing record after restart requires reconciliation, not a resend. Explicit 429
retries remain bounded inside one approved transport operation with the identical signed
envelope. Timeouts/5xx/unknown outcomes still consume the nonce and never retry blindly.

For runtime tasks the host calls `requestOutboundApproval(taskId)`, reviews the exact task
and destination, then explicitly calls `approveOutboundTask(taskId, actionHash)`. Unapproved
tasks enter `awaiting-approval`; they do not repeatedly execute while waiting. Repeating the
operator's approval after a crash between grant and resume only resumes the same unspent
action. Workloads and inference providers receive neither approval-store nor runtime APIs.

Existing CLI sends **no longer send without prior approval**. Preparation and approval
are local, public-metadata-only operations; they never unlock an identity or contact a server:

```text
node dist/src/cli.js action:prepare-contact <sender> <contact-id> <text>
node dist/src/cli.js action:prepare-public <sender> <public-room> <text>
node dist/src/cli.js action:approve <sender> <action-id> <action-hash>
```

Review your supplied text and intended contact/room alongside the returned hashes. Grant
only an action you prepared and reviewed; a hash by itself is not a human-readable summary.
The eventual send uses the same inputs plus `--action <action-id>`. It still requires hidden
identity unlock and an explicitly configured live URL. Do not run live sends as part of setup.

Approval records and journals contain hashes/public metadata, never raw message bodies,
capabilities, keys or signatures. Task payloads remain private local operational data.

## External peers

`ExternalTaskRouter` uses existing inbox peek/persist/journal/ack ordering. Received data
must have transport-verified DID metadata. The JSON body's `from` must equal that DID:

```text
{version:1, id:<stable-peer-message-id>, from:<peer-did>,
 workload:<allowlisted-workload-type>, payload:<validated-workload-input>}
```

External peers remain DID/contact references; the router never creates local identities or
profiles. Peer IDs cannot stand in for local alias/DID bindings. Replay identity is scoped
by local DID, peer DID and stable peer message ID, not only a room sequence. Conflicting
replays are rejected without overwriting approved work. A retention gap or reset room epoch
stops intake for operator reconciliation rather than silently accepting an incomplete stream.

The router persists a proposal after schema, identity, role and scope checks. Work approval
(`approve(proposalId, requestHash)`) is separate from outbound approval. `dispatch` creates
only validated role-appropriate work with explicit-only context. A completed result can
create a structured response proposal to an operator-managed contact; it cannot send it.
`proposeOutbound` similarly prepares a contact task for an external request, subject to the
same execution gate. A known contact remains untrusted, not automatically authorized.

Unknown fields/action types, identity/policy mutation requests and known instruction-attack
phrases are refused. This conservative phrase filter is not a complete prompt-injection
detector. The security boundary is the allowlisted schema, no tools/shell, isolated selected
context and explicit operator approval. Collaboration memory lookup is scoped to the same
peer; delegated/external tasks do not implicitly retrieve earlier private conversations.

## Recovery, limits and tests

Completed tasks retain evidence hashes in state, allowing a missing final journal append to
be repaired from validated local results without repeating inference. Uncertain inference
or signed effects remain quarantined. Delegation records track parent/source/target/workload,
status, exact request hash, result hash and review outcome.

Run `npm test`, `npm run typecheck`, and `npm run build`. The swarm E2E uses five generated
temporary encrypted identities and distinct deterministic role outputs, plus a sixth peer
key held only in memory. It performs no real network, wallet, faucet, FLOP or tclk activity.
Transport sockets are forbidden in the swarm E2E. Existing transport tests use injected fakes.

Isolation is an application/data-routing boundary, **not an OS sandbox**. Trusted host code
can access local files and low-level cryptographic/transport APIs; anyone controlling that
process/account can defeat local policy. Do not expose host APIs, approval methods or the
filesystem to an inference provider. Local durable stores grow without automatic quotas in
this version. Verified transport metadata trusts the configured Technocore service; an
independently verifiable exported signature transcript is not implemented here.

No commerce action is registered. Future settlement requires its own exact-effect approval
boundary and official API documentation; no FLOP/wallet formats or identity-to-claim mapping
are assumed. Operational `.technocore/` files must stay ignored and untracked.
