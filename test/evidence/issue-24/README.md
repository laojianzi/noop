# Local and cloud budget acceptance

`local-report.json` and `cloud-emulator-report.json` record isolated Linux
x86_64 runs at source revision `4ca2c06`. Each scenario used a real SQLite
database over 500 MB. The local test seeded 21,000 synthetic history rows,
then used HTTP commits and a revert to exercise the 90-day, 20,000-row,
30-version and latest-only rules. Synthetic usage counters exceeded the cloud
shed threshold. Local commits, events and status updates continued; login
security limits still rejected repeated requests and attempts.

The Wrangler development run used the same Worker in cloud mode. It retained
the one-version storage reduction and the original shedding of latest-only
commits, events and dashboard updates. This is not a deployed Cloudflare test.
The existing suite passed 290 tests with one macOS-only skip. The CLI E2E and
the unchanged fleet-day budget simulation also passed.

`history-before-report.json` shows the local 500 MB reduction to one version.
`budget-before-report.json` shows local latest-only commits rejected after the
history fix but before disabling local budget shedding. Both checks therefore
need the small policy changes. No separate local file engine was added.

The scenarios generate their large databases in temporary directories and
remove them after successful runs. See `test/self-hosted-acceptance.md` for the
repeatable commands. Verify these artifacts with `sha256sum -c SHA256SUMS`.
