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

The cause is not yet established. The Android release manifest does not opt in
to cleartext HTTP, and its network stack uses Android's HTTP implementation.
Android's [network security configuration](https://developer.android.com/privacy-and-security/security-config)
can reject cleartext requests. The failed run did not separately test the
`adb reverse` route, so it does not distinguish those causes. It does not test
HTTPS, a real mobile device or a production push service.

An earlier attempt was blocked by a Pixel Launcher not-responding dialog, shown
in `launcher-dialog.png`. The later run handled that emulator dialog and reached
the HTTP request. The disposable-emulator test and workflow for the failed run
are [here](https://github.com/laojianzi/noop/blob/5498475/test/self-hosted-android-e2e.ts)
and [here](https://github.com/laojianzi/noop/blob/5498475/.github/workflows/release.yml).
The HTTP policy comparison remains queued; it is not acceptance evidence yet.
