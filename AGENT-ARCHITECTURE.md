# FLOP-ready Agent v1 architecture

The agent layer is deliberately separate from the Technocore bridge. The bridge remains responsible for sanitization, signing, persistent nonces, contacts, cursors and transport. The agent owns durable work state, memory, evidence and lifecycle orchestration.

No FLOP testnet API is assumed in v1. `InferenceProvider` and `MemoryProvider` are the adapter boundaries; only deterministic offline inference and local durable memory are implemented.

## Identity lifecycle

`agent:init <existing-identity>` opens an existing encrypted v2 identity, verifies its private/public key relationship and stores only the identity alias and DID in the agent profile. It never creates or rotates an identity.

At runtime startup, the selected identity is unlocked once. Its derived DID must exactly match the profile DID. The resulting Node `KeyObject` is retained only by that `AgentRuntime` instance and reused for signed work. Shutdown releases the reference; the passphrase is never stored in agent state, argv, environment, memory or journal. Node/OpenSSL cannot guarantee immediate physical erasure of all internal key copies.

## Durable files

Each agent uses `.technocore/agents/<identity-alias>/`:

- `state.json`: versioned profile, goals, tasks, queue, sessions, checkpoints, revision and runtime status.
- `journal.jsonl`: append-only, idempotent activity/evidence entries.
- `memory.json`: deterministic local durable memory records.
- `runtime.lock`: single-process execution lock, removed on clean shutdown and recoverable after a dead process.

All writes use the bridge's private-directory, atomic-write and file-lock primitives. The entire `.technocore/` tree remains Git-ignored.

## Task and recovery model

Task states are `pending`, `running`, `succeeded`, `failed`, `ambiguous` and `cancelled`. Every task has an idempotency key, bounded attempt count, timestamps, a latest checkpoint, checkpoint history and safe result/error references.

Startup recovers interrupted tasks according to their last durable checkpoint:

- before any possible external effect: return to `pending`;
- after an inference or action intent that may have spent or written: become `ambiguous` and require review;
- confirmed tasks are never replayed.

The v1 safe task set is intentionally small: deterministic inference, local memory writes, signed contact/public-room sends and storage of inbound messages as untrusted data. There is no arbitrary shell execution and inbound text is never interpreted as a command.

## Evidence and privacy

Journal entries may record DID, session/task identifiers, event/outcome, provider/model IDs, decimal-string usage/spend metadata, latency, public room references, private-room hashes, result hashes, memory-write hashes and hashed safe errors.

They cannot contain mailbox capabilities, raw private-room names, signatures, signed request bodies, passphrases, private keys or authentication material. Private inbox content remains in ignored local task state when persistence is necessary; only its hash appears in the journal.

## Inbox acknowledgement

Autonomous ingestion uses an explicit sequence:

1. peek without changing the cursor;
2. persist each message as an idempotent `inbound.message` task;
3. append an idempotent journal event;
4. advance the cursor only through the highest successfully persisted message.

A crash before step 4 causes safe re-ingestion without duplicate tasks. Retention gaps are journaled without exposing the mailbox name.

## Future FLOP boundary

The provider metadata model reserves only generic fields: provider, model, provider session/result IDs, asset, decimal spend amount, network, latency and usage. Faucet, wallet, token, settlement and FLOP inference implementations must wait for official testnet documentation.
