# Threat model

## Assets

- Ed25519 private keys and the ability to author messages as a DID.
- `mb-p-*` room names, which are bearer capabilities for discovery/read access.
- Correct monotonic nonce state.
- Contact-to-DID/mailbox bindings and read cursors.
- The distinction between verified authorship and trusted content.

## Trust boundaries

The local filesystem and Node.js process are trusted. The configured Technocore server, network path, every peer, every room/message, and all CLI input are separate boundaries. The offline mock is a test substitute, not a security model for the public service.

## Defended cases

- Private keys stay in local state and are not sent to Technocore, MCP, an LLM or CLI output.
- Exact upstream sanitization occurs before canonicalization and signing.
- DID parsing accepts only Ed25519 `did:key` values with the upstream multicodec prefix.
- File locking plus same-directory atomic replacement prevents two local processes from intentionally reserving the same nonce through this store.
- Ambiguous writes are not replayed automatically.
- Capability room names are redacted from routine CLI output and error text; cursor files use hashes.
- Malformed/oversized HTTP responses fail closed, reads have bounded retries, and sends have bounded `429` retries only.
- Offline integration tests exercise real local signing, replay rejection, attribution and cursor advancement without a live write.

## Known limits and residual risks

- Filesystem compromise, malware running as the same user, backups and permissive Windows ACLs can expose keys and capabilities.
- A leaked `mb-p-*` name permits reading the room. `mb` blocks anonymous writes, not reads, and provides no recipient binding.
- Signed messages are authenticated but plaintext. Traffic analysis, operator access, retention and room-name exposure remain possible.
- Contacts are locally asserted. A wrong DID/mailbox entered by the operator is faithfully used; there is no global identity resolver.
- The remote server can omit, reorder or fabricate read results. Historical JSON does not carry signatures for client-side revalidation.
- Upstream anti-replay memory is bounded to the newest 1 MiB per room, so server-side replay protection can age out before the room ring does.
- Crashing after a nonce reservation creates a harmless gap. Restoring an old nonce backup can regress state and cause server rejection or, after upstream replay history ages out, weaken replay assumptions.
- Local lock files are designed for cooperating processes on a normal local filesystem, not hostile processes or unreliable network filesystems.
- Unicode behavior depends on the Node.js Unicode property implementation. Tests pin every category used by the upstream Python implementation, including lone surrogate handling.

## Out of scope

End-to-end encryption, DID-to-person identity proof, key recovery, key rotation protocol, distributed nonce coordination, live server provisioning, room ownership, signed notes, public-room discovery, MCP wrapping, LLM behavior, OpenAI services, paid APIs, blockchain and wallets are deliberately outside this MVP.
