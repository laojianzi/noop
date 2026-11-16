# Candidate acceptance evidence for issue 14

The end-to-end run used source revision `c68e57af47265ef04204c5a7244f7208f18a2356`.
See `report.json` for the platform, artifact hashes and individual checks.
`web-login.png` shows the real Web client after login with synthetic credentials.

Run `test/self-hosted-e2e.ts` as described in `test/self-hosted-acceptance.md`.
The run creates an isolated directory and prints its location. To repeat the asset
ablation using that directory, set `NOOP_E2E_ABLATION_CONFIG` to its
`primary/coordinator/workerd.capnp`, and set `NOOP_E2E_WEB_ASSETS` to its
`repo/app/dist/web/noop`. Set `NOOP_E2E_WORKERD` to the pinned binary, then run
`bun test/evidence/issue-14/assets-ablation.mjs`.

The Web bundle was the checksum-verified upstream release `v0.3.18`, not a build
of this source revision. The update test simulates Git and the install/test
commands. Browser requests outside the test origin were blocked; the operating
system network was not disconnected. These checks do not establish the full
offline installation, upgrade or cross-platform release gates.

The cloud build log is a Wrangler dry run against an isolated copy. The email
check used Wrangler's simulated email binding. Neither is a cloud deployment or
real mail delivery. The existing budget simulation reported 7,595 requests and
approximately 15,427 written rows, each below the unchanged 20,000 target.

`service.log` includes expected rejected-deployment errors from negative cases.
All credentials and data in these artifacts are synthetic. Verify their hashes
with `sha256sum -c SHA256SUMS` from this directory.
