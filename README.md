# PRX-YT 1.1.0

PRX-YT is a Windows Electron application for direct YouTube playback testing,
availability research and diagnostics across isolated browser workspaces.

It is based directly on **DOM v0.5.29 in the current `main` branch of
[0xSkyler/ProxyDesk](https://github.com/0xSkyler/ProxyDesk)**, pinned to commit
[`b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951`](https://github.com/0xSkyler/ProxyDesk/commit/b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951).
The historical repository name does not identify an older ProxyDesk baseline.
PRX-YT development and releases belong exclusively to this repository.

## Windows release

Open [PRX-YT releases](https://github.com/0xSkyler/PRX-YT/releases) and download
`PRX-YT-v1.1.0-Windows-x64-Setup.exe` from the completed v1.1.0 release. A release
appears only after its Windows build and validation workflow succeeds. The
installer supports choosing an installation directory and creates PRX-YT
shortcuts separately from DOM. It is not Authenticode-signed.

`SHA256SUMS-windows.txt` accompanies the installer. Compare the listed hash with:

```powershell
Get-FileHash -Algorithm SHA256 .\PRX-YT-v1.1.0-Windows-x64-Setup.exe
```

## Run a playback test

1. Paste one or more **YouTube Video URLs**, one per line (up to 100 unique videos). Watch, `youtu.be`, Shorts and supported live
   video links are normalized to a specific video. Channel, playlist-only,
   unrelated and malformed URLs are rejected.
2. Choose the number of browsers, proxy source, editable API URL, country
   selection, cycle interval and playback mute setting.
3. Select **Start**. Each workspace receives a random video from the list, kept
   for that run's cycles and recovery. Workspaces prepare progressively with
   progress and cancellation, receive proxies, check transport and open their selected video directly.
4. Inspect each workspace's live preview and playback diagnostics. Playback is
   reported from the actual HTML5 media element; navigation alone is not proof
   that the video is playing.
5. Use **Run Now** to begin the next cycle and explicitly retry held restrictions,
   or **Stop** to cancel the run. A new
   cycle ends the old playback session before cleanup and navigation.

Videos that finish before a cycle boundary remain ended until the next cycle.
Long videos remain in the current session until Stop or the next boundary.
Playback restrictions, login/consent requirements, unavailable videos and media
errors are visible diagnostics. Use the existing manual browser controls when
user interaction is required.

CAPTCHA, consent, sign-in and access restrictions are held across scheduled cycles;
they never trigger automatic proxy rotation. A confirmed proxy transport failure
immediately removes that endpoint and reserves an unused one from the fetched
pool, with at most three candidate attempts per workspace per cycle. If the pool
or attempt budget is exhausted, the slot stops until a later cycle or user retry.
A HEAD response proves transport only; only advancing media is reported as Playing.

Setup watchdogs cancel stuck work, provider retries back off and stop after three
attempts, and native renderer crash recovery is bounded. The memory guard checks
every 15 seconds, pauses after two consecutive pressure samples, and releases
workspaces. It reserves at least 512 MiB / 10% of system RAM and limits app memory
to half system RAM, capped at 8 GiB. Reduce the browser count and press Start after
pressure clears. Log history and proxy quarantine history are bounded.

This application does not use search-engine result scans, target-site clicks,
automated article scrolling or Keep Alive link navigation for playback research.
It does not promise that YouTube will count a view or that a blocked video will play.

## Preserved browser and proxy architecture

- The existing dark dashboard, browser grid, native previews and manual controls.
- Configurable 1–100 workspaces with separate Chromium sessions and profiles.
- ProxyScrape Free API, All Working API and editable provider URLs.
- Country tiers, including All Countries, provider country labels and filtering.
- Existing proxy parsing, assignment, endpoint reservation, replacement and
  provider rate-limit recovery.
- Bounded browser preparation with progress, cancellation and recovery.
- Centralized cycle scheduling, Start, Stop, Run Now and per-cycle cleanup.
- Existing logging, shutdown cleanup, browser disposal and crash handling.

A page-specific playback failure is not by itself evidence that a proxy is dead.
Diagnostics distinguish transport failures from player/access limitations.
Public proxy feeds may contain slow, unavailable or YouTube-blocked endpoints.
Playback depends on the selected route and the video's actual availability.

One hundred workspaces is a supported configuration limit, not a guarantee that
one hundred concurrent streams fit every machine. Each browser consumes real
memory, CPU and bandwidth. Begin with a workload appropriate to your hardware.

## Source architecture

The inherited application is JavaScript and Electron **31.2.1** with native
`BrowserView` workspaces. The React renderer is a recovered production bundle;
the original JSX source and source maps are not present. PRX-YT keeps that
renderer and modifies the workflow without introducing a framework rewrite.

| Area | Responsibility |
| --- | --- |
| `src/main/BrowserManager.js` | Native browser lifecycle, isolation, routing, previews and manual controls |
| `src/main/ProxyManager.js` and `src/proxy/` | Proxy providers, parsing, selection and allocation |
| `src/main/BrowserPreparation.js` | Bounded workspace preparation and cancellation |
| `src/main/YouTubePlaybackController.js` | Media observation, normal playback attempts and diagnostics |
| `src/main/ipc/registerIpc.js`, `src/preload/preload.js` | Existing narrow renderer/main communication boundary |
| `src/renderer/` | Recovered dashboard and its maintained controls |
| `.github/workflows/prx-yt-release.yml` | Native Windows build, installed-app verification and release publication |

Runtime imports use Electron and Node built-ins. React/React DOM/Zustand remain
in the committed renderer bundle; the original licenses are preserved under
`third-party/`. No recovery-installer extraction occurs in normal builds.
Historical recovery artifacts and reports remain provenance rather than the
active application source.

PRX-YT has a distinct package identity and user-data location from DOM:
`prx-yt` / `PRX-YT` / `com.prxyt.desktop`. It does not migrate or overwrite a
separate DOM installation's saved data.

## Build and verify

Use Node 20 and the committed lockfile:

```powershell
npm ci
npm test
npm run check
node scripts/check-bundled-runtime.cjs
npm start
npm run package:windows
node scripts/check-package.cjs release-windows/win-unpacked/resources/app.asar
node scripts/smoke-youtube-playback.cjs release-windows/win-unpacked/PRX-YT.exe
```

The Windows installer is written to
`release-windows/PRX-YT-v1.1.0-Windows-x64-Setup.exe`.

`npm run package:linux` retains the inherited development packaging path.
Linux native tests require a graphical session or Xvfb and the normal Electron
system libraries. This release workflow publishes the Windows installer.

### Release gates

The `main` and pull-request validation workflow checks application identity,
unit tests, source integrity and the bundled Electron Node runtime on Linux and
Windows. The release workflow runs on `release/v1.1.0` pushes or manual dispatch:

1. Verify PRX-YT identity/version and install exact development dependencies.
2. Run source, unit and bundled-runtime checks.
3. Build the x64 NSIS installer with the inherited electron-builder toolchain.
4. Verify packaged source parity and required playback files in `app.asar`.
5. Run local native playback fixtures against the unpacked application.
6. Silently install NSIS into a clean directory, verify the installed archive,
   then run the same native fixtures against the installed application.
7. Generate SHA-256, transfer the verified artifacts, recheck the hash and
   publish the GitHub release. An existing release is never overwritten.

Native fixtures exercise controlled local media. They do not create public
YouTube traffic and cannot certify every real video, public proxy, consent page
or future YouTube player change. Report a live check separately with its actual
result. Historical SEO fixtures are retained for inherited-code regression work;
they are not evidence that PRX-YT's playback workflow uses search automation.

## Compatibility notes

Electron 31.2.1 is retained from the requested baseline to avoid an unrelated
browser-engine migration. Its Chromium/media compatibility may differ from a
current desktop Chrome installation. A future runtime upgrade needs its own
browser, proxy, playback and packaging regression checks.

Automatic startup of research after app launch and claims of uninterrupted
24/7 operation are outside this release's verification. Start remains an explicit
user action. The exact baseline and change boundaries are recorded in
[PRX-YT provenance](docs/PRX-YT-BASELINE.md).
