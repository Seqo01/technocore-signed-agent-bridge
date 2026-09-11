# Local Dashboard v1

A localhost-only view and control surface for the existing standalone **offline**
swarm. Codex, cloud services, remote fonts and browser extensions are not needed.
There is no new scheduler, agent, inference provider or external-work protocol.

## Run from PowerShell

Use Node.js 22+ and the already installed project dependencies:

```powershell
npm.cmd run dashboard -- --session YOUR_EXISTING_SESSION_ID
```

For a new session, first prepare an offline policy through the existing CLI using
an unused session id (this explicitly writes a local policy, not a dashboard action):

```powershell
node .\dist\src\cli.js swarm:policy .\.technocore\dashboard-policy.json --session dashboard-v1 --flow bob
npm.cmd run dashboard -- --policy .\.technocore\dashboard-policy.json
```

The five existing identities, profiles and mailboxes must already exist. The
dashboard never creates or rotates them. A multi-role policy still needs the
existing directional contact bindings; it never creates contacts implicitly.

Open **http://127.0.0.1:4317**. An optional `--port 4318` changes the port, never the
host. Keep the launching PowerShell terminal open. Opening the dashboard starts
only its HTTP server: it does not start/resume a swarm or execute a task.

## Lifecycle and secrets

- **START** opens the selected new policy through `SwarmSessionSupervisor.start`.
- **PAUSE** pauses dispatch at the existing runtime intake boundary; an already
  in-flight bounded operation finishes. PAUSE/continue use the same durable control
  markers as the standalone CLI, so they cannot interrupt submission acceptance.
- **RESUME** continues a paused session, or explicitly reopens the same stopped/
  halted session using the original authority and existing recovery semantics.
- **STOP** requests the existing clean runtime stop. The dashboard stays open so
  results remain inspectable. Ctrl+C outside an unlock prompt stops the dashboard
  and its owned runtime. Closing a browser tab does **not** stop the runtime.
- START and stopped-session RESUME request the five existing identity passphrases
  **only in the server's hidden interactive terminal prompt**, not in a browser,
  command argument, environment variable or HTTP request. This preserves current
  runtime behavior even for Bob-only tasks. During unlock, cancel with Ctrl+C in
  that prompt; then inspect the displayed state. No automatic start retry occurs.
- A session owned by a different CLI process is inspectable, not controllable by
  this dashboard. Stop it in its owning terminal before dashboard RESUME.
- Expired sessions stay readable, but the existing runtime rejects reopening with
  expired authority. No automatic extension, new identity or replacement session.

## Tasks and results

Enter an objective, 1–8 acceptance criteria, optional bounded source and explicit
role flow. Or select a local JSON task with `objective`, `acceptanceCriteria`,
`flow`, and optional inline `source`. Import only fills the form; **Queue task**
is the explicit submission. The browser does not accept `sourceFile` or expose
arbitrary server paths. Inline any source before import. Do not load secret files.

The CLI and dashboard share `queueOperatorTask`: identical submissions keep the
same id and use the runtime's durable, idempotent intake. Paused sessions may queue
work but do not dispatch it until resumed. Existing schema, size, scope, expiry,
inference budget and replay constraints still apply. No task is invented by the UI.

Jobs expose persisted task/result/provenance through the existing `operatorView`.
Owned-session reads and local intake share the runtime's existing serial queue,
including shutdown checkpoints. During a lifecycle operation, the UI labels the
operation in progress and retains its last safe projection instead of racing disk
writes. It does not invent intermediate progress or retry failed persistence.
Reopen does not rerun completed work. Existing offline cross-peer delivery recovery
limitations remain: unavailable in-memory mailbox history is blocked, not replayed.

## What the numbers mean

All counters are **selected-session** projections, not lifetime totals. Queued,
completed and failed counts describe task nodes; pending intake describes durable
submission files. Revision counts come from recorded reviews. Inference counts
come from the existing ledger, not a timer. External-job count is session-scoped;
Dashboard v1 does not start external intake or send external work.

Mock/deterministic inference is labeled **TESTING ONLY** throughout. Completed
means the runtime completed a test-provider task, not that it did real research or
that Dave independently established truth. No uptime, earned tokens, FLOP spend,
real inference or network verification is fabricated. Activity is the latest 20
journal records; the job list displays the latest 50 (CLI can inspect older jobs).

## Local boundary

No authentication/accounts are added. The server binds only `127.0.0.1`, pins Host,
rejects foreign Origin / cross-site fetches, and requires same-origin JSON plus a
custom header for mutations. It serves only bundled assets and allowlisted APIs,
with no CORS, framing, caching, file browser or raw-state endpoint. Existing secret
checks apply to task input and output. Exceptions and raw input are not echoed.
This is not protection from malware, privileged extensions or another program
running as your local user. Never forward the port or expose it through a proxy.

The browser refreshes local status every two seconds while visible; errors disable
controls until explicit Refresh state. This is local UI refresh, not Technocore
polling. No Technocore/FLOP network requests are available in Dashboard v1.

## Validation

```powershell
npm.cmd run test:dashboard
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Tests generate isolated encrypted identities and use loopback HTTP only. They
cover lifecycle/resume, persisted results, deduplication, paused intake, policy
scope, secret handling, request bounds and the localhost browser boundary.
