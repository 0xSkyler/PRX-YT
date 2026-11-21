# PRX-YT v1.1.0

Repairs the v1.0.0 Browser 2 preparation failure and contradictory CAPTCHA/proxy diagnostics. Keeps the dark dashboard, native BrowserView previews, player controls, isolated sessions, provider APIs, country tiers and existing ProxyDesk provenance. All development and publication belong exclusively to PRX-YT.

- Initialize a nonzero native viewport before attaching YouTube workspaces. On small Windows displays, an offscreen Browser 2 could otherwise retain a zero-size Chromium viewport and miss a rendered CAPTCHA. Detection remains strict and the fixture records document, cycle and challenge geometry.
- Paste up to 100 unique YouTube video links, one per line. Each workspace randomly receives one selected video on Start and keeps it through the run's cycles and recovery.
- Blank-document readiness follows an observed native commit rather than an unsettled full-load promise. Preparation uses two workers, bounded per-slot retries, partial-failure diagnostics and a scaled fleet deadline.
- Three workers bound assignment, transport checking and recovery. HEAD checks use the selected video through the assigned Electron session; success is not presented as playback.
- Confirmed failed proxy transports and rejected proxy authentication are removed immediately and replaced with an unused endpoint, up to three candidate attempts per workspace per cycle. Native failures after initial navigation retain their transport classification. Exhaustion is reported without direct playback fallback. CAPTCHA, access limits, login and consent never cause automatic rotation or bypass.
- CAPTCHA remains a user-action state and survives scheduled cycles until explicit Run Now retry. The UI separately labels proxy transport, actual page URL and media state.
- Playback requires actual advancing HTML5 media time. Paused, ended, autoplay-blocked, buffering, unavailable, access and media failures retain their own explanations.
- Bounded setup watchdogs, provider backoff, crash recovery, Stop cancellation, native cleanup barriers, memory-pressure pause/release and bounded logs support sustained diagnostic operation.

## Download and verification

Download `PRX-YT-v1.1.0-Windows-x64-Setup.exe` and verify it against `SHA256SUMS-windows.txt`.
The release workflow requires Linux and Windows regression checks, bundled-runtime checks, packaged-source parity, native fixtures on the unpacked application, a clean-directory NSIS installation, installed-app checks and checksum verification. Both unpacked and installed validation JSON reports accompany the installer. Existing releases are never overwritten.

See [validation details](https://github.com/0xSkyler/PRX-YT/blob/release/v1.1.0/docs/VALIDATION-1.1.0.md) and the release workflow's validation artifact for measured results and limits.

## Limits

No fresh live YouTube or public-proxy validation was performed for this repair. Public proxies remain unvetted and can be unavailable or blocked by YouTube. A local fixture is separate from live proxy transport.

The finite native soak and 100 lightweight workspace preparation do not establish 24-hour uptime or 100 simultaneous continuous video streams. Start with a small fleet and increase within measured CPU, RAM and bandwidth capacity. The memory guard deliberately stops work under sustained pressure; there is no unattended restart after a resource pause or application exit.

The installer is not Authenticode-signed. Electron 31.2.1 is inherited from the BrowserView baseline; this repair does not upgrade the browser engine. Its age and media/security compatibility remain limitations requiring a separately tested runtime migration.
