# PRX-YT provenance and release boundaries

## Reference

- Read-only source: `https://github.com/0xSkyler/ProxyDesk`.
- Source branch: `main`.
- Source revision: `b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951`.
- Source commit subject: `Add All Countries choice to proxy country tiers`.
- Source package: DOM v0.5.29 (`dom`, `DOM`, `com.dom.desktop`).
- Destination: `https://github.com/0xSkyler/PRX-YT`.
- Destination identity: PRX-YT v1.0.0 (`prx-yt`, `PRX-YT`, `com.prxyt.desktop`).

The source revision was resolved from the reference repository's current main
branch before implementation. Older release tags and the bundled historical
recovery installer are not alternative implementation baselines.

## Intended changes

Replace the SEO research workflow with a single validated YouTube video URL,
normal playback attempts, actual-media diagnostics, user-selected mute and safe
cycle cancellation. Keep the inherited native browser architecture, proxy
providers and allocation behavior, country tiers, dashboard, profiles,
preparation, logs and Windows installer toolchain.

Brand the application and installer as PRX-YT, with an independent application
identity. Keep dependencies pinned to the source lockfile. Preserve licenses
and recovery provenance.

The recovered renderer is a compiled production React bundle. Do not infer the
presence of original JSX or regenerate the UI from an unrelated implementation.

## Validation evidence

The repository's release workflow defines the checks needed before publication.
A checked-in workflow is not proof that a build or test passed. Inspect the actual
GitHub Actions run associated with the release commit for its result:

`https://github.com/0xSkyler/PRX-YT/actions`

A completed release includes a SHA-256 file generated after checks on the
unpacked and installed application. Native playback fixtures are local and
controlled. Public YouTube access, real proxy quality, long-duration operation
and large video fleets remain dependent on their execution environment.

Historical `.github/workflows/release-v0.5.*.yml` files are retained with their
version-specific branch triggers. They do not run on PRX-YT main pushes. Use
`prx-yt-release.yml` for this application and do not trigger historical DOM
release branches in this destination repository.
