# Local Web Push acceptance

`report.json` records the Linux x86_64 run at source revision `fd2392a`.
The test authenticated an owner, subscribed a controlled local HTTP endpoint,
verified the VAPID signature and decrypted the real Web Push payload. It then
restarted the coordinator and verified that the same keypair and subscription
still delivered an event. It checked expired subscriptions, a 503 endpoint,
an unreachable endpoint, failure logging, core availability and unsubscribe.

`vapid-before-report.json` records the HTTP 503 result without local VAPID
bindings. The implementation reuses the upstream key generation and file
instead of adding a second key store. The key remains in the Noop home with
restricted permissions and must be included in backups.

The receiving endpoint simulated a push service. No external push service or
physical device was verified. The SMTP regression and the existing RFC 8291,
VAPID and fleet-day budget tests passed. The budget limits were unchanged.
See `test/self-hosted-acceptance.md` for the repeatable scenario.

Verify these artifacts with `sha256sum -c SHA256SUMS` in this directory.
