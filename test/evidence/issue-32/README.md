# Long coordinator home acceptance

The coordinator failed to start when its absolute health socket address exceeded the Unix socket limit. The fixed workerd binds `health.sock` relative to the coordinator directory. The socket and its permissions stay in that directory. Bun clients keep their existing absolute address.

The test commit `b77744c` predates the fix. The candidate is `dee518c`. The remote probe `efa4b79` has identical `src`, `cloud` and `test` trees; it adds a temporary CI workflow. `metadata.json` records versions and artifact digests. All data and credentials in these runs are synthetic.

| Evidence | Result |
| --- | --- |
| `local-red`, `red-linux-*` | The old code fails to start with a long home. On both Linux architectures the systemd journal reports the Unix socket length error. |
| `local-backup`, `local-ingress`, `local-core` | The candidate passes long-path backup and restore, normal ingress and authentication, and the real Web and host flow on Linux x86_64. |
| `green-linux-*` | On native x86_64 and ARM64 runners, offline service install, upgrade to workerd 2026-11-16, failure recovery and rollback pass. The test uses relative source and runtime arguments. |
| `green-macos-x86_64` | Long-path deployment, backup and restore pass on a native macOS Intel runner. |
| `bun-test.log.gz`, `project-e2e.log.gz` | The root suite passes 318 tests with one skip. The fleet budget simulation reports 7,595 requests and about 15,427 rows written against the unchanged 20,000 targets. The existing project E2E passes. |
| `ablation.patch.gz` | An earlier candidate added a health-check wrapper and changed the CLI process directory. Removing that code still passes the checks above, so the final fix changes only workerd's address and working directory. |

The [red run](https://github.com/laojianzi/noop/actions/runs/44093301622) and [green run](https://github.com/laojianzi/noop/actions/runs/44094560119) use the included compressed probe workflows. A first probe expected the underlying error in the CLI output, but systemd only reported that the service did not become ready. The red workflow was corrected to also collect and check the journal. No product behavior was changed for that correction.

To repeat the local long-path case, supply the pinned workerd and a real Web bundle, then run `bun test/self-hosted-backup-e2e.ts`. The test creates a long isolated home itself. The Linux service update test requires a disposable host and `NOOP_E2E_DISPOSABLE=1`; see `test/self-hosted-acceptance.md`. Verify the selected reports and logs with `sha256sum -c SHA256SUMS` in this directory. The original per-run manifests passed before selection.
