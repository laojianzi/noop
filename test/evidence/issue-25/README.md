# Offline coordinator backup and restore

`report.json` records the Linux x86_64 run at source revision `d206e39`.
The isolated coordinator had no running primary. The test created two file
versions, a message and an image, stopped the coordinator, backed it up, and
restored it to a new Noop home. It verified the original machine credential,
TOTP login, VAPID keys, runtime and Noop configuration, file history, exact
image bytes, and synchronization to a new execution host.

It checked restrictive backup permissions, refusal while the coordinator is
running, preservation of existing destinations including dangling links,
corrupt backup rejection and unsupported format rejection. A separate test
changed the namespace key and recomputed its checksum; restore correctly
rejected the mismatch with the database directory. `namespace-before-report.json`
shows that this mismatch was accepted before the validation was added.
`backup-before-report.json` records the missing backup command before work.

The backup uses the existing coordinator lock and the existing Worker data,
without a second storage engine or archive format. Files and directories are
synced before the atomic rename. Earlier forced-power-off evidence for the
underlying local filesystem is in `test/evidence/issue-17`; a backup-specific
power-off experiment was not run. No production data was used.

The full existing suite passed 290 tests with one macOS-only skip, and the
unchanged fleet-day budget remained below its target. The earlier real-Web and
orphan-lock coordinator regression passed. See `test/self-hosted-acceptance.md`
for the repeatable scenario. Verify with `sha256sum -c SHA256SUMS` here.
