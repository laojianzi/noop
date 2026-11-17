# Linux release acceptance

This report records the pre-sync baseline. The later upstream integration and
its validation are in [`issue-27-upstream-sync`](../issue-27-upstream-sync/README.md).

The candidate implementation is commit
`65eab6b0907b3f7beefd0a2d1fc0ced3bea604a3`. Tests use isolated homes,
synthetic credentials and a pinned native workerd `2026-11-10`. The x86_64
offline Web runs use the candidate's verified Web bundle. The desktop run uses
the earlier verified bundle built from `4c9067c`; its index SHA-256 matches
the candidate bundle. The desktop archive is the real Linux client package
from run `44049081717`.

| Evidence | Result and boundary |
| --- | --- |
| `x64-web`, `x64-messages`, `x64-smtp`, `x64-push` | Real local Worker and Chromium with public networking disabled. Mailpit is a real controlled SMTP server. Push uses a controlled receiver. |
| `x64-desktop` | The packaged Linux client signs in, sends and receives messages, and uses a WebSocket in an isolated Xvfb display. |
| `x64-guest`, `x64-mcp`, `x64-backup`, `x64-ingress`, `x64-retention` | Guest permissions, HTTPS OAuth/MCP, recovery, source policy and local retention passed on the candidate. The guest executor is synthetic. |
| `arm64-features`, `arm64-extra` | The same candidate passed the browser, SMTP, push, guest, MCP, backup, ingress and retention tests on native ARM64 runners. |
| `x64-reboot`, `arm64-reboot` | Debian guests started the service after a machine reset with linger and no user login. x86_64 used KVM; ARM64 used QEMU TCG. |
| `x64-update`, `arm64-update` | Both native architectures passed a runtime upgrade, protected rollback and real full-disk failure. |
| `x64-package` | The branch build's actual archive passed provenance and checksum checks, then started and served the real Web bundle. |
| `power-loss-red`, `power-loss-green` | An x86_64 KVM coordinator and four container hosts. A forced VM stop exposed an unpersisted VAPID key. The fix retained the public key, committed files, claimed task and queued work after restart. |
| `cloud-budget`, `cloud-mcp` | An isolated local Wrangler instance retains Cloudflare-mode budget policy and passes MCP. These are not hosted Cloudflare tests. |
| `real-codex-earlier` | A real Codex CLI returned the exact task result on source `4c9067c`. Only the test was patched; `test-only.patch` records the wrapper and assertions. The agent used the existing login and an ephemeral, user-config-ignored session. |

The production difference between `4c9067c` and the candidate is one call to
persist `vapid.json` before the coordinator starts. The real Codex result is
earlier evidence, not a claim that the modified test ran on the candidate.

```sh
git diff --stat 4c9067c 65eab6b -- src cloud app scripts package.json bun.lock bunfig.toml tsconfig.json
```

In `power-loss-red`, the guest ext4 file system contained a 293-byte
`vapid.json` filled with zero bytes after forced VM termination. Its restart log
shows the JSON parse failure. The test extension was present before the product
fix. `power-loss-green-dirty` is the first passing run with uncommitted code;
`power-loss-green` repeats it from the clean candidate commit. No private key
or VM disk is included here.

The first desktop attempt on the candidate failed at `xdotool mousemove`;
`x64-desktop-first-attempt` retains that report and the display logs. The script
did not capture the tool's stderr, so the cause is unconfirmed. A fresh run
passed. An earlier OCR spacing failure and its correction are recorded in the
commit history.

The first x86_64 offline container could not read the host worktree's Git
metadata, so its reports omitted the revision. The final run used a clean,
self-contained clone. All four reports record the candidate commit.

The first Cloudflare-mode MCP regression missed its test deadline. The
controlled-delay run records an event arriving after the eight-second wait.
The test now sends the event after two progress frames and gives the request a
larger window. The final Wrangler run passed; no Worker change was made for
that failure.

The first temporary acceptance workflow selected a pull-request build. GitHub
made that build from synthetic merge commit `e1648b6`, so its manifest did not
match the requested branch commit. Run `44062113063` correctly failed the
provenance check. The workflow was corrected to use the branch's push build
`44061419526`; `wrong-artifact-manifest.json` preserves the mismatched manifest.

- Complete Linux feature, update and reboot probe: https://github.com/laojianzi/noop/actions/runs/44062405843
- Additional candidate ARM64 feature checks: https://github.com/laojianzi/noop/actions/runs/44063827963
- Candidate coordinator archives: https://github.com/laojianzi/noop/actions/runs/44061419526
- Six-platform client build: https://github.com/laojianzi/noop/actions/runs/44061430181

## Reproduce

The product scripts and prerequisites are in
[`test/self-hosted-acceptance.md`](../../self-hosted-acceptance.md). The KVM
network scenario needs an empty fixture directory, the matching host kernel and
module, installed container images, the genuine Web bundle and the pinned
workerd binary. It builds a disposable disk and removes its own containers.

`acceptance-probe.yml` and `arm-extra-probe.yml` are the temporary GitHub
Actions workflows used for the candidate. To repeat one, place it in
`.github/workflows` on its named probe branch, set the candidate and artifact
run to a matching push build, and push. The workflows download tools before
isolating the tests, then save reports and logs. GitHub artifacts have limited
retention. The downloaded release archives and checksums can also be retained
locally.

Verify this curated directory:

```sh
cd test/evidence/issue-27-linux-final
sha256sum -c SHA256SUMS
```

The scripts produce additional temporary databases, private synthetic test
keys and large VM disks. They are deliberately excluded from this curated
archive. Each original test report and its companion files were checked with
the test's own `SHA256SUMS` before selection. Logs are stored as lossless gzip
files; use `gzip -dc <file>.log.gz` to read them.

## Limits

The existing Tailscale Serve, allow-list, browser and MCP checks are in
[`issue-29-30`](../issue-29-30/README.md). Both ends ran on one physical host.
The only production code change after that Tailscale test is the VAPID
persistence call described above.
Real macOS logout/login, VPS and cross-physical-host Tailscale, mobile HTTPS
and device push, and a hosted Cloudflare deployment remain follow-up acceptance.
Workerd's local Durable Object storage is experimental upstream.
