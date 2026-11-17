# Upstream synchronization evidence

The local coordinator branch was merged with fork `main` at
`4c2a3d246e21a4b7ee39a2f13e3a5e965eda87d5`. This integrated candidate is
`31a8d523e5d34656d34473bf149c8170a6b4c7b3`. Later evidence-only commits do
not change the product code. `metadata.json` records the Web bundle, workerd,
and NSH versions and checksums.

The merge keeps all three behaviors:

- In cloud mode, the configured deployment host deploys. If none is configured,
  the primary remains the default. A different primary does not deploy.
- In local mode, neither a normal update nor an owner-requested update deploys
  to Cloudflare, even when the current host is the designated cloud deployer.
- The Web client accepts an incomplete status before the first primary
  snapshot. It also routes demo status through the in-app demo hub.

| Evidence | Result |
| --- | --- |
| `before` and `red.log.gz` | Before the merge, the old primary deployed despite another configured deployment host. The test used a synthetic `bunx` command. |
| `linux-x64` and `final-routing.log.gz` | The integrated candidate passed direct and owner-requested update routing, Web login, local sync and a demo status check. |
| `guard-ablation` | Removing the local-mode guard from `src/setup.ts` made the local-update check fail. `guard-ablation.patch.gz` records the change. |
| `demo-ablation` | Replacing `hubFetch` with `fetch` in status loading made the browser request `http://demo/api/status`. `demo-ablation.patch.gz` records the change. |
| `network-kvm` | A coordinator in a KVM guest and container hosts retained the push key and synchronized work after a forced guest stop and restart. |
| `messages`, `smtp`, `push` | Real Web messaging, controlled Mailpit SMTP and a controlled Web Push receiver passed on the same product code. |
| `cloud-budget`, `cloud-mcp.log.gz` | Isolated Wrangler passed the cloud-mode budget and MCP regressions. No hosted Cloudflare deployment was tested. |
| `nsh-demo.xml` and `nsh-demo.log.gz` | All six upstream demo tests passed on the headless NSH host. |

The actual Web test injects a synthetic, existing demo session into isolated
browser storage. The coordinator-served Web login does not offer the App Store
test-account shortcut. The separate NSH app tests exercise that native-app
login. All other test homes, tokens and data are synthetic.

The full x86_64 Web, messages, SMTP and push runs use `397cb2a`; the final
routing run uses `31a8d5`. The KVM run uses `d223d3d`. The only later changes
between those commits are to `test/self-hosted-e2e.ts`; product code is the
same. The Web bundle was built from product source `a74449a` using the pinned
NSH nightly in `metadata.json`.

The first daemon fixture failed because it lacked the normal initialized data
directories. A second fixture used a full revision where the daemon expected a
short revision. Both fixture corrections are in the test history. A first Web
demo attempt assumed that the served page enabled direct demo sign-in; the
passing test instead exercises a saved demo session. These were test fixture
failures, not evidence of coordinator failures.

The [self-hosted acceptance instructions](../../self-hosted-acceptance.md)
cover prerequisites and commands. Run `bun test/self-hosted-e2e.ts` with the
real Web bundle, pinned workerd, Chromium and Playwright paths documented
there. The network test has a separate KVM fixture. Run the upstream native
app tests with `nsh test app/demo.test.tsx`. The original reports passed their
own `SHA256SUMS` before selection. Logs here are losslessly compressed.

```sh
cd test/evidence/issue-27-upstream-sync
sha256sum -c SHA256SUMS
```
