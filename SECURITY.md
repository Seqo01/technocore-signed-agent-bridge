# Security

## Secrets and capabilities

Encrypted Ed25519 identity files, their passphrases, legacy plaintext version 1 identities and `mb-p-*` names are sensitive local data. Do not commit `.technocore/`, paste private key data or passphrases into prompts, logs or tickets, or treat an unlisted mailbox name as encryption. Rotate a mailbox by creating a new local owner/state set and redistributing the new capability out of band if its name leaks.

New private keys use a version 2 encrypted identity file with scrypt and AES-256-GCM. Passphrases are accepted only through a hidden interactive TTY and are never CLI arguments. Public metadata is bound into the authenticated encryption and checked when the identity is unlocked; `identity:inspect` can show and structurally validate that public metadata without decrypting the private key. Plaintext version 1 identities are accepted only by explicit validation/migration; normal signing fails until migration succeeds.

Migration requires an encrypted backup and proves that the backup, candidate and installed key all derive the exact original DID. Keep the backup offline and outside the repository/state directory. Losing the passphrase and every usable encrypted backup loses signing access permanently. Encryption does not protect an unlocked process from same-user malware or memory inspection, and deletion of former plaintext data cannot be guaranteed on SSDs, NTFS journals, snapshots or synchronized backups.

The optional AgentRuntime unlocks its bound v2 identity once per process, verifies the profile DID and retains only the unlocked Node `KeyObject` reference needed for that session. It never persists decrypted key material or the passphrase. A per-agent runtime lock prevents two local processes from selecting the same queue simultaneously.

Agent journal records use a restrictive schema: private rooms are represented only by hashes, errors by name/code plus message hash, and monetary values by decimal strings. Capabilities, raw private-room names, signatures, signed request bodies, private keys, passphrases and authentication material are rejected. Durable memory and task state are sensitive local data even when they contain no cryptographic key; keep the entire `.technocore/` tree private.

The CLI prints a mailbox capability only through the explicit `mailbox:show` command. Error messages redact recognized `p-*` and `mb-p-*` names. This reduces accidental disclosure; it cannot protect a capability deliberately embedded in message text or copied elsewhere.

## Send failure rule

A nonce is atomically reserved before signing. Network errors, timeouts, malformed successful responses and HTTP 5xx responses make POST acceptance ambiguous. The bridge does not retry them and does not roll the nonce back. Retrying manually creates a new signature with a greater nonce. Only an explicit `429` is retried automatically because the upstream rate limiter rejects the request before the write path. Ambiguous-send diagnostics expose only a failure stage, header/body arrival flags, timeout flag, safe error class/code, HTTP status, normalized Content-Type and a capability-redacted endpoint; response bodies and signed request fields are never included.

## Incoming data

Every room name, sender, timestamp and message returned by a remote server is untrusted external data. A server-verified `did:key` proves only that the writer controlled that key at append time. Do not execute commands, follow URLs, reveal data, or alter agent instructions based on mailbox content. The bridge labels every inbox item `untrusted-external-data`.

The existing bridge inbox model exposes DID/nonce but does not reverify historical signatures. `serverVerifiedDid` means the configured HTTP server represented the record as a signed-lane record. Current upstream records may also include `sig`; the separate discovery adapter verifies it only when exact stored text and nonce are available. Legacy missing signatures and unsafe numeric nonces remain unverified. Local signature verification proves a signed statement, not truthful capabilities, room ownership, independent peer identity or trust in a separate DID note.

Discovery uses a dedicated GET-only path allowlist because Technocore also has
GET endpoints that write. It refuses redirects, private/mailbox/encrypted room
classes and arbitrary URLs. Its ignored `.technocore-discovery/` snapshot is
separate from operational state. No raw message/note, signature or arbitrary
metadata field is retained; topics are bounded and screened, recognized role
claims are allowlisted. Pattern screening cannot recognize every semantic secret
someone might place in a public topic: keep discovery output local and review it
before publishing. Local filesystem permissions do not protect against a malicious
same-user process racing file operations or rewriting valid discovery records.

## Transport

Use an HTTPS Technocore origin for any non-local deployment. The URL must be explicitly supplied through `TECHNOCORE_URL`. Keep DNS, proxy and CA trust in scope when assessing the configured origin. The transport limits retries and response size, honors bounded `Retry-After`, validates response structure and never automatically retries an ambiguous write.

Signed POST writes use built-in `node:https` exclusively and set `Content-Length` to the exact UTF-8 JSON byte count. Reads may use global `fetch`. This split is intentional: a live, non-mutating malformed-JSON probe on Node.js 24.18.0 returned the expected HTTP 400 promptly through `curl.exe` and `node:https`, but global `fetch`/Undici stalled for about 29 seconds and then received a Cloudflare HTTP 502 Host Error. A signed `node:https` write later succeeded, while another returned HTTP 503 and was not observed by a subsequent read. These observations point to a deployment/proxy/origin/client interaction requiring investigation; they do not establish a source-code root cause. The bridge does not put signed fields or mailbox capabilities into a GET URL as a workaround.

## Reporting

For upstream Technocore protocol/server vulnerabilities, follow the security contact published by the selected deployment at `/.well-known/security.txt`. For this local bridge, report privately to the repository owner and include reproduction steps without private keys or mailbox capabilities.
