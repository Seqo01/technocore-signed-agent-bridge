# First controlled room-read rehearsal

This is a one-shot **operator-assisted** exercise, not an autonomous researcher, daemon,
poller or general message sender. It uses existing profiles/roles, AgentRuntime,
LocalSwarmRouter, selected task evidence, SignedAgentBridge, durable approvals and nonces.
Only the fixed aliases alice/bob/charlie/dave/eve participate; their DIDs are loaded and
bound locally, never embedded in source. Identity creation/unlock is not part of preparation.

The question is room-read reliability: duplicates, replay, retention gaps, sequence/epoch
behavior and safe recovery. The exact graph is:

1. Alice -> Bob (research request)
2. Bob -> Alice (research result)
3. Alice -> Charlie (engineering request with selected research evidence)
4. Charlie -> Alice (engineering result)
5. Alice -> Dave (review of original question/evidence/result/criteria)
6. Dave -> Alice (structured review)
7. Alice -> Eve (specialist request; no reviewer verdict supplied)
8. Eve -> Alice (specialist result)

Alice's synthesis is local. No ninth send, public room, full mesh, external peer, FLOP,
wallet, faucet, blockchain or commerce step exists. Result messages carry a short selected
summary and integrity/provenance hashes; full selected outputs move through local delegation
APIs, not shared memory directories. These are signed coordination receipts, not proof that
every engineering claim was independently verified by a live service.

## Local preparation

`prepareRehearsalContacts` in `src/rehearsal/setup.ts` reuses existing mailbox/contact stores.
It creates only missing Charlie/Dave/Eve mailboxes and six Alice-peer mappings. Existing
entries must match; existing Alice/Bob values are preserved. It never rotates or unlocks keys
and is not called implicitly by the runner.

Build with `npm run build`. New commands use the existing CLI directly; no new npm scripts
or dependencies were added. The following command only creates/resumes a local manifest and
prepares the **current** exact action; it does not unlock a key or access the network:

```text
node dist/src/cli.js rehearsal:prepare
```

Operational data remains under ignored `.technocore/`, including
`agents/alice/rehearsal/first-room-read-v1.json`. Only this first fixed rehearsal is supported;
there is no reset/new-run switch. Keep its durable state for reconciliation and audit.

## Separate operator-controlled actions (do not run during local setup)

Each command exits after its bounded operation:

```text
node dist/src/cli.js rehearsal:status
node dist/src/cli.js action:approve <sender-alias> <exact-action-id> <exact-action-hash>
node dist/src/cli.js rehearsal:send <exact-action-id> <exact-action-hash>
node dist/src/cli.js rehearsal:receive <step-number-1-through-8>
node dist/src/cli.js rehearsal:work <bob-or-charlie-or-dave-or-eve>
node dist/src/cli.js rehearsal:finalize
```

The runner has **no grant/approve method**. Use the existing operator approval command only
after reviewing the sender/destination DIDs, action ID/type, sanitized preview, payload hash
and action hash returned by preparation. Inspect the full intended task locally if the short
preview is insufficient; a hash alone is not informed approval. No approval is inferred from
starting the rehearsal. Exact approvals are consumed by the bridge **before nonce reservation**.
Changed payloads, contacts or DIDs fail closed. These approval records cannot authorize a new
effect, and all eight actions require separate decisions. Do not use `message:send` to bypass
the runner's step accounting, even with a valid individual approval.

Only `rehearsal:send`, `rehearsal:receive` and the separately authorized
`rehearsal:reconcile-observe` can perform network IO. They require the exact
canonical `TECHNOCORE_URL=https://technocore.chat`. Preparation, work and status do not create
a live transport. Unlocks occur through the existing private interactive TTY, never argv/env
passphrases. Send unlocks the sender; receive unlocks the recipient for AgentRuntime. Local
work may prompt for all five profiles to reuse the existing router/runtime endpoints. Never
paste passphrases into chat. Closing each invocation releases its runtimes and in-memory keys.

## Research and operator analysis

After a request is durably received, supply the corresponding structured workload output in
`.technocore/rehearsal-inputs/<alias>.json`. The final synthesis uses `alice.json`.

```json
{
  "sources": [
    { "kind": "operator-supplied", "summary": "Explicitly supplied analysis; not independently verified." }
  ],
  "output": { "replace-with": "the existing role workload's structured output" }
}
```

The placeholder output above is **not** a runnable Research/Engineering/Review/Specialist
result. See the existing schemas in `src/workloads/`. Final coordination output must include
exactly the four collected result hashes. Work is executed once via AgentRuntime and persists
the usual memory/journal/result evidence plus a separate provenance record. Re-entering the
same completed local work does not repeat inference; changing its packet halts the rehearsal.

Permitted operator source labels:

- `operator-supplied`: assertions supplied by the operator, not automatically verified.
- `source-derived`: requires a reference and contentHash; the runner does not fetch or verify
  that source. An official source revision should be recorded in the reference.
- `deterministic-offline`: fixture or offline analysis, never live research.

Only matched receipt processing can create a `live-observation` record. It records sequence,
first/last sequence and message hash, **not** a live-verified research conclusion. Injected
offline transports are always labeled `deterministic-offline` and cannot reopen a live manifest.
Inference metadata is `operator-supplied/manual-analysis-v1`, not a fabricated model/research
run. Dave's existing `verificationScope: supplied-evidence-only` remains unchanged. Source
collection and any extra diagnostic GET require a separate reviewed operation; this runner
does not browse documentation or synthesize observations which did not occur.

## IO bounds, intake and recovery

The encoded limit is **8 POST attempts and 8 GET attempts**, one of each per step. Both HTTP
retry counts are zero; the signed POST timeout stays 30 seconds. There is no backlog crawling,
long polling or automatic read retry. A receipt GET uses `since=<durable cursor>`, `limit=200`,
`wait=0`; exactly one expected message and the expected next sequence must be present. Existing
unread history therefore stops the run rather than being silently skipped.

Normal receive first compares the sent sequence with the persisted cursor plus one. A known
mismatch (including sent seq 1 with an old cursor of 1) halts with
`stale-cursor-or-room-sequence-mismatch` **before unlock or GET**. The GET-attempt counter and
cursor remain unchanged. This does not relax the normal next-sequence requirement.

Receive failures persist a safe stage, fixed error code, allowlisted error class/cause code,
timestamp, expected seq, prior cursor and destination hash. HTTP metadata, when observed,
contains only status, header-arrival/timeout flags and a coarse content-type category. Stages
distinguish preflight, identity unlock, GET intent, transport/status/parsing, message selection,
DID/frame/payload/sequence validation, task/journal/checkpoint persistence, ACK and local completion.
Raw exceptions, responses, private URLs, capabilities and message contents are never diagnostics.
Attempt counters record durable **intent**, not proof of a successful GET or receipt.

`AgentRuntime.ingestInbox` validates the expected message before persistence, then writes its
idempotent task and journal evidence. The runner's receipt checkpoint is saved after those
writes and before cursor acknowledgment. It never uses CLI `inbox:read`. Wrong/unverified DID,
duplicates, replays, missing/unexpected messages, retention gaps and sequence regression stop
the rehearsal. It cannot prove the absence of an epoch reset that is invisible in the returned
metadata; that remains an explicit research limitation.

Network intent/budget is durable before IO. A crash in a network-intent phase quarantines the
run; no automatic resend or re-read. A persisted receipt can complete its local ACK on restart
without another GET, only after validating the durable inbound task and journal evidence.
An ambiguous send permanently halts this rehearsal and leaves its nonce/approval consumed.
`rehearsal:status` exposes safe counters/hashes and the halt reason. No unhalt/reset command is
provided. Do not manually edit state or erase guards to force continuation.

## Separate one-time first-receipt reconciliation (requires operator approval)

This narrow mechanism supports only a halted first Alice -> Bob step, successful sent seq 1,
an unchanged Bob cursor of 1, and the exact originally prepared message hash. It is not a new
run, arbitrary room reader, cursor reset, or a way to retry `rehearsal:receive`. Original send
evidence, all profile/contact bindings and the entire halted manifest are checked. The existing
manifest is never changed, unhalted or advanced, including after successful reconciliation.

Local preparation and a **separate explicit read authorization**:

```text
node dist/src/cli.js rehearsal:reconcile-prepare
node dist/src/cli.js rehearsal:reconcile-authorize <authorizationId> <authorizationHash>
node dist/src/cli.js rehearsal:reconcile-status
```

These commands do not unlock an identity or access the network. Review the returned safe effect
before authorizing: Bob alias/DID, step 1, mailbox/contact hash, canonical origin, exact query
`since=0&wait=0&limit=200`, Alice DID, expected seq 1 and payload hash, old cursor, mode and original
manifest hash. Any change invalidates authority. Read authority uses the existing exact-effect
approval store implementation in a **separate** `reconciliation-approvals/` directory, with effect
type `technocore.reconcile-read`. An outbound send grant cannot authorize this read. Preparation
never grants authority, and there is no generic approve-all flag.

**Only after a separate decision to make the one observation**, this command unlocks Bob through
the usual hidden prompt and may make one GET (never a signed action):

```text
node dist/src/cli.js rehearsal:reconcile-observe <authorizationId> <authorizationHash>
```

It uses Bob's existing capability internally, `format=json`, `since=0`, `wait=0`, `limit=200`,
zero retries and `redirect=error`. The query cursor never overwrites the saved cursor. There is
no polling or pagination. Missing, extra/duplicate/conflicting, wrong-DID, wrong-frame/hash or
wrong-sequence messages stop processing. Non-2xx, parse errors and transport errors also stop.
The observation intent and approval are spent before IO; crashes cannot authorize another GET.

Validation checks transport sender DID, frame.from, receiver, rehearsal/version/step, exact
payload hash and seq. `serverVerifiedDid` is the bridge's existing trust in the configured
Technocore server's signed lane, not independent verification of a response signature.

Only the validated single message is retained in ignored private local state at
`agents/bob/reconciliation/first-room-read-v1-step-1.json`. No raw HTTP response, unrelated message,
mailbox capability or signature is copied there. **This retained text is still private local
message data; do not publish the file.** Retention precedes task creation so a crash can recover.
Processing reuses AgentRuntime's durable intake:

`validated observation -> idempotent inbound task -> safe journal -> receipt checkpoint -> ACK decision`

Because the saved cursor is already 1, the ACK decision performs **no cursor write**. Receipt
evidence is the new checkpoint, bound to observation, task payload and read authorization hashes,
not the old cursor. The inbound item remains queued; this reconciliation runs no workload,
inference, reply or synthesis. Offline fixtures are labeled `deterministic-offline`.

If task/journal/checkpoint or final local confirmation fails **after** the validated observation
was retained, local-only completion can be invoked explicitly:

```text
node dist/src/cli.js rehearsal:reconcile-complete <authorizationId> <authorizationHash>
```

This path cannot construct a live transport and never makes another GET. It checks the retained
hash, revalidates the receipt, and reuses the same task/journal IDs. After a checkpoint crash it
also checks durable evidence before local completion. If the process died before retention,
there is no local result to recover; neither command retries. Stop for operator review instead
of deleting state, resetting counters or issuing a new grant. The original halted rehearsal
remains unchanged in every case; a future continuation policy is outside this change.

## Security and tests

Peer text is untrusted; only exact planned content is accepted. It never becomes a command,
policy change, identity mutation or auto-approved send. Normal output contains no capabilities,
signatures, key material, private URLs or raw received messages. Recognizable secret material
in supplied analysis is rejected. This is application policy, not an OS sandbox; trusted host
code and the local account remain trusted. Provenance labels/hashes cannot establish the truth
of arbitrary operator prose. No new runtime dependency is used.

`npm test`, `npm run typecheck`, `npm run build`, `git diff --check` validate the implementation.
Rehearsal tests use generated temporary encrypted identities, an in-memory transport, and a
socket guard that rejects real network connections. Real identities/backups are not fixtures.
