# Linux native desktop acceptance

`report.json` records the native executable, application bundle, release
archive, workerd and Web bundle hashes. The app and runtime came from the
successful Ubuntu 24.04 [packaging job](https://github.com/laojianzi/noop/actions/runs/43889605230).
That job packaged the application source from revision `2b1a25f`. The test ran
on Linux x86_64 in an isolated Xvfb display, with synthetic accounts and data.

The test signs in before any primary status snapshot exists. It sends a message,
receives a peer's message on its WebSocket, and renders a synthetic primary
snapshot. `requests.log` contains methods, paths and status codes only. The two
PNG files show the native application after those actions. The repeatable
command and prerequisites are in `test/self-hosted-acceptance.md`.

`runtime-before.log` captures the old packaged runtime's missing network stack.
`status-before.log` captures the failure in the previously packaged application
when its first status had no decisions. `runtime-after-ci.log` is the HTTP and
WebSocket check for the fixed executable. These are separate failures with
separate fixes.

`cache-before.log` records a cached CI runtime that produced no test result in
the original five-second window. The updated check waits up to 30 seconds and
ends when it receives the result. The final packaging job passed on a cache hit.
`display-before.log` records one Xvfb display failure; a later run passed with
the same CI package. The test now keeps Xvfb diagnostics on failure.
