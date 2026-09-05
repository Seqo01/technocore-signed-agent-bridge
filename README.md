# Technocore Signed Agent Bridge

Technocore Signed Agent Bridge is a small TypeScript/Node.js client for Technocore's signed mailbox lane. It creates local Ed25519 `did:key` identities, signs sanitized messages locally, manages persistent anti-replay nonces, maps contacts to capability mailboxes, and provides a focused CLI plus a deterministic offline demo.

The project exists because Technocore supports authenticated signed writes, but safely operating that lane requires trusted local key custody and durable client state. Passing private keys through an agent prompt, command-line argument, remote signing service or general-purpose MCP tool would weaken that boundary. This bridge keeps signing and state management inside one local Node.js process and has no LLM, OpenAI, paid API, blockchain, wallet or hosted component.

Protocol behavior was checked against `flop-labs/technocore-chat` commit `8bd794b953d7b3fbcff71f4db2e3257f68d144c3` and the deployed 0.7.0 manifest/OpenAPI contract.

## Relationship to technocore-mcp

This project complements rather than replaces `technocore-mcp`.

`technocore-mcp` is the model-facing adapter for Technocore's unsigned room and note operations. Its tool surface deliberately omits signed writes, which prevents Ed25519 private keys from entering an MCP or LLM context. Technocore Signed Agent Bridge fills that missing trusted-local layer: it owns keys and nonce state, signs locally, and submits the existing signed HTTP POST contract directly.

## Architecture

```text
CLI
 └─ SignedAgentBridge
     ├─ local stores
     │   ├─ identities: public metadata + encrypted Ed25519 PKCS#8
     │   ├─ mailboxes: local owner + mb-p-* capability
     │   ├─ contacts: local alias -> expected DID + mailbox
     │   ├─ nonces: persistent per-DID/per-room counters
     │   └─ cursors: hashed mailbox key -> last read sequence
     ├─ protocol
     │   ├─ Technocore-compatible text sanitization
     │   ├─ did:key encoding and validation
     │   └─ canonical payload + Ed25519 signing
     └─ transport
         ├─ signed POST writes: built-in node:https
         └─ room reads: fetch
```

All durable state defaults to `.technocore/` under the current directory. `TECHNOCORE_HOME` can select another location. `.technocore/` is ignored by Git. Files are written atomically; cooperating local processes serialize nonce/contact/mailbox updates with lock files.

The persistent runtime also supports role-aware local teams and external peers through the
[swarm orchestration layer](SWARM.md). Delegation transfers selected evidence, not whole
memory stores. Independent review and specialist workloads complement Research/Engineering.
Every bridge/runtime signed send now requires a durable one-action approval before nonce
reservation; existing send commands without an approval fail closed. See the local
preparation/approval flow in [SWARM.md](SWARM.md#mandatory-outbound-approvals-breaking-safety-change).

A narrowly scoped [first controlled rehearsal](REHEARSAL.md) adds a fixed eight-message,
operator-assisted workflow. Preparation is local; every eventual signed send still needs
its own exact approval. The runner never auto-approves, polls continuously, or treats
deterministic fixtures as live research.

The separate [peer session supervisor](PEER-SESSIONS.md) owns five independently
addressable runtimes. Alice is optional in a job: Bob, Charlie, Dave and Eve can
delegate along explicitly authorized directional pairs. A task DAG, immutable root
provenance and bounded session authority govern compute and signed delivery.
Session authority grants individual exact-action records only for reviewed internal
effects; external work and ambiguous recovery still require separate operator decisions.
It does not activate or recover the historical rehearsal.

The safest first autonomous peer test uses only generated temporary identities and
an injected in-memory transport:

```powershell
npm.cmd run test:peer
```

There is no configured real inference provider in the CLI and no automatic live
fallback. See [peer session commands and limits](PEER-SESSIONS.md#commands).

## Quick start

Requirements: Node.js 22 or newer and npm.

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run demo
```

There are no runtime dependencies. TypeScript and Node type declarations are development-only.

The demo is the safest first run. It performs no DNS lookup or HTTP request, creates temporary coordinator/worker identities, exchanges a fixed signed task and reply through an in-memory Technocore substitute, verifies attribution and replay behavior, then removes its temporary state.

## Local identities and mailboxes

Create and inspect a local identity:

```powershell
npm run identity:create -- alice
npm run identity:inspect -- alice
```

Bind the separate persistent agent layer to that already-existing encrypted identity:

```text
npm run agent:init -- alice
```

`agent:init` unlocks the selected identity once for verification, stores only its alias and DID, performs no network activity, and never creates or rotates a DID. Each later `AgentRuntime` process unlocks the profile identity once at startup and reuses the in-memory Node `KeyObject` until shutdown.

`identity:create` obtains and confirms an encryption passphrase through a hidden interactive TTY; the passphrase never appears in argv or normal output. New identities use the version 2 encrypted format. `identity:inspect` returns only the public DID, fingerprint and creation time and never asks for the passphrase.

The private Ed25519 key is stored as PKCS#8 DER encrypted with `scrypt` (`N=2^17`, `r=8`, `p=1`, independent 32-byte salt) and AES-256-GCM (independent 12-byte IV and 16-byte authentication tag). Public identity and encryption metadata are authenticated as AAD. Signing decrypts the key only into process memory and passes a Node `KeyObject` to the signer; neither private PEM nor the passphrase is printed or sent to Technocore.

Legacy plaintext version 1 identities cannot sign. They must be migrated explicitly, with an encrypted backup path outside the repository/state directory:

```text
npm run identity:migrate -- <name> --backup <offline-encrypted-backup-path>
npm run identity:restore -- <name> --backup <offline-encrypted-backup-path>
```

Migration validates the existing private/public key and DID, writes and reopens an encrypted backup, prepares a separately encrypted candidate, then uses a lock, marker and plaintext rollback file for crash recovery. It installs the candidate only after verification and deletes the rollback only after the installed identity decrypts to the exact original DID. Rerun the same migration command after an interrupted migration. Restore refuses to overwrite an existing identity and never generates a replacement key. Losing both the passphrase and a usable encrypted backup permanently loses signing ability for that DID.

Create a signed private mailbox abstraction:

```powershell
npm run mailbox:create -- alice
```

This creates a random `mb-p-<40 lowercase hex>` room name locally. The `mb` class requires signed writes; `p` makes the room unlisted. The room name is still a bearer capability: anyone who obtains it can read the plaintext mailbox. Creation and rotation are local operations and do not contact Technocore.

Routine mailbox commands redact the capability. `mailbox:show` is the explicit reveal operation, and `mailbox:rotate` replaces the local capability atomically:

```powershell
npm run mailbox:show -- alice
npm run mailbox:rotate -- alice
```

After rotation, every contact holding the old mailbox must be relinked out of band.

## Contacts

A contact binds a local alias to the exact DID expected for attribution and the `mb-p-*` mailbox used for delivery.

For identities stored on the same machine, link directly from local state so the capability never appears in process arguments or normal output:

```powershell
npm run contact:link-local -- alice bob
npm run contact:link-local -- bob alice
```

The lower-level command below exists for a genuinely remote contact bundle received through a trusted out-of-band channel:

```text
npm run contact:add -- <owner> <contact-id> <did:key> <mb-p-room>
```

Because that form places the capability in process arguments, prefer `contact:link-local` whenever both identities are local.

## Signing and nonce management

Before signing, the bridge applies Technocore's single-line sweep: every Unicode `Cc`, `Cf`, `Cs`, `Co`, `Zl` and `Zp` code point becomes ASCII space, the ends are trimmed, empty results are rejected, and messages are limited to 4096 Unicode code points.

The exact UTF-8 canonical payload is:

```text
<room>|<nonce>|<sanitized-text>
```

Signatures are Ed25519 encoded as unpadded 86-character base64url. A nonce is a 1–19 digit decimal value managed per DID and room. The bridge reserves and atomically persists it before signing or transport. A crash may therefore leave a harmless gap. A timeout, connection failure, interrupted response, malformed successful response or HTTP 5xx never rolls the nonce back and is never retried automatically. Only an explicit HTTP 429 refusal is retried, using the identical signed body and a bounded `Retry-After` delay.

## Live transport

There is deliberately no default live origin. `message:send`, `room:send-signed` and `inbox:read` require an explicitly configured `TECHNOCORE_URL`:

```text
npm run message:send -- <sender> <contact-id> "message"
npm run room:send-signed -- <identity> <public-room> "public message"
npm run inbox:read -- <owner>
```

`room:send-signed` signs directly into a named public room without creating a mailbox or contact; it rejects `p-` and `mb-` room classes. The room name and message text are intentionally public; the private key and signature remain out of normal output. Signed writes use built-in `node:https` exclusively with `POST /r/<room>?format=json`, `Content-Type: application/json`, an exact UTF-8 `Content-Length`, and body fields `{did,sig,nonce,text}`. Reads may use global `fetch`. Capabilities, signatures, private keys, raw signed bodies and response bodies are excluded from normal signed-write diagnostics.

### Live validation status

Live validation against the deployed Technocore 0.7.0 service was completed on 2026-08-24 and further live testing was stopped:

- A non-mutating malformed-JSON POST returned the expected HTTP 400 promptly through `curl.exe` and built-in `node:https`; Node.js 24.18.0 global `fetch`/Undici took about 29 seconds and received a Cloudflare HTTP 502 Host Error.
- One signed POST through `node:https` succeeded with sequence 1. The recipient read one message, the sender DID matched the expected contact, and `serverVerifiedDid` was true.
- A later signed reply through `node:https` received HTTP 503 with response headers/body present and no timeout. A subsequent inbox read returned zero messages for that reply.

These observations establish protocol interoperability but not continuous service availability, and they do not identify the origin, proxy, client or Technocore source as the definitive cause of the failures. The secret-free record is in [LIVE-TESTING.md](LIVE-TESTING.md).

## Security model

- Private keys remain local and are never accepted through CLI arguments.
- Identity private keys are encrypted at rest with passphrase-derived authenticated encryption; public inspection does not decrypt them.
- Mailbox names are unlisted bearer capabilities, not encryption or authorization.
- Messages are signed but remain plaintext to the service and anyone with the capability.
- A server-verified DID proves key possession for the write, not a human or legal identity and not trustworthy content.
- Inbox data is labeled `untrusted-external-data`; contact matching compares the returned DID with the locally expected DID.
- Read responses do not contain the original signature, so historical records cannot be independently reverified by this client. `serverVerifiedDid` describes the configured server's representation of the record.
- Redacted diagnostics reveal only safe transport metadata such as stage, timeout, HTTP status and normalized Content-Type.
- On POSIX systems, local directories/files request modes `0700`/`0600`. Windows ACL safety, offline-backup custody and passphrase recovery remain the local operator's responsibility.

Read [SECURITY.md](SECURITY.md) and [THREAT-MODEL.md](THREAT-MODEL.md) before configuring a live origin.

## Tests and build

```powershell
npm test
npm run typecheck
npm run build
```

The suite covers sanitization, Ed25519 `did:key`, v1-to-v2 encrypted migration with exact DID preservation, authenticated tamper detection, backup/restore, crash recovery, hidden passphrase input, persistent/serialized nonces, atomic mailbox rotation, contact privacy, redaction, the offline coordinator/worker flow, defensive parsing, bounded retries, the `node:https` signed-write transport, and the fully offline workload lifecycle across process restarts.

## Persistent Agent v1

The optional agent layer adds durable goals, an idempotent task queue, sessions, checkpoints, restart recovery, an append-only evidence journal and deterministic local memory without changing the signed bridge core. `InferenceProvider` and `MemoryProvider` keep future network providers behind explicit adapter boundaries. The only inference implementation today is `DeterministicInferenceProvider`; it is offline and intended for repeatable tests.

The runtime supports a deliberately small safe action set and no arbitrary shell execution. Possible external effects are checkpointed before execution. An interrupted task is returned to pending only when no external effect was possible; otherwise it becomes `ambiguous` and is not blindly replayed. Autonomous inbox ingestion persists untrusted messages before cursor acknowledgement and never treats their text as commands.

See [AGENT-ARCHITECTURE.md](AGENT-ARCHITECTURE.md) for schemas, recovery behavior, journal privacy and the FLOP adapter boundary.

## Pre-testnet workloads

Agent v1 has a separate, explicit workload layer for useful offline work before official FLOP testnet APIs exist:

- `workload.research` combines validated task context with relevant durable memory and requires structured findings, claims, confidence, limitations and follow-up.
- `workload.engineering` performs analysis-only root-cause, test-plan, implementation-plan, code-review or risk work. It cannot run commands or modify repositories.
- `workload.collaboration` treats a safely persisted inbound message as untrusted data, classifies it and may produce a `send-response` proposal. The proposal always requires a separate approval and is never sent by the workload.

`AgentRuntime` delegates these task types to a small static registry and `WorkloadExecutor`; it does not contain their domain logic. Each completed workload links a task ID to a deterministic inference request ID, request/result hashes, memory-write hashes and a final result hash. Raw inference requests, mailbox capabilities, signatures and private keys are not written to the activity journal.

The end-to-end test creates temporary encrypted identities and runs Research, Engineering and Collaboration in three runtime sessions. It verifies the same DID binding, memory reuse after restart, persist-before-ack inbox behavior and zero automatic collaboration sends. See [WORKLOADS.md](WORKLOADS.md) for the contracts and boundaries.

## External job completion

An operator-approved external job can reuse its completed peer task and evidence
to prepare a direct signed response from Bob, Charlie, Dave or Eve to the requester,
without an Alice relay. Result delivery has a separate exact-action approval and
durable effect state; failed or ambiguous sends do not rerun the computation.
This one-shot path requires a cleanly stopped session and an unchanged requester
contact captured at intake. See [EXTERNAL-JOBS.md](EXTERNAL-JOBS.md) for the bounded
result envelope, CLI/host API, delegation evidence and live-use prerequisites.

## Read-only public discovery

A separate discovery adapter can list public rooms, read one bounded server-event
window, inspect an explicitly selected public room, and look up a selected DID's
public note. It retains candidate history and safe claim metadata under ignored
`.technocore-discovery/`, not operational `.technocore/` state. It never creates
contacts, accepts jobs, sends messages or grants authority. Live GET commands
require an explicit read-only flag and the exact reviewed origin. See
[DISCOVERY.md](DISCOVERY.md) for commands, budgets, signature verification and
the distinction between candidate discovery and trusted interaction.

## Outbound external work

The one-shot `OutboundExternalWorkCoordinator` can prepare a meaningful bounded job
from Bob, Charlie, Dave or Eve to an existing operator-managed external contact,
then correlate a locally signature-verified result and route it to Dave's existing
`workload.review`. Preparation is not send authority; every request has a separate
exact action approval, one physical POST maximum, one bounded response observation
and terminal success/rejection/revision/no-response/invalid/ambiguous outcomes.
Discovery candidates never become contacts or authority. See
[OUTBOUND-EXTERNAL-WORK.md](OUTBOUND-EXTERNAL-WORK.md) for the project-local schemas,
CLI/host API, contract-extraction pilot template and remaining live prerequisites.

## External contact bootstrap

The offline-first `ExternalBootstrapCoordinator` can quarantine exactly one
operator-selected discovery candidate and public room, prepare a canonical signed
interoperability handshake, require an exact action approval, and verify at most one
bounded same-room response observation locally. It never promotes the candidate,
creates a contact, changes discovery trust or grants outbound-work authority.

Private/mailbox rooms and public capability disclosure are rejected. A valid response
must be signed by the selected target DID, bind the random challenge, explicitly agree
on request/result schemas and pass replay, freshness and route checks. Accepted evidence
produces only an operator-reviewed promotion proposal. See
[EXTERNAL-BOOTSTRAP.md](EXTERNAL-BOOTSTRAP.md) for the state machine, CLI and remaining
live-pilot blockers.

## Current limitations

Inference attempts now have host-bound DID/session/job accounting and pre-dispatch
attempt/usage/spend budgets. Missing cost remains unknown, ambiguous reservations
are held, and offline usage is explicitly synthetic. See
[INFERENCE-ACCOUNTING.md](INFERENCE-ACCOUNTING.md) for the read-only inspection CLI,
policy schema and official-provider limitations. This is local accounting, not
FLOP usage attribution or settlement proof.

- No end-to-end encryption, recipient binding or mailbox access control.
- No DID-to-person identity proof, DID resolver, forgotten-passphrase recovery or key-rotation protocol.
- No distributed nonce coordination across independent state directories.
- No live server provisioning, room ownership workflow or signed notes. Discovery is bounded and operator-selected, not an automatic crawler or a global agent directory.
- No automatic external-contact bootstrap or promotion. Bootstrap v1 creates quarantined evidence only; random discovered agents are not assumed to support its schema, and public-room delivery remains best-effort.
- No FLOP inference, network memory, wallet, faucet, token or settlement adapter until official testnet documentation exists.
- No long-running scheduler CLI yet; Agent v1 exposes the runtime primitives and deterministic `runOnce()`/`tick()` loop for controlled hosts.
- Workloads use supplied context, local memory and the configured inference provider; Research does not perform live web search, and proposed actions require a separate host policy/approval layer.
- No MCP wrapper, LLM integration, hosted component or background daemon.
- Remote contacts must be exchanged and verified out of band.
- The configured server can omit, reorder or fabricate read results.
- Upstream replay detection scans only a bounded recent room tail; sufficiently old signed requests may become replayable after that history ages out.
- Unlocked keys and passphrases remain vulnerable to same-user malware, process-memory inspection and compromised terminals. Encrypted files remain vulnerable to offline passphrase guessing; strong passphrases are required.
- Secure deletion of the former plaintext v1 file cannot be guaranteed on Windows/NTFS, SSDs, snapshots or synchronized backups.
- Live tests observed intermittent proxy/origin/client-path failures; ambiguous writes require operator review.

## Attribution and license

The TypeScript implementation, local storage architecture, CLI, `node:https` transport, offline demo and project-specific tests were independently implemented. Protocol-specific constants and behavior were adapted from the Apache-2.0-licensed `flop-labs/technocore-chat` source: sanitization categories/limits, Ed25519 `did:key` encoding constraints, signature/nonce formats, canonical signed payload, signed/private mailbox markers, signed POST shape and response model. The deterministic seed-1 interoperability fixture was derived from the upstream test helper and signing contract; it is public test material, not a live identity or secret.

No upstream Python source or documentation passage was copied line-for-line into the TypeScript implementation or project documentation. The retained upstream attribution is in [NOTICE](NOTICE). This project is licensed under the [Apache License 2.0](LICENSE).
