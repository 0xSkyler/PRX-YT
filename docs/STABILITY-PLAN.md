# PRX-YT Windows stability repair

**Goal:** repair the reported v1.0.0 failures and publish a new installer only after validation passes.

**Baseline:** clean PRX-YT `0b23ee3e7120d28f2d5e18030ffde370d6ceb274`. ProxyDesk remains read only. Preserve Electron BrowserView isolation, dark dashboard, provider/tier selection, controls, logging and packaging.

## Evidence and scope

- Installed application logs show Browser 2 page preparation timeouts before proxy fetch; fixed 15-second native waits and a fixed 60-second fleet deadline make startup brittle. Native testing must distinguish committed blank documents from unsettled load promises.
- The proxy IP in the screenshot is proxy metadata, not evidence of navigation to that address. Legacy Google block handling incorrectly sets Proxy failed while the YouTube controller reports verification required.
- ProxyManager can continue assigning after a callback cancels or starts a newer fetch. Provider entries are not connectivity-validated, and 100 assignment callbacks initiate work together.
- Existing native fixtures exercise 20 local videos and cancellation during 100 preparation. They do not establish complete 100 startup or continuous live YouTube capacity.

## Implementation and gates

- [ ] Navigation owner: regression tests for proxy endpoint/Google search rejection, selected video ownership, CAPTCHA status consistency; commit-based blank readiness, bounded recreation with native cleanup barriers, visible current URL and controls.
- [ ] Scheduler owner: per-slot progressive startup and bounded retries, adaptive preparation deadline, three assignment workers, setup watchdog, blocked-slot holds, explicit retry and race-safe cancellation.
- [x] Proxy owner: callback reentrancy regressions; ownership checks after public events; bounded HEAD transport check through the assigned session without redirects, challenge solving or false playback claims.
- [ ] Resource owner: two-sample memory guard, pause/cancel and release native views, bounded metric logs, manual recovery.
- [ ] Validation owner: exact screenshot-pattern fixtures, full 100 local workspaces, finite local media soak, media-time/manual control assertions, JSON timing/memory data; one compliant live diagnostic where connection permits.
- [ ] Release owner: full Node and bundled-runtime suites, source/archive checks, native source and packaged tests, clean-directory installer test, CI on Windows/Linux and release only from this repository with versioned checksum. Never overwrite a release.

No CAPTCHA bypass, engagement simulation, autoplay policy bypass, automatic sign-in/consent, or claim of 100 continuous streams. Inspect cancellation after Stop/new Start, late native cleanup, missing renderer, provider outage, restricted pages, and resource-pressure recovery. Report incomplete live/soak evidence precisely.
