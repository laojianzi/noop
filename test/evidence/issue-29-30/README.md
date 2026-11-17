# Local proxy and Linux delivery evidence

The passing reports use clean source commit `0101a190ff274ee57ae96a0dd7e6beb6fa82a50b` on native Linux x86_64. The Web bundle was built from that source, and workerd was the pinned `2026-11-10` binary. The test homes, data and credentials were isolated.

| Report | Result |
| --- | --- |
| `mcp-before.json` | Expected failure before the fix: the test-only change at `db76b7d` found no separate local dial address. |
| `tailscale-mcp.json` | The existing Tailscale Serve route, IP allow-list, CLI, OAuth, MCP and both listeners passed. |
| `tailscale-browser.json` | Two browser sessions passed login, messages, attachments and reconnect through the same Tailscale route and allow-list. |
| `ingress.json` | Source restrictions, forged headers, IPv6, stable restart and a port conflict passed. |
| `multi-host.json` | A coordinator, primary and three execution hosts synchronized through an isolated container network. |
| `cloud-budget.json` | An isolated Wrangler instance retained Cloudflare storage and shedding behavior. |
| `linux-package.json` | The archive for the source commit passed checksum, provenance, extraction and native startup checks. |
| `workflow-simulation.json` | Local workflow graph simulation preserved platform jobs and isolated the Linux delivery dependency. |

The Tailscale client and coordinator ran on the same physical host. The workflow graph simulation is not a GitHub Actions run. GitHub paused Actions on the fork due to its Actions usage; the repository owner re-enabled it on 2026-11-17. The later native Linux runs and isolated release failure simulation are recorded in `test/evidence/issue-30-ci`.

The tests in `test/self-hosted-acceptance.md`, `test/local-package-e2e.ts` and `test/local-workflow-e2e.ts` reproduce these results. For the Tailscale runs, set `NOOP_E2E_CLIENT_ORIGIN` to the existing Serve URL, `NOOP_E2E_LISTEN_PORT` to its backend port, and `NOOP_E2E_ALLOWED_IP` to the current Tailscale IPv4 address. Verify this directory with `sha256sum -c SHA256SUMS`.
