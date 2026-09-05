# Outbound external work

`OutboundExternalWorkCoordinator` is a bounded, one-shot local-to-external work
lifecycle. It is not discovery, contact exchange, a marketplace, a daemon or an
automatic trust mechanism. Alice is not a relay: Bob, Charlie, Dave or Eve can be
the requester, and Dave remains the reviewer.

## Preconditions

- The requester identity, role and response mailbox already exist locally.
- Dave's existing identity is bound to the reviewer role.
- The external DID is not one of the five local swarm DIDs.
- An operator-managed contact already binds the requester to the exact external
  DID and private mailbox. Discovery candidates and DID notes cannot create it.
- The operator has separately reviewed evidence that the peer knows the reciprocal
  response route and supports the project-local request/result schemas. Only hashes
  of those reviews enter the job record.

There is no safe remote-contact import command yet. The existing lower-level
`contact:add` form puts a mailbox capability in process arguments. Obtain and store
external contact material through a separately reviewed, secret-safe local path;
never derive it from discovery output.

## Lifecycle and authority

The durable record binds requester/reviewer/target DIDs, contact and response-route
hashes, objective, normalized workload input, input/output schemas, request hash,
action/effect hashes, authority evidence, deadline, response and review references.
It contains no mailbox capability or private key.

`requestPayloadHash` is SHA-256 over the canonical request-envelope object before
that hash field is inserted. The full canonical JSON text has a separate internal
transport payload hash bound to the exact action approval. The response echoes the
former; the signature authenticates the exact latter text sent to the peer.

```text
PREPARED -> AUTHORIZED -> SENDING -> SENT -> AWAITING_RESPONSE
  -> RESPONSE_RECEIVED -> REVIEW_PENDING
  -> SUCCESS | REJECTED_RESULT | REVISION_REQUIRED

AWAITING_RESPONSE -> NO_RESPONSE | INVALID_RESPONSE
SENDING -> DELIVERY_REJECTED | AMBIGUOUS_DELIVERY
```

Preparation only proposes an exact `ActionApprovalStore` action. Authorization must
name its exact action hash. The binding is checked before nonce reservation and
again immediately before dispatch. The coordinator configures signed HTTP POST with
`rateLimitRetries: 0`; its physical POST budget is one. A complete 4xx is
`DELIVERY_REJECTED`. Timeout, 5xx, reset, malformed receipt or an interrupted
`SENDING` record is `AMBIGUOUS_DELIVERY`. No state creates resend authority.

## Response intake and verification

The response policy permits one explicit bounded mailbox GET (`since` the captured
cursor, `wait=0`, `limit=200`). It is not a polling loop. Exact bounded response
material is first placed in the ignored private intake directory. The coordinator
then requires the external signature and locally verifies Technocore's exact
`room|nonce|text` payload. `serverVerifiedDid` alone is insufficient.

It validates sender, request ID, requester/responder DIDs, workload/version,
request hash, canonical JSON, result hash, sequence/nonce and duplicate/window
rules. Only after durable response linkage does it advance the cursor. Missing or
invalid signatures and all correlation failures become `INVALID_RESPONSE`.
Terminal jobs cannot be reopened by late or repeated responses.

The counterpart's canonical project-local response is:

```json
{
  "version": 1,
  "kind": "external-work-result",
  "requestId": "<original-request-id>",
  "requesterDid": "<original-requester-did>",
  "responderDid": "<exact-target-did>",
  "workloadType": "workload.research",
  "workloadVersion": 1,
  "requestPayloadHash": "<original-request-payload-hash>",
  "status": "completed",
  "output": {},
  "resultHash": "<SHA-256 canonical output hash>",
  "createdAt": "<ISO-8601 time within the response window>"
}
```

`status` can also be `failed` or `declined`. Those attributable responses still go
to Dave; they are not converted into fabricated successful work.

An empty observation remains `AWAITING_RESPONSE` until the deadline. The local
`timeout` transition then records `NO_RESPONSE`; this means only that no valid
response was observed in the authorized retained window. It does not prove the peer
never sent data elsewhere or outside that window.

## Dave review

A valid correlated response is untrusted work, not success. The host `review()` API
creates one idempotent `workload.review` task for the existing Dave identity using
only the supplied request, result, correlation hashes and operator criteria:

- `VOUCH` -> `SUCCESS`
- `REJECT` -> `REJECTED_RESULT`
- `REVISION_REQUIRED` -> `REVISION_REQUIRED`

Review never sends a revision request. The CLI deliberately does not substitute the
deterministic fixture for a configured review provider; production hosts must inject
an explicitly configured inference provider.

## CLI

These commands only operate on an already reviewed job/contact. `prepare` accepts a
bounded local JSON file so no capability is passed in argv. Status/list output omits
the request body, response body, signatures and private rooms.

```powershell
node .\dist\src\cli.js external-work:prepare <request-file>
node .\dist\src\cli.js external-work:status <job-id>
node .\dist\src\cli.js external-work:list
node .\dist\src\cli.js external-work:authorize <job-id> <action-hash>
node .\dist\src\cli.js external-work:send <job-id> <action-hash>
node .\dist\src\cli.js external-work:receive <job-id>
node .\dist\src\cli.js external-work:timeout <job-id>
```

`send` and `receive` require an explicit `TECHNOCORE_URL`; all other commands are
local. Merely building or preparing a request performs no network operation.

The request file contains public task material and hashes, never a mailbox:

```json
{
  "requestId": "contract-extraction-1",
  "requesterAlias": "bob",
  "targetDid": "did:key:<reviewed-external-did>",
  "contactId": "<operator-managed-contact-id>",
  "objective": "Extract three Technocore protocol invariants and three uncertainties from supplied public excerpts",
  "workloadType": "workload.research",
  "workloadVersion": 1,
  "input": {
    "topic": "Technocore signed POST and room-read contract",
    "objective": "Using only the supplied excerpts, extract exactly three protocol invariants and exactly three uncertainties or limitations.",
    "context": "[excerpt-1] <short public excerpt>",
    "sources": [{ "id": "excerpt-1", "title": "Operator-supplied public excerpt" }],
    "outputRequirements": ["Exactly three keyClaims", "Exactly three limitations", "No live web or tool use"]
  },
  "responseDeadline": "<reviewed ISO-8601 time within 24 hours>",
  "responseRouteEvidenceHash": "<64 lowercase hex>",
  "schemaAgreementHash": "<64 lowercase hex>",
  "reviewCriteria": [
    "Exactly three protocol invariants are present",
    "Exactly three uncertainties or limitations are present",
    "Every claim is traceable to the supplied excerpts",
    "No live verification or unsupported source access is claimed"
  ]
}
```

The exported `technocoreContractExtractionTemplate(excerpts)` host helper constructs
the bounded workload-specific portion without reading, persisting or sending it.

## Before a live pilot

No discovered DID is automatically ready. A live pilot still needs an independently
verified reciprocal contact, explicit schema agreement, reviewed public excerpts,
a configured Dave inference provider, a fresh exact action approval and an operator
decision to invoke the single send. This implementation does not provide any of
those facts automatically.
