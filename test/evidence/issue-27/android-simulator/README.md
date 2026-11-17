# Android emulator: incomplete acceptance

An Android 35 x86_64 emulator launched a packaged Noop client in
[the launch run](https://github.com/laojianzi/noop/actions/runs/43892900496).
`launch.png` shows the native app. The package used the source application and
the NSH Android component; it was signed with a temporary debug key.

[The local coordinator run](https://github.com/laojianzi/noop/actions/runs/43896282106)
started a native workerd coordinator, bound a synthetic TOTP secret and used
`adb reverse` to expose an HTTP proxy to the emulator. The Android app displayed
an unreachable-server message. The proxy recorded no request. `report.json`,
`requests.log` and `http-failed.png` retain that failure and the package and
fixture hashes. The app source was not modified for this run.

The subsequent [policy comparison](https://github.com/laojianzi/noop/actions/runs/43897160269)
repeated the test with two packages. The unchanged package failed, and its
diagnostic reported that Android did not permit cleartext HTTP. A test package
with `usesCleartextTraffic` enabled completed sign-in and two-way WebSocket
messaging through the same `adb reverse` route. The two reports and diagnostic
are retained here. This does not test HTTPS, a real mobile device or a
production push service, and the test package is not a production change.

An earlier attempt was blocked by a Pixel Launcher not-responding dialog, shown
in `launcher-dialog.png`. The later run handled that emulator dialog and reached
the HTTP request. The disposable-emulator test and workflow for the failed run
are [here](https://github.com/laojianzi/noop/blob/5498475/test/self-hosted-android-e2e.ts)
and [here](https://github.com/laojianzi/noop/blob/5498475/.github/workflows/release.yml).
