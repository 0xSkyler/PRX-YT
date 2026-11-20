# PRX-YT v1.0.0

PRX-YT adapts DOM v0.5.29 from ProxyDesk's current `main` at
`b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951` for direct YouTube video playback
testing, availability research and diagnostics.

- Enter one YouTube video URL instead of keywords, a target website or a search engine.
- Reuse the existing dashboard, browser grid, previews, manual controls,
  isolated browser profiles and 1–100-workspace configuration.
- Retain ProxyScrape Free, All Working API, custom provider URLs, country
  tiers including All Countries, proxy allocation and provider rate-limit recovery.
- Attempt normal playback and report actual media state, including playback
  position, buffering, paused, ended, unavailable and blocked states.
- Preserve Start, Stop, Run Now, centralized cycle timing, cancellation,
  browser preparation and cleanup. A new cycle replaces the preceding playback session.

## Windows download

Use `PRX-YT-v1.0.0-Windows-x64-Setup.exe`. The accompanying
`SHA256SUMS-windows.txt` records its SHA-256 checksum.

The publishing workflow requires unit/source checks, bundled-runtime tests,
archive verification, local native playback fixtures against the unpacked app,
and a clean NSIS installation followed by installed-app checks.

The installer is not Authenticode-signed. Live YouTube behavior depends on
connectivity, the selected proxies, the video's availability, media support and
YouTube's playback/access requirements. A local fixture test does not establish
that every public proxy or video works. Blocked playback remains a diagnostic
state requiring appropriate user action.

The inherited Electron 31.2.1 runtime is retained to preserve the existing
BrowserView architecture. This release does not claim 24/7 stability or that
100 simultaneous videos are practical on every computer. Use appropriate
hardware and concurrency for your testing workload.
