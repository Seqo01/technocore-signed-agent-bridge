# Bounded peer-to-peer agent sessions

This is a local session supervisor, not a sixth agent and not an Alice-centered
pipeline. It owns five independently addressable runtimes, reusing their existing
encrypted identities and local role bindings:

| Peer | Execution capability |
| --- | --- |
| Alice | decomposition, coordination, synthesis |
| Bob | research, evidence analysis, synthesis |
| Charlie | engineering analysis and implementation planning |
| Dave | supplied-evidence review: VOUCH / REJECT / REVISION_REQUIRED |
| Eve | specialist analysis and second opinions |

Workloads produce structured data, not executable commands. Dave's mechanical
verification is limited to the supplied result hash; deterministic fixtures are
never live verification. No model receives signing, approval, shell, policy,
identity, nonce, cursor, wallet or commerce APIs.

## Standalone offline operator workflow

This is a normal Node application: build it, close Codex, and use two ordinary
PowerShell terminals. Codex is not a runtime dependency. There is no model install,
API credential, browser, cloud service, dashboard, or network requirement.
**Deterministic inference is testing only.** It exercises persistence and review
routing; it does not meaningfully analyze your source or earn inference spend.
The fixture reviewer reports `REVISION_REQUIRED`, not fabricated verification.

Prerequisites are the five existing encrypted identity/role/mailbox bindings.
Only selected roles perform tasks. The existing supervisor loads/unlocks all five
runtimes; enter each passphrase only in its hidden local terminal prompt.
For a multi-role flow, both directional contacts for each adjacent pair must
already exist and match the existing mailboxes. Policy preparation fails if a
contact is missing; it never creates contacts, trust, mailboxes or identities.
No full mesh is needed. A single-role flow needs no pair contacts.

First build, then create an **offline-only** bounded policy from those existing
bindings. Inspect the local policy before starting. The start command computes
the policy hash unless an explicit `--policy-hash` is supplied.

```powershell
npm.cmd run build
node .\dist\src\cli.js swarm:policy .\.technocore\offline-policy.json --session offline-product-smoke --flow bob,dave
node .\dist\src\cli.js swarm:start --offline --policy .\.technocore\offline-policy.json
```

`swarm:policy` atomically creates (never overwrites) the file. Its policy grants
only the selected flow's workloads and adjacent directional pairs, with 32 task,
inference, simulated-send and simulated-read limits, serial operation, and a
23-hour expiry. No intake polling is enabled. Nothing is sent to Technocore.
The original expiry/budgets are **not renewed** by resume. Expired sessions
remain readable but cannot resume in this milestone.

In the second terminal create `.technocore/operator-task.json` with your own
objective, criteria and optional local source. Example file structure:

```json
{
  "objective": "Identify guarantees and limitations in the supplied naming validator",
  "sourceFile": "source-excerpt.txt",
  "acceptanceCriteria": [
    "Reference the supplied source lines for every claim",
    "Distinguish explicit checks from behavior not established by this excerpt"
  ],
  "flow": ["bob", "dave"]
}
```

`sourceFile` is resolved relative to the task file, read once and snapshotted;
later edits do not change the queued task. Alternatively use inline `source`,
but not both. Only UTF-8 regular files are accepted; no URL fetching, shell/code
execution, source instructions, or automatic task generation occurs. Bounds:
task JSON 8192 bytes; source file 2048 bytes; inline source 2048 characters;
objective 512 characters; 1–8 criteria of at most 256 characters each. The
combined task and generated peer envelope must also fit the existing session
payload limit (4096 bytes); these are not independently additive allowances.
Secret-like input is rejected without printing it. Oversized downstream review
input is blocked explicitly; no new inference or delivery is invented.

Supported role flows: `bob`, `bob,dave`, `charlie`, `charlie,dave`, `eve`, or
`alice` followed by explicitly selected distinct roles. Dave, when selected,
must be last. Alice-led flows are an explicit sequential chain, not AI routing.
For example `alice,bob,eve` runs only those three roles. No role repeats in v1.
The chosen policy must permit the entire flow before submission is accepted.

```powershell
$submitted = node .\dist\src\cli.js swarm:task .\.technocore\operator-task.json --session offline-product-smoke | ConvertFrom-Json
node .\dist\src\cli.js swarm:status offline-product-smoke
node .\dist\src\cli.js swarm:result offline-product-smoke $submitted.jobId
```

The result command is available after the running process accepts the submission;
status shows queued/accepted/rejected submission receipts. Repeating identical
input in the same session is idempotent: it does not create another job. Operator
flows use the existing `submit/delegate` DAG, memory, evidence and accounting.
Dave receives the actual persisted parent output/hash, the same fixed source,
and the operator's acceptance criteria. Review completion is distinct from VOUCH.

Result inspection reports persisted task/job IDs, flow, statuses, results,
review findings, timestamps, and evidence/accounting references. Status derives
agent/current-task views, queued/completed/failed/ambiguous/revision counts,
external job counts and recent journal activity from existing records. Inference
totals are explicitly **session-scoped**, even when viewing one job. No uptime
across restarts or useful/FLOP spend is claimed. These views never unlock keys.

```powershell
node .\dist\src\cli.js swarm:pause offline-product-smoke
node .\dist\src\cli.js swarm:status offline-product-smoke
node .\dist\src\cli.js swarm:continue offline-product-smoke
node .\dist\src\cli.js swarm:stop offline-product-smoke
```

Pause is requested asynchronously. Wait for status `PAUSED`: the current bounded
operation reaches its checkpoint, but no new queued work starts. Submissions may
queue while paused. Continue resumes that same running process. Stop works while
running or paused and releases the runtimes. It does not fabricate cancellation.
After the first terminal exits, explicitly reopen there (interactive unlock):

```powershell
node .\dist\src\cli.js swarm:resume offline-product-smoke
```

Completed results and the original session/history survive. Failed/cancelled
tasks are not retried; interrupted/ambiguous work is blocked. Never-started queued
compute may continue. A second concurrent resume is refused; stop/reopen cycles
do not repeat computation/accounting. An unfinished root-intake checkpoint is
blocked rather than re-enqueued with guessed intent.

Offline messages were in memory, not durable network receipts. Unreceived effects
become explicitly blocked/ambiguous after restart. New delivery into a room whose
earlier mock history was lost is also blocked; durable cursors are not reset.
For example, pause/stop immediately after Bob's local result but **before any
mock send** permits Dave's queued flow to continue on reopen. Stopping midway
through simulated delivery may instead require operator attention. The finished
job remains inspectable in either case. No live session resume or automatic
reconciliation is added.

Offline regression checks:

```powershell
npm.cmd run test:peer
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

All test identities/state are temporary; tests prohibit live sockets. No real
identity, contact, historical rehearsal or discovery data is test input.

## Architecture and lifecycle

```text
reviewed local policy + existing five identity/profile bindings
                    |
             SessionSupervisor (no DID)
          /      /      |      \      \
        Alice   Bob   Charlie  Dave    Eve
          each: runtime, memory, tasks, journal, unified intake
                    |
       job task DAG + root provenance + exact effects
                    |
       existing bridge / nonces / node:https signed POST
```

`SessionAuthority` validates and freezes the reviewed policy hash. Startup checks
every identity, role, mailbox and selected contact before unlocking. It never
creates identities, mailboxes or contacts. Each runtime unlocks once. A partial
startup closes all runtimes already opened and performs no transport operation.

The supervisor initializes **new session profiles**, not new identities, under
`.technocore/swarm/sessions/<session-id>/agents/<alias>/`. Historical agent tasks,
rehearsals, approvals and reconciliation records are not loaded as session work.
`swarm:start` never overwrites an existing session. `swarm:resume` explicitly
reopens the same **offline** session while its original policy is unexpired.
It retains history and budgets, never repeats terminal computation, and blocks
work whose offline delivery cannot be reconstructed. Configured/live resume is
not supported. A dead process remains interrupted/needs-operator until an
explicit offline reopen; status inspection never reactivates authority.

All mailbox readers made with the standard `createStores` path share a non-TTL
ownership lock with sessions. A session owns each physical mailbox for its lifetime;
legacy CLI reads cannot race its ACK path. These locks live in the new swarm
namespace and contain no room capability in their names. A privileged embedding
that deliberately constructs alternate stores/transports is outside this boundary.

Execution is fair round-robin, serial (one operation at a time). This deliberately
stays below `limits.concurrency`; parallel execution is not implemented yet.
Dependencies are **task IDs**, not agent names. Bob -> Dave -> a new Bob task is
valid. Actual dependency cycles, missing parents and cross-job dependencies fail.

Authorized work advances automatically:

1. Persist accepted root task or planned child DAG node.
2. Run the target workload through the existing `AgentRuntime` and inference boundary.
3. Persist/export explicit result evidence; never transfer an entire memory store.
4. For a child, send its bounded work proposal to the target peer, durably ingest it,
   run its workload, send the result reference back and ingest the receipt.
5. Release ready DAG dependencies; complete the job when compute and required delivery finish.

No rehearsal commands or manual per-message approvals are used between authorized
internal steps. The host builds a bounded DAG with `submit` and `delegate`; the
supervisor executes it. Model-generated delegation suggestions are not enabled in
this version. There is no fixed graph or required Alice gateway.

## Policy and authority

`SessionPolicy` version 1 binds session ID, offline/configured provider mode, exact
five alias/DID/role bindings, per-member delegation capability, directional pairs,
contact IDs and destination hashes, workload/version and message schema lists,
limits, expiration, and the permitted network origin/path class.

Every pair must be explicitly listed. No full mesh is inferred. Destination hash
is the existing bridge hash of `{room, did, contactId}`; the policy contains the
hash, never the capability. Missing/mismatched contacts fail startup. Pair workloads
also cover result delivery, so a child exchange normally needs both directional
pairs. Execution capability and job authority remain separate checks.

Limits bound tasks, logical POST attempts, GET attempts, inference requests, payload
UTF-8 bytes (maximum 4096), delegation depth, concurrency, inference timeout and
session expiry (maximum 24 hours). Inference calls time out to ambiguous. No new
network adapter or paid inference API is implemented.

`intake` is optional: an explicit alias list, interval (1–60 seconds), and finite
round count (1–100). Without it, only expected internal deliveries cause GETs.
With it, external mailbox intake is bounded by both the reviewed rounds and total
GET budget. No public heartbeat, discovery publication, backlog crawl or URL fetch.

Each outbound effect has its own runtime-derived action ID, payload/destination
hashes, authority reference, intent, nonce reference and status. The existing
`ActionApprovalStore` still consumes an individual exact action before signing.
Session policy is checked before preparation, at approval consumption immediately
before nonce reservation, and again at dispatch (including after intent persistence).
Changed content, recipient, contact, capability or policy invalidates the effect.

The POST counter is persisted immediately before dispatch. A process crash in the
small intent-to-call interval conservatively consumes this budget; it is not proof
that a server received a request. No POST retry is configured, including 429.

Session authority cannot approve external replies, economic actions, shell commands,
identity/capability changes, arbitrary rooms/origins, policy changes, cursor/nonce
resets, or ambiguous recovery. This is not a general action permission system.

## Proposals, intake and external peers

`WorkProposal` version 1 (`kind: peer-work`) binds proposal ID, requester/recipient
DIDs, workload/version, bounded objective/input and hash, evidence hashes, output
schema, optional DAG references, reply DID, timestamps and untrusted provenance
claims. Schema names (`peer-work/v1`, `peer-result/v1`) are project-local formats,
not an official Technocore discovery protocol.

Intake order is bounded GET -> window validation -> private bounded untrusted
record -> durable runtime inbound task/journal -> sender/envelope/recipient/replay
validation -> proposal/job reference -> ACK. ACK is transport bookkeeping, never
approval or a promise to respond. Retention gaps, non-contiguous windows, stale
cursors, observable sequence regression and unexpected local messages halt without
cursor reset. Content is never fetched as a URL or executed as an instruction.

External proposals can target all five peers directly. The unified intake adapts
them to the existing `ExternalTaskRouter` work-only approval path; legacy external
version-1 requests remain supported. Invalid content is rejected, valid unknown
work is `needs-operator`. `approveExternal` requires an exact proposal hash and
operator scope (workloads, internal pairs and task bound). Responses are separate:
this supervisor does not auto-reply to external DIDs or create their contacts.

An approved external job retains immutable external origin, root requester,
original proposal and exact approval scope. Every child carries the root hash and
authority chain. External -> Bob -> Dave cannot acquire internal-root privileges.

## Durable state and recovery

The session checkpoint contains lifecycle/policy/budgets, proposal classifications,
jobs with root provenance, DAG tasks, outbound effects, receipt checkpoints and
recovery observations. Runtime task state, journal and selected evidence remain in
each peer's separate session directory. Untrusted raw intake is private local data,
not normal output or telemetry. Treat the entire session directory as sensitive.

Compute (`planned/accepted/running/result-ready/failed/ambiguous`) and delivery
(`local/planned/sent/received/needs-operator`) are independent. Delivery failure does
not re-run completed inference. Sending/receiving interrupted by a crash is
ambiguous. A complete explicit HTTP 4xx is failed, not permission to resend. Timeout,
5xx, connection reset, malformed receipt and local persistence uncertainty halt.

Generic `PeerEffectReconciliation` is independent of the historical rehearsal graph.
It requires a halted session, original destination binding, **separate exact read
approval**, one `since=0&wait=0&limit=200` GET and no retry. It records safe positive,
negative or incomplete observations without changing the original session, cursor,
nonce or action. `not-observed` is never proof of non-commit. A matching observation
still requires an operator decision; no recovery API silently restarts authority.

Already retained data can be classified completely offline via `observeRetained`
or the pure receipt classifier. Configured/live restart/local-apply authorization is not
implemented in this iteration. Existing runtime evidence remains durable for a
future operator-reviewed continuation; no historical recovery implementation was
removed or run.

The current transport does not provide a reliable room generation token. Detectable
sequence/retention regressions fail closed; an undetectable server epoch reset
cannot be proven absent. An empty window is not evidence that a mailbox never had
messages. These limits must not be converted into fresh-send authority.

Offline sessions use session-local simulated nonces/cursors and an in-memory
transport. Configured mode reuses the real DID/room nonce and physical mailbox
cursor stores, not a fresh counter per session. It requires a real provider injected
through the host API, and uses only the existing no-retry `node:https` POST lane
and bounded GET transport at `https://technocore.chat`.

## Commands

Recommended first run, **only generated temporary identities and no live requests**:

```powershell
npm.cmd run test:peer
```

These lower-level commands remain available; placeholders require a deliberately
prepared local policy/proposal. The operator workflow above can prepare an
offline policy and task hashes without editing code. It does not generate live authority:

```powershell
node .\dist\src\cli.js swarm:start --offline --policy <policy-file> --policy-hash <reviewed-hash>
node .\dist\src\cli.js swarm:status <session-id>
node .\dist\src\cli.js peer:capabilities bob --policy <policy-file> --policy-hash <reviewed-hash>
node .\dist\src\cli.js peer:capabilities bob --session <session-id>
node .\dist\src\cli.js peer:submit bob <proposal-file> --session <session-id>
node .\dist\src\cli.js swarm:stop <session-id>
```

`peer:submit` only queues local input to an active **offline** session. It never
performs a GET or POST. The CLI has no configured real inference provider:
`swarm:start` without `--offline` fails explicitly, never substitutes fixtures.
Host applications may inject `InferenceProvider` for configured mode after separate
operator review. No FLOP APIs or speculative endpoints are implemented.

Stop requests stop selection/new effects, finish bounded in-flight work, persist
the final checkpoint and release runtime references. A provider that ignores its
deadline cannot dispatch agent actions; a late result is ignored. It may still
retain its own computation/resources, since the provider interface has no cancel
method. Node `KeyObject` reference release does not guarantee immediate physical
memory zeroization. Passphrases never use argv or logs.

## External result delivery

After an approved external job completes and the session is cleanly stopped,
`ExternalJobDelivery` can prepare a response from the existing task/memory/evidence
and inference ledger. A separate exact response approval is required; work approval
never grants it. Bob -> Dave -> Bob can reply directly to the external requester
with dependency evidence and immutable external provenance. No runtime resume or
legacy workload re-execution is used. See [EXTERNAL-JOBS.md](EXTERNAL-JOBS.md) for
the commands, existing-contact requirement and conservative delivery recovery.

## Validation

Peer inference now uses a shared session ledger with DID/job sub-budgets and
host-created root provenance. Optional `inferenceBudgets` is bound by the reviewed
policy hash; no model or proposal can override it. See
[INFERENCE-ACCOUNTING.md](INFERENCE-ACCOUNTING.md) for reservations, safe inspection,
offline labels and unresolved-cost behavior. Existing session message authorities
and historical rehearsal/reconciliation records are not migrated.

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

Peer tests forbid socket connections, use generated temporary encrypted identities,
inject transport failures, and cover peer DAGs, root provenance, approval/dispatch
checks, isolation, recovery, intake ordering, bounded stop and secret-free output.
The old rehearsal suite remains part of the full regression suite.
