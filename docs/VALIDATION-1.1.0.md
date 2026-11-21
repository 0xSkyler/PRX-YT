# PRX-YT 1.1.0 validation

Repair baseline: `45d6eeeb2dab23c28896f4d3482dbb19108314f9`, branch `release/v1.1.0`, repository `0xSkyler/PRX-YT`. November 21, 2026, Asia/Dhaka. No ProxyDesk changes.

## CAPTCHA root cause and correction

The failed Windows run was not a CAPTCHA navigation or cycle race. With a small window at startup, Browser 2 was entirely below the dashboard viewport. Its native card bounds were nonzero, but Chromium retained its initial internal viewport of 0 by 0. The challenge form existed in the expected document and cycle, with visible CSS and height 105.6, but width 0. The strict positive-geometry detector therefore continued to report paused media.

A local native reproduction used an approximately 808 by 524 content window at display scale 1.25. It reproduced the failure in document 6, cycle 3, without changing the production controller or fixture styling. New YouTube native views now receive a 640 by 360 initial viewport before attachment. Renderer card positioning still controls their eventual bounds. The same small-startup reproduction then measured a 640 by 360 internal viewport, a 640 by 17.6 challenge form, and the correct interaction-required diagnostic.

The fixture now checks challenge geometry, document and cycle identity, paused media, the actual User action required card label, and absence of a failed-proxy status. Logs and validation JSON retain the geometry. CAPTCHA detection remains strict; no challenge is solved, hidden, bypassed, or rotated around.

## Regression checks

- Windows Node suite: 233 tests, 230 passed, 3 Linux deployment tests skipped, zero failures.
- Bundled Electron Node suite: the same 233 tests, 230 passed, 3 skipped, zero failures.
- Source check: 25 reachable modules, zero external production dependencies.
- Complete small-window native source fixture: passed in 97.75 seconds. A separate native replacement check confirmed that the initial blank document must load before restoring an offscreen card position. Final lifecycle regressions also verify card restoration after failed or cancelled replacement loads, without moving destroyed or superseded views. The release gates below rerun the final packaged source.
- Native main-frame proxy, tunnel and SOCKS errors retain their transport classification after initial navigation. DNS and certificate failures remain distinct navigation failures; aborted and subframe events cannot request replacement.
- HTTP 407 rejects and removes the failed proxy, consumes only unused candidates within the existing three-candidate limit, and preserves the assigned video. Exhaustion does not start direct playback. HTTP 403, HTTP 429 and CAPTCHA continue to reserve their routes and require manual action, including after late failure callbacks.

## Windows release gates

Publication requires both Linux and Windows jobs to succeed for the release commit. The Windows job builds a new installer, checks archive/source parity and application identity, then runs the native fixture on the unpacked application with all of these checks:

- Real advancing local HTML5 media, natural ending, Pause/Play/Mute and autoplay rejection.
- Browser 2 pending blank-load regression, scheduled/manual cycle cleanup, isolated sessions and CAPTCHA holding.
- Fleet growth, cancellation during 100-workspace preparation and successful restart.
- A bounded 180-second lifecycle soak with 20 local videos; the clip lasts 7 seconds and cycles every 30 seconds.
- Preparation of 100 native lightweight workspaces, a brief hold and recovery to 20 video workspaces.
- Stable multiple-video assignments, a real rejected local CONNECT tunnel followed by unused-proxy replacement, and distinct HTTP 403/429 diagnostics.
- Persisted settings and graceful application restart.

The job then silently installs the NSIS installer into a clean directory, checks its installed archive against the source, and reruns the native playback fixture on the installed executable. Only afterward does it checksum the installer and allow publication. The release includes `SHA256SUMS-windows.txt`, `prx-yt-native-validation.json` and `prx-yt-installed-validation.json`; the reports record actual results, timings, resource samples and scope. Existing releases are never overwritten.

## Limits

Native fixtures serve local media through test-only protocol handlers. They make zero public YouTube requests and do not establish live public-proxy availability. The 100-workspace check uses lightweight pages, not 100 simultaneous continuous video streams. The finite soak does not establish 24-hour uptime. No fresh live YouTube or public-proxy test was performed for this repair.

The installer is unsigned. Electron 31.2.1 is inherited and was not upgraded; its age remains a security and media-compatibility limitation. Resource pressure pauses work and requires manual recovery. Actual capacity depends on CPU, memory, network bandwidth, content and proxy quality.
