# PRX-YT is the active application in this repository

This repository is `0xSkyler/PRX-YT`. Its package identity is `prx-yt` /
`PRX-YT` / `com.prxyt.desktop`.

The exact reference baseline is `0xSkyler/ProxyDesk` main commit
`b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951`, whose application is DOM v0.5.29.
ProxyDesk is the historical repository name. Never substitute an old ProxyDesk
release, a different DOM repository, or a recovery installer for that baseline.
The reference repository is read only; development and releases belong here.

Before editing, inspect the working tree and record HEAD. Preserve unrelated
user edits. Reuse the inherited JavaScript, Electron BrowserView, isolated
session, proxy allocation, preparation/cancellation, dashboard, and release
architecture. The renderer contains a recovered production React bundle,
not the original JSX source. Keep third-party licenses and baseline provenance.

PRX-YT performs direct YouTube playback testing and availability diagnostics.
Do not re-enable Google searches, ranking scans, article clicks, or Keep Alive
navigation in its playback workflow. Report access, consent, login, CAPTCHA,
autoplay and media failures accurately; do not disguise them as playback.

Run `npm test`, `npm run check`, and relevant native fixtures for changed
behavior. The Windows release workflow checks the packaged archive, runs
local playback fixtures, silently installs the NSIS artifact, and checks the
installed application before publishing its installer and SHA-256 checksum.
Fixture success is not evidence of live public proxy availability or of
uninterrupted 100-video playback. Record which checks actually ran.

Pushes, installer creation and releases require the user's applicable
instruction. Do not delete or rewrite historical branches, tags or releases
without permission. Release automation must target only this repository and
must never overwrite an existing release.
