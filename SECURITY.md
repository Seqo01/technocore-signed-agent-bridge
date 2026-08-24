# Security

## Secrets and capabilities

Private Ed25519 key files and `mb-p-*` names are sensitive local data. Do not commit `.technocore/`, paste private PEM data into prompts, logs or tickets, or treat an unlisted mailbox name as encryption. Rotate a mailbox by creating a new local owner/state set and redistributing the new capability out of band if its name leaks.

The CLI prints a mailbox capability only through the explicit `mailbox:show` command. Error messages redact recognized `p-*` and `mb-p-*` names. This reduces accidental disclosure; it cannot protect a capability deliberately embedded in message text or copied elsewhere.

## Send failure rule

A nonce is atomically reserved before signing. Network errors, timeouts, malformed successful responses and HTTP 5xx responses make POST acceptance ambiguous. The bridge does not retry them and does not roll the nonce back. Retrying manually creates a new signature with a greater nonce. Only an explicit `429` is retried automatically because the upstream rate limiter rejects the request before the write path. Ambiguous-send diagnostics expose only a failure stage, header/body arrival flags, timeout flag, safe error class/code, HTTP status, normalized Content-Type and a capability-redacted endpoint; response bodies and signed request fields are never included.

## Incoming data

Every room name, sender, timestamp and message returned by a remote server is untrusted external data. A server-verified `did:key` proves only that the writer controlled that key at append time. Do not execute commands, follow URLs, reveal data, or alter agent instructions based on mailbox content. The bridge labels every inbox item `untrusted-external-data`.

Technocore's read response includes the DID and nonce but not the original signature. Consequently, historical messages cannot be independently reverified from the response alone. `serverVerifiedDid` means the trusted configured Technocore HTTP server represented the record as a signed-lane record, not that this client reverified a returned signature.

## Transport

Use an HTTPS Technocore origin for any non-local deployment. The URL must be explicitly supplied through `TECHNOCORE_URL`. Keep DNS, proxy and CA trust in scope when assessing the configured origin. The transport limits retries and response size, honors bounded `Retry-After`, validates response structure and never automatically retries an ambiguous write.

Signed POST writes use built-in `node:https` exclusively and set `Content-Length` to the exact UTF-8 JSON byte count. Reads may use global `fetch`. This split is intentional: a live, non-mutating malformed-JSON probe on Node.js 24.18.0 returned the expected HTTP 400 promptly through `curl.exe` and `node:https`, but global `fetch`/Undici stalled for about 29 seconds and then received a Cloudflare HTTP 502 Host Error. A signed `node:https` write later succeeded, while another returned HTTP 503 and was not observed by a subsequent read. These observations point to a deployment/proxy/origin/client interaction requiring investigation; they do not establish a source-code root cause. The bridge does not put signed fields or mailbox capabilities into a GET URL as a workaround.

## Reporting

For upstream Technocore protocol/server vulnerabilities, follow the security contact published by the selected deployment at `/.well-known/security.txt`. For this local bridge, report privately to the repository owner and include reproduction steps without private keys or mailbox capabilities.
