# Optional historical recovery fixture — not the current app

The obsolete v0.5.4 installer is used only for hash-verified recovery and historical
algorithm comparisons. PRX-YT is based on the current DOM v0.5.29 source from
`0xSkyler/ProxyDesk` main at `b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951`, with its
YouTube workflow changes in this repository. The historical installer is not a
current application, a release to install, or a development baseline.

The approximately 79 MB legacy binary is not vendored in PRX-YT. It is unnecessary
for building, testing or packaging the current source, and keeping it out of the
repository avoids carrying an obsolete installer in every checkout. The original
binary remains unchanged in the read-only reference repository.

## Optional recovery

Run `npm run recover` only when the historical comparison tree is needed. This
command uses `tests/fixtures/recovery/DOM-v0.5.4-MultiKeyword-AllWorking-Setup(1).exe`
if a local copy exists. Otherwise it downloads the exact immutable fixture from:

<https://raw.githubusercontent.com/0xSkyler/ProxyDesk/b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951/tests/fixtures/recovery/DOM-v0.5.4-MultiKeyword-AllWorking-Setup%281%29.exe>

The required SHA-256 is recorded in `docs/recovery-manifest.json`:

```text
01f888ad8fd8d5f9e299504ba579d31c58fb9fd43d6b6efa2cd87ea5c81cdbc1
```

Downloads have a 120-second deadline and a 128 MiB size limit. An incomplete or
incorrect download is removed. Only a hash-verified binary is cached in the ignored
`.recovery/fixtures/` directory; no installer is executed. Existing local or cached
copies must pass the same hash check.

The command extracts into `.recovery/reference` by default, verifies the original
package metadata and every source file hash in the manifest, and refuses to
overwrite an existing destination. A different new destination may be passed as
`npm run recover -- /path/to/new/directory`.

`npm test`, `npm run check` and normal package builds do not download or extract
this optional fixture. Current application source remains under `src/`, and its
identity is defined in `package.json`.
