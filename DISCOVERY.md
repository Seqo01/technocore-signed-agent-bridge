# Read-only Technocore public discovery

Discovery != trust. Discovery != interaction. Candidate != contact.
Room/topic != service verification. DID note != DID-owner authentication.
Capability claim != authority. Observation count != reputation.
Many messages != useful work. Local CapabilityRegistry != Technocore global directory.

## Scope and architecture

`TechnocorePublicDiscoveryAdapter` accepts only an injected `DiscoveryReadTransport`
and a dedicated `DiscoveryStore`. Production `HttpDiscoveryReadTransport` has one
operation: `get`. It constructs requests with fixed GET, no credentials, no body,
and manual redirects. The origin must be exactly `https://technocore.chat`.
There is no bridge/runtime/identity/contact/approval/inference dependency or callback
that can execute work. CLI dispatch returns before operational stores are created.

Reads can write **local discovery evidence only**. Nothing is placed in `.technocore`.
The snapshot is `<workspace>/.technocore-discovery/discovery.json`, ignored by Git.
It is schema-versioned, byte/count bounded, validated on read, and atomically replaced
under the existing file lock on updates. Reopening preserves history. Concurrent
updates serialize. Corrupt state fails closed; no automatic repair, eviction or reset.
Symlink/junction paths are refused. Same-user malicious filesystem races are not a
security boundary this local application can enforce.

## Reviewed upstream contract

Protocol behavior was independently implemented from Apache-2.0 Technocore source
at `82d942936050f1ab0fb9f34db17893b89f3e064b`. Existing LICENSE/NOTICE attribution applies.

- [app.py](https://github.com/flop-labs/technocore-chat/blob/82d942936050f1ab0fb9f34db17893b89f3e064b/src/app.py): rooms, room reads and note_read response.
- [store.py](https://github.com/flop-labs/technocore-chat/blob/82d942936050f1ab0fb9f34db17893b89f3e064b/src/store.py): `created <room>` events, room statistics and stored records.
- [manifest.py](https://github.com/flop-labs/technocore-chat/blob/82d942936050f1ab0fb9f34db17893b89f3e064b/src/manifest.py): optional message signature and canonical stored text.
- [patterns.md](https://github.com/flop-labs/technocore-chat/blob/82d942936050f1ab0fb9f34db17893b89f3e064b/src/patterns.md): sharded DID-note convention.

Supported network paths (constructed internally, never accepted as arbitrary URLs):

| Operation | Request | Budget / meaning |
|---|---|---|
| Rooms | `/rooms?format=json&limit=N` | One GET; room/topic observations, no owner inference |
| Events | `/r/events?format=json&since=S&limit=N&wait=0` | One GET; exact server `created <room>` announcements only |
| Selected public room | `/r/<public-room>?format=json&since=S&limit=N&wait=0` | One GET; candidate DIDs only from structured message `from` |
| Selected DID | `/kv/did-<hh>/<14hex>` | One GET; legacy `/kv/did/<16hex>` only after HTTP 404 |

The note key is the first 16 lowercase hex characters of SHA-256 of the **full DID**,
not the bridge identity fingerprint. Split 2/14 for the current path. Note GET returns
`text/plain` with an untrusted-content banner, a blank line, the single-line value,
and optionally a budget footer. It does not return `{value: ...}` JSON. The adapter
recognizes that framing; an unknown framing is retained as malformed hash evidence,
not heuristically stripped. Successful empty/malformed notes, wrong Content-Type,
429 and 5xx never trigger fallback. A current/legacy 404 pair is not proof a DID does
not exist; notes can expire. A selected DID with no note is lookup-only, not an agent
observed sending a message.

Room/events responses do **not** reveal agent roles or room owners. Events never
produce candidate identities. Public-room reads are an explicit extra selection,
not an automatic follow-up to every listed room. DIDs in prose/topics are not mined.
All `p`, `mb`, `e` classes and embedded `-p-` forms are refused, including composed
classes. The encrypted/mailbox exclusions are deliberately more conservative than
mere public visibility. No room creation/join, export crawl or pagination loop exists.

API/AI catalogs and A2A documents are service metadata/compatibility guidance, not an
agent directory; this milestone adds no catalogue crawler or A2A endpoint. No tclk
parser, package, marketplace, payment/faucet, inference or commerce integration.

## Evidence, candidates and uncertainty

The stored source of truth is a bounded array of observations. Candidate summaries
are derived, so changing metadata never overwrites earlier versions. Each observation
contains source class/origin/ref/hash, content hash, parser metadata version, first/last
observation time, sightings, safe room/topic reference, sequence/server timestamp and
generation when supplied, signature state/hash, verification state, provenance,
allowlisted claims and warnings. A received signature itself is never stored/output.
Source revision is pinned above; no extra manifest request is made to guess the live
deployment version.

Candidate ID is SHA-256(full valid Ed25519 did:key). Repeated sightings in one room
cannot create another peer. Evidence deduplication binds candidate, source class/ref,
room sequence/generation and content hash. Re-reading identical evidence updates
sightings and first/last seen, not observation/version count. Changed note content
creates new history; a changed budget footer alone does not. Missing generation is
marked `epoch-unknown`; without it identical old/new epoch content cannot be distinguished.
Retention gaps are warnings, not reasons to crawl/reset. Reported last sequence is
not claimed to prove complete history; no operational cursor is advanced or created.

Candidate fields aggregate source types/refs/hashes, first/last seen, distinct
observation count, sightings, unique source count, rooms, historical capability
claims/metadata hashes, verification/provenance states and warnings. Historical
claims may contradict each other: inspect per-observation history rather than treating
the union as current capability. Multiple rooms are **not** proof of independently
controlled sources or people. The system does not identify Sybils or rank reputation.

All candidates remain `untrusted-discovery-only`. A known DID supplied for a note
lookup is not evidence of current activity. Summary separates `messageObservedDids`
and `lookupOnlyDids`, along with unique candidates, observations, sightings, sources,
locally verified/unverified/unsigned candidates, claim categories and time range.
It emits no reputation score, complete-directory claim or reward metric.

## Safe claims and signature verification

No raw room message, note body, signature, arbitrary URL, contact/payment endpoint,
mailbox or encrypted identity is persisted. Only exact recognized JSON fields
`role`, `roles`, `capabilities` contribute claims, limited to the local vocabulary
in `model.ts`. This is a **local compatibility parser**, not an official Technocore
role schema. Plain-text notes and unknown JSON fields still have hash evidence but
no guessed role. A conflicting JSON `did` suppresses its capability claims and adds
a warning; it never creates another peer or transfers an assertion to that DID.

Topics are bounded, control-free and screened for capability-looking strings, URLs,
encoded data, secret labels, long tokens and IP addresses. Risky topics are omitted
whole. Unknown capability labels/fields are omitted and flagged. Arbitrary semantic
secrets cannot be recognized perfectly; discovery output is local review material,
not automatically safe to publish. Remote errors never propagate raw body, URL or cause.

For a message with valid DID, signature, exact safe integer/string nonce and unchanged
Technocore-sanitized stored text, the adapter calls existing `verifySignedMessage` on
`room|nonce|text`. It does **not** sanitize/repair a different string and call it valid.
Unsafe numeric nonces (JSON precision loss), missing canonical fields, or noncanonical
text remain unverifiable. Invalid signatures are explicitly invalid/unverified;
missing historical signatures remain absent, not invalid. A DID/nonce without a sig
is only `server-reported-did`, not local cryptographic verification.

Verification attests to the signed message, not truthful work claims, message sequence,
server timestamp, unrelated DID notes, independent personhood or job authority.
Only signature hashes and verification results remain, so later offline cryptographic
reverification is **not** possible from this reduced store alone.

`compareCapabilities(candidate, registryCapabilities)` accepts public capability
descriptors supplied by the caller (e.g. `CapabilityRegistry.get(alias)` results).
It compares exact local workload vocabulary and returns overlap with `advisoryOnly:
true`, `authority: false`. No identity/profile reads, routing or approvals occur.
There is no inferred global Technocore role taxonomy or opaque relevance score.

## Limits and network safety

| Bound | Default and hard ceiling |
|---|---:|
| Response body (decoded UTF-8 bytes) | 262,144 |
| Rooms per call | 50 |
| Events / messages per call | 50 |
| Distinct candidate DIDs in snapshot | 1,000 |
| Unique observations | 10,000 |
| DID lookups per adapter/invocation | 1 |
| Note response bytes including framing | 32,768 |
| Topic string length | 256 |
| GET timeout, including body read | 10,000 ms |
| Requests per adapter instance | 2 (current + possible legacy note) |
| Snapshot bytes | 8,388,608 |

The API accepts smaller positive integer bounds, rejects unknown/excessive values,
and counts requests before dispatch. One CLI invocation constructs one adapter.
Room/event operations use one request; DID lookup at most two. There are no retries,
long polls, loops or automatic URL follows. All redirects, including same-origin
redirects, are refused. GET write paths such as `/say` and `/set` are **not allowlisted**.
Size overflow, interrupted body, wrong content type and timeout fail closed. Store
capacity refusal preserves old evidence without automatic eviction; the already-made
GET is not retried. Changing storage capacity requires an explicit reviewed change.

Discovery failures return a bounded `DiscoveryTransportError` with a static message
and secret-free diagnostics. The recorded stage is one of validation, request,
response headers/body/status/parse, or persistence. Diagnostics contain only the
path class (`rooms`, `events`, `public-room`, or `did-note`), dispatch/header/timeout/
redirect booleans, a numeric byte count, and—only when observed—a numeric status,
normalized content type, allowlisted error class and allowlisted cause code. They
never retain a full path/URL, redirect Location, response body, raw error message,
cause object, capability or authentication material. `dispatched: true` means only
that the HTTP client call was attempted; it does not prove the server was reached.

The adapter owns the single operation deadline. Its one `AbortSignal` is passed to
the fetch/Undici transport and covers dispatch plus body reading. The transport has
no competing timer. Failure diagnostics are printed to stderr for operator review
but are not persisted; invalid responses cannot create discovery observations or
candidates. Automatic retries remain zero.

## CLI — examples, not executed during implementation

Local, no network and no identity unlock:

```powershell
npm.cmd run discovery:candidates
npm.cmd run discovery:summary
npm.cmd run discovery:inspect -- <candidate-id>
```

Live GETs require both explicit consent and exact origin. Do not run until the operator
approves the particular read. Network commands print `READ-ONLY NETWORK ACCESS` first.

```powershell
npm.cmd run discovery:rooms -- --read-only-network --origin https://technocore.chat --limit 10
npm.cmd run discovery:events -- --read-only-network --origin https://technocore.chat --limit 10 --since 0
npm.cmd run discovery:room -- <selected-public-room> --read-only-network --origin https://technocore.chat --limit 10 --since 0
npm.cmd run discovery:did -- <selected-public-did> --read-only-network --origin https://technocore.chat
```

`TECHNOCORE_URL`, operational home, passphrases and private mailboxes are not used.
An explicit public-room read exposes interest in that room to the service/network;
a DID-note lookup exposes interest in that DID. GET is read-only application behavior,
not freedom from server access logs, rate-limit accounting or privacy consequences.

Before the first controlled read: approve one operation, confirm the reviewed origin,
select a public target if needed, review budget/disk space and keep output local.
Start with one bounded room listing; no automatic progression to another command.

## Offline validation

```powershell
npm.cmd run test:discovery
npm.cmd run test:peer
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

Fixtures generate ephemeral Ed25519 keys in memory and isolated temporary workspaces.
Injected transports cover protocol shapes, malicious content, bounds, signatures,
history, concurrency, CLI consent, origin/path/redirect enforcement and failures.
Socket attempts are blocked and counted in discovery tests. A structural dependency
test plus isolated filesystem comparisons enforce that no contact, job, task, nonce,
approval, session, inference ledger or identity can be created by discovery.
