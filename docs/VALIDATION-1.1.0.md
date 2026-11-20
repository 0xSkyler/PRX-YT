# PRX-YT 1.1.0 validation

Development validation on Windows 10 Pro x64, approximately 31.3 GiB usable RAM. Original PRX-YT HEAD: `0b23ee3e7120d28f2d5e18030ffde370d6ceb274`. ProxyDesk was read only. November 21, 2026, Asia/Dhaka.

## Recorded checks

- Full Node suite: 221 tests, 218 passed, 3 Linux-only deployment tests skipped on Windows, zero failures. The Linux release job runs the deployment tests.
- Source import/package identity check: 25 reachable modules, no external production imports.
- Native source fixture: passed, 313.5 seconds total. Browser 2 pending blank-load promise, real advancing local HTML5 media, natural ending, Pause/Play/Mute, scheduled/manual reset, CAPTCHA holding, cancellation during 100 preparation, recovery, multiple videos, HTTP 403/429 restrictions, persisted settings and restart.
- Full native fleet: 100 prepared IDs, 101 native web contents including dashboard. First cycle prepared in approximately 20.3 seconds from an existing 20-workspace pool; held for 5 seconds. These were lightweight local pages, not 100 video streams.
- Resource snapshot at 100: 105 processes, approximately 9.34 GiB summed working sets and 7.80 GiB free system memory. Working sets can count shared pages more than once and are different from private memory used by the watchdog.
- Local media soak: 20 workspaces, 180.014 seconds, seven cycles, 120 observations of advancing media. The local clip lasts 7 seconds and cycles every 30 seconds; this is a periodic lifecycle test, not uninterrupted decoding for three minutes.
- Random multi-link distribution: 20 workspaces, two supplied local video IDs; all actual loaded URLs belonged to that set and stayed assigned after a cycle reset.
- HEAD 403/429 cases: access requiring action, zero media play attempts, no failed-proxy claim. Stop verified blank documents and no media elements.
- Separate live check: official Blender sample `aqz-KE-bpKQ` over the PC's normal direct connection, HEAD/GET 200, one navigation, no proxy provider, no retries. During 30.312 seconds of observation actual media advanced to 26.193 seconds, readyState 4, no media error. This tested the production controller and native view with direct transport, not a public proxy.

Final release gates rerun regression checks, bundled Node tests, archive source parity and the extended native fixture on the packaged application, including a real local rejected CONNECT tunnel followed by unused-proxy replacement. A clean Windows CI runner installs the NSIS artifact and tests the installed application. Publication depends on both Windows and Linux jobs; installer SHA-256 and native JSON evidence are release assets.

## Limits and unperformed checks

No 24-hour soak, 100 simultaneous continuous live streams, or vetted public-proxy pool was tested. The 100-workspace result is preparation and brief lightweight hold only. Public proxy reliability and future YouTube changes remain external constraints. Never interpret a successful transport check as verified playback.

The source fixture preceded final race-review fixes; the release pipeline tests the final packaged source again. Local NSIS output under Documents was blocked by Windows Controlled Folder Access; validation builds use a task-specific temporary folder without disabling protection. Local installation is left to clean CI to avoid replacing this PC's existing PRX-YT registration.

The installer is unsigned. Electron 31.2.1 is inherited and was not upgraded; its age remains a security/media-compatibility limit. Resource pressure pauses work and requires manual recovery. Consent/CAPTCHA/access restrictions are never solved, bypassed or automatically rotated around.
