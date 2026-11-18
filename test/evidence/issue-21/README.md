# Local Web message and attachment acceptance

`report.json` records the Linux x86_64 run at source revision `ab3225c`.
Two independent Chromium Web sessions used the real local coordinator with
isolated credentials and data. The test selected an image in the real Web UI,
checked live WebSocket delivery and access control, and checked image type and
size limits. It interrupted the service and one browser's network, sent a
message while that browser was offline, then verified automatic catch-up, live
messages, and the original attachment after restart.

The browser used the genuine upstream Web bundle v0.3.18. This is not a build
of the current source tree. Native desktop and mobile clients were not tested.
No product code change was needed for this slice. See
`test/self-hosted-acceptance.md` for the reproducible scenario.

Verify these artifacts with `sha256sum -c SHA256SUMS` from this directory.
