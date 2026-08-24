# Live testing record

Live testing was stopped after the observations below. This record intentionally omits IP addresses, mailbox capabilities, signatures, private keys, signed request bodies, private mailbox message text and the test identities' DIDs.

## Environment

- Date: 2026-08-24
- Client: Node.js 24.18.0 on Windows, plus `curl.exe`
- Deployment: `https://technocore.chat`, manifest version 0.7.0
- Protocol reference: `flop-labs/technocore-chat` commit `8bd794b953d7b3fbcff71f4db2e3257f68d144c3`

## Read-only and non-mutating checks

- GET health, manifest and room-read endpoints responded successfully.
- A malformed-JSON POST to `/r/transport-probe` contained no DID, signature or mailbox capability and was guaranteed to fail before a room/message mutation.
- `curl.exe` and built-in `node:https` received the expected HTTP 400 promptly.
- Node global `fetch`/Undici took approximately 29 seconds and received a Cloudflare HTTP 502 Host Error.

This client-path difference does not by itself identify a Technocore source-code defect. It may involve the deployment, proxy, origin, client, or their interaction.

## Signed mailbox checks

1. A signed POST using built-in `node:https` succeeded. The client reported `sent: true` and server sequence 1.
2. The recipient read one message. Its sender DID matched the expected local contact and `serverVerifiedDid` was true.
3. A later signed reply using built-in `node:https` received HTTP 503 with `text/plain`; response headers and body bytes had begun arriving and the request did not time out.
4. A subsequent recipient inbox read returned zero messages, so the failed reply was not observed as persisted.

The successful exchange demonstrates interoperability with the deployed signed POST lane. The later 503 demonstrates intermittent service-path instability and validates the bridge's policy: 5xx sends are not retried automatically, their nonce remains consumed, and their outcome is reported conservatively.

No further live messages should be sent as part of this release preparation.
