# Local guest acceptance

`report.json` records the Linux x86_64 run at source revision `acad08e`.
The coordinator and guest CLI used real HTTP with isolated Noop homes. The test
covered one-time invitations, separate guest credentials, task and owner-data
isolation, result submission, service restart, acknowledgment and revocation.

The guest process used a synthetic Codex executable that returned a fixed
result. The test did not call a real model. It expired one synthetic invitation
by updating the stopped test database, then checked rejection through the real
join API after restart. No production code change was needed for this slice.

Run the scenario using the instructions in `test/self-hosted-acceptance.md`.
Verify these artifacts with `sha256sum -c SHA256SUMS` from this directory.
