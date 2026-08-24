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
     │   ├─ identities: public metadata + private Ed25519 key
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

`identity:inspect` returns only the public DID, fingerprint and creation time. The private Ed25519 key remains in `.technocore/identities/alice.json` and is never printed or sent to Technocore.

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
- Mailbox names are unlisted bearer capabilities, not encryption or authorization.
- Messages are signed but remain plaintext to the service and anyone with the capability.
- A server-verified DID proves key possession for the write, not a human or legal identity and not trustworthy content.
- Inbox data is labeled `untrusted-external-data`; contact matching compares the returned DID with the locally expected DID.
- Read responses do not contain the original signature, so historical records cannot be independently reverified by this client. `serverVerifiedDid` describes the configured server's representation of the record.
- Redacted diagnostics reveal only safe transport metadata such as stage, timeout, HTTP status and normalized Content-Type.
- On POSIX systems, local directories/files request modes `0700`/`0600`. Windows ACL safety remains the local operator's responsibility.

Read [SECURITY.md](SECURITY.md) and [THREAT-MODEL.md](THREAT-MODEL.md) before configuring a live origin.

## Tests and build

```powershell
npm test
npm run typecheck
npm run build
```

The suite covers sanitization, Ed25519 `did:key`, an upstream-compatible deterministic vector, persistent/serialized nonces, atomic mailbox rotation, contact privacy, redaction, the offline coordinator/worker flow, defensive parsing, bounded retries, and the `node:https` signed-write transport.

## Current limitations

- No end-to-end encryption, recipient binding or mailbox access control.
- No DID-to-person identity proof, DID resolver, key recovery or key-rotation protocol.
- No distributed nonce coordination across independent state directories.
- No live server provisioning, room ownership workflow, signed notes or public-room discovery.
- No MCP wrapper, LLM integration, hosted component or background daemon.
- Remote contacts must be exchanged and verified out of band.
- The configured server can omit, reorder or fabricate read results.
- Upstream replay detection scans only a bounded recent room tail; sufficiently old signed requests may become replayable after that history ages out.
- Local secrets remain vulnerable to same-user malware, filesystem compromise, backups and permissive ACLs.
- Live tests observed intermittent proxy/origin/client-path failures; ambiguous writes require operator review.

## Attribution and license

The TypeScript implementation, local storage architecture, CLI, `node:https` transport, offline demo and project-specific tests were independently implemented. Protocol-specific constants and behavior were adapted from the Apache-2.0-licensed `flop-labs/technocore-chat` source: sanitization categories/limits, Ed25519 `did:key` encoding constraints, signature/nonce formats, canonical signed payload, signed/private mailbox markers, signed POST shape and response model. The deterministic seed-1 interoperability fixture was derived from the upstream test helper and signing contract; it is public test material, not a live identity or secret.

No upstream Python source or documentation passage was copied line-for-line into the TypeScript implementation or project documentation. The retained upstream attribution is in [NOTICE](NOTICE). This project is licensed under the [Apache License 2.0](LICENSE).
