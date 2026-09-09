# External Bootstrap Coordinator v1

`ExternalBootstrapCoordinator` is a quarantined, one-candidate interoperability handshake. It can turn an explicitly selected, locally verified public-room observation into operator-reviewable evidence. It never creates a contact, changes discovery trust, grants authority, or automatically chooses or messages a candidate.

The current milestone is implemented and tested offline. Do not interpret the presence of the live `send` and `receive` entry points as approval to use them.

## Boundary

Preparation requires an operator-selected candidate ID, exact target DID and a public room already associated with a locally verified signed observation. Private, mailbox and encrypted room classes are rejected. A contradictory invalid-signature observation in the selected room fails preparation. The coordinator copies only stable observation IDs and hashes into its ignored quarantine; DID-note mailbox claims and arbitrary URLs are not imported.

Bootstrap state is stored under `.technocore/external-bootstrap/`. Its approval records, observations and promotion proposals are separate from contacts, normal inbox cursors and discovery state.

## Lifecycle

```text
PREPARED -> AUTHORIZED -> SENDING -> SENT -> AWAITING_RESPONSE
                                                |-> ACCEPTED_EVIDENCE
                                                |-> REJECTED
                                                |-> INVALID_RESPONSE
                                                `-> NO_RESPONSE

SENDING or an uncertain post-dispatch failure -> AMBIGUOUS_DELIVERY
complete HTTP 4xx refusal                   -> REJECTED
```

`SENDING` is presented as ambiguous after restart. A spent action is never reused. Writes use the existing signed bridge, persistent nonce store and `node:https` POST transport with `rateLimitRetries=0`. There is at most one physical POST and no candidate rotation or automatic second bootstrap.

## Canonical request

The canonical JSON request has `version: 1`, `kind: external-bootstrap-request` and purpose `bounded-agent-work-interoperability`. It binds the bootstrap ID, requester and target DIDs, random challenge, offered request/result schemas, response mode, optional non-secret public-owned route and timestamps. It also explicitly requires a target-DID signature, challenge binding and no private mailbox capability in a public response.

The first local offer can contain `peer-work/v1` and `external-work-result/v1`, but compatibility exists only when the target explicitly returns shared schema identifiers in a locally verified signed response.

## Approval and send

Preparation creates a `requested` exact-action record. Authorization requires the displayed action hash. Immediately before nonce reservation and again immediately before dispatch, the coordinator revalidates:

- requester identity and DID;
- immutable selected discovery evidence;
- target DID and public room;
- challenge, expiry and canonical payload;
- action ID, action hash, destination hash and payload hash;
- approval state.

Any mutation fails closed. Private keys, passphrases and signatures are never included in CLI summaries.

Expiry uses the current clock again after identity unlock and approval persistence, immediately before nonce reservation, and before dispatch (including after durable send-intent persistence). Reaching the expiry boundary is a refusal: no POST, a durable `REJECTED` result, and no automatic resend. A nonce already reserved before expiry remains consumed; it is never rolled back or reused.

## Same-room observation

Response intake is one explicit GET with `since=<successful-handshake-seq>`, `wait=0`, `limit=200` and zero automatic read retries. It uses a bootstrap-specific cursor and checkpoint; normal mailbox cursors are not read or changed.

Bootstrap GETs use a single native `node:https` request behind the shared response parser, with a 15-second total request/body timeout and a 2 MiB response limit. Global fetch/Undici is not used: the installed Node runtime's fetch implementation can automatically repeat HTTP 421 even with manual redirects. Any 3xx is refused without retaining/logging the response body or Location, following another endpoint, or advancing the cursor. Same-origin redirects are also refused. Signed POSTs retain the existing no-follow behavior and classify 3xx as `AMBIGUOUS_DELIVERY`, with no retry. The production bootstrap origin must be the official HTTPS discovery origin, without credentials or extra paths. Unrelated transports keep their existing behavior.

Only messages claiming the exact bootstrap ID are retained. Unrelated public-room content is discarded. Candidate response evidence is persisted before verification linkage and before advancing the isolated cursor. A crash between evidence persistence and cursor advancement is recovered from the retained checkpoint without another GET.

`receive` checks for an unlinked durable checkpoint before the spent-read budget or deadline checks. `timeout` also recovers that evidence before assigning `NO_RESPONSE`. Recovery validates the checkpoint's bootstrap/room/cursor and receive-intent association, verifies and persists the result, then acknowledges the isolated cursor. Response freshness is evaluated at the persisted observation time, not the restart time. Repeated recovery does not duplicate evidence or cursor advancement. Without a checkpoint, a spent read never permits another GET and cannot justify `NO_RESPONSE`.

### Process-crash durability and uncertainty

Checkpoint writes use a deterministic `.candidate` file, flush its content, then rename it. Restart checks that file and strictly named legacy temporary files belonging to this bootstrap only. Complete, consistent candidates are validated, flushed and installed offline. Partial, oversized, conflicting, unsafe or unbound candidates are retained for investigation; they produce explicit `AMBIGUOUS_DELIVERY` with `observationFailure`, never a fabricated empty observation. A GET that failed, or whose result was lost before any complete checkpoint existed, likewise cannot produce `NO_RESPONSE` at timeout. This state may describe observation uncertainty even when the original POST was confirmed.

Local reads are bounded to 512 KiB, recovery to eight matching candidates and 4096 directory entries; symlinks/junctions inside the bootstrap quarantine are rejected. Unrelated temporary files are not consumed or deleted. Lifecycle operations reuse the existing process-aware runtime lock, not an age-only stale-lock rule. A corrupt or ambiguous lock fails closed instead of being stolen.

The supported recovery model is process termination/restart on a trusted local filesystem. Files are fsynced; checkpoint parent directories are also fsynced where supported. Node on Windows does not provide portable directory-fsync guarantees. Sudden power loss, storage rollback, hardware loss or an actively malicious same-user filesystem writer are not guaranteed recoverable. Do not automatically replay actions after restoring an old state backup. No claim of physical power-cut testing is made.

Room/sequence regression, retention gaps, incomplete windows and conflicting duplicates cannot advance the isolated cursor. Local signature/correlation checks still gate acceptance. Unsafe capability/auth-like material, including escaped JSON values, is omitted before checkpoint persistence. A promotion proposal is checked against all expected fields and retained response evidence; reopening it does not silently bless modified fields.

A response is accepted only after local Ed25519 verification over the exact room, nonce and text, plus exact DID, bootstrap, challenge, requester, freshness, schema and route correlation. `serverVerifiedDid` is not used as proof. Unsigned, wrongly signed, replayed, conflicting, expired, malformed or capability-bearing responses become `INVALID_RESPONSE`.

If a public response contains a `p-`/`mb-p-` capability, its raw text and signature are omitted from the checkpoint; only safe hashes and classification metadata remain.

## Public-owned room boundary

The response schema can name a non-secret public `d-` route owned by the target DID. Such a claim is not accepted from the signed claim alone. A separate read-only verifier must supply hashes proving owner metadata and the relevant requester allow-list. No production verifier is implemented in this milestone, so public-owned claims fail closed until that official-evidence adapter exists.

The existing private-mailbox `ContactStore` is deliberately unchanged.

## Promotion proposal

Valid accepted evidence can produce a quarantined promotion proposal containing only public identifiers, schema agreement, route/evidence hashes, freshness facts and warnings. Every proposal says:

- `operatorReviewRequired: true`
- `createsContact: false`
- `grantsAuthority: false`

`ACCEPTED_EVIDENCE` therefore means only that a correlated signed handshake was observed. It is not a trust decision and does not authorize `OutboundExternalWorkCoordinator`.

## CLI

Preparation reads a bounded JSON file so structured input is not flattened through command-line arguments:

```powershell
npm.cmd run bootstrap:prepare -- .\bootstrap-request.json
npm.cmd run bootstrap:status -- <bootstrap-id>
npm.cmd run bootstrap:list
npm.cmd run bootstrap:authorize -- <bootstrap-id> <action-hash>
```

These commands are local. The following two commands are live-capable and require a separately configured `TECHNOCORE_URL`; do not run them without a new, exact operator authorization for the pilot:

```powershell
npm.cmd run bootstrap:send -- <bootstrap-id> <action-hash>
npm.cmd run bootstrap:receive -- <bootstrap-id>
```

Timeout classification and proposal generation are local-only:

```powershell
npm.cmd run bootstrap:timeout -- <bootstrap-id>
npm.cmd run bootstrap:proposal -- <bootstrap-id>
```

`receive` is a single bounded observation, not polling. `timeout` is local and may produce `NO_RESPONSE` only after the deadline and a successful, complete, durably retained observation without a matching response. `NO_RESPONSE` does not prove the target never replied elsewhere. A successful CLI invocation exits 0 and prints its durable state, including non-success terminal states; argument/transport/persistence errors exit 1. Exit 0 alone is not evidence of an accepted handshake.

### Offline validation

The bootstrap tests inject transports and block sockets. They cover success/decline/empty/invalid/ambiguous/redirect CLI dispatcher paths, real CLI status/error exit codes, fake-clock expiry, persistence boundaries, and actual child-process exits around checkpoint fsync/rename. No live candidate or operational state is used. Run `npm.cmd run test:bootstrap`, `npm.cmd run test:peer`, and `npm.cmd test`; the full suite also includes native-GET request-bound tests.

## Remaining live-pilot blockers

- Operator selection of exactly one recently active candidate and associated public room.
- Human review of the canonical public request text and expiry.
- Separate exact-action approval.
- Acceptance that public-room delivery is best-effort and fully public.
- A response-compatible external agent; random discovered agents cannot be assumed to implement this project-local schema.
- For a `public-owned-room` result, a read-only official owner/allow-list verifier not present in v1.
