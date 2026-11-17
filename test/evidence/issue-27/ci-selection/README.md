# Full CI platform selection

The local `act` 0.2.98 dry runs evaluated the event and matrix selection.
Both push and pull request events selected Linux and macOS in the `ci` workflow.
The release workflow selected Linux, Windows, macOS, iOS, Android and Web.
These are local selection simulations, not completed GitHub-hosted jobs.

The two selection files retain their workflow's event, matrix and runner fields.
They replace the job steps with a harmless echo. The original workflow hashes
were:

- `.github/workflows/ci.yml`: `7a97e1e5c4a982325fd9c8b991c24275bcd42af8f9256e0b525556fbf3ec569d`
- `.github/workflows/release.yml`: `9c23c04a4a8bf1c98502da51d0960f144a4d8ee1c1a4bfa663016dcc9adb96e2`

With `act` and Docker available, repeat from the repository root:

```sh
act --dryrun -P ubuntu-latest=-self-hosted -P macos-latest=-self-hosted \
  -W test/evidence/issue-27/ci-selection/selection.yml push
act --dryrun -P ubuntu-latest=-self-hosted -P macos-latest=-self-hosted \
  -W test/evidence/issue-27/ci-selection/selection.yml pull_request
act --dryrun -P ubuntu-24.04=-self-hosted -P windows-latest=-self-hosted \
  -P macos-15=-self-hosted -P xcode-27=-self-hosted \
  -W test/evidence/issue-27/ci-selection/release-selection.yml workflow_dispatch
```

`actionlint` 1.7.12 accepted all workflow files with `xcode-27` added to its
known-label configuration. GitHub documents that label as a hosted runner in
[its runner image list](https://github.com/actions/runner-images/blob/main/README.md).
The release workflow still waits for every package; issue #30 tracks an
independent Linux delivery path that retains the full CI matrix.
