# Electron public release research notes (2026)

Checked on 2026-06-04:

- Electron latest npm line available here: `electron@42.3.x` (repo pinned to `^42.3.3`).
- Official Electron docs still point developers to packaging/distribution tooling rather than shipping raw source.
- Current Electron packaging tools:
  - `@electron-forge/cli@7.11.x`: official Electron build tool, great default for Forge-managed apps.
  - `electron-builder@26.8.x`: still the most direct path for signed production installers, NSIS one-click Windows installers, macOS DMG/ZIP, Linux AppImage/deb/rpm, GitHub release publishing, and updater metadata.
- `electron-builder` current schema supports modern hardening knobs: Electron fuses, ASAR integrity, macOS hardened runtime/notarization, Windows PFX signing, and Windows Azure Trusted Signing options.
- `npm publish` best practice is provenance/trusted publishing through GitHub OIDC. Long-lived `NPM_TOKEN` still works, but trusted publishing is preferred.

## Decision for this repo

Use `electron-builder`, not Forge, because this launch needs one-click installers and minimal migration from the existing vanilla Electron structure.

Pipeline choices:

- Build artifacts from GitHub Actions on native OS runners.
- Windows: NSIS one-click `.exe` + `.zip`; code signing is optional but unsigned builds trigger SmartScreen warnings.
- macOS: `.dmg` + `.zip` for x64 and arm64; unsigned builds work as artifacts but Gatekeeper prevents true one-click installs for downloaded apps.
- Linux: `.AppImage`, `.deb`, `.rpm`.
- GitHub Releases are the primary desktop distribution channel.
- npm is a source/package-manager distribution channel, published with provenance.
- App uses ASAR + Electron fuses for packaged hardening.
- Release workflow creates a draft GitHub Release first so final public launch remains a human-controlled step.

## Non-negotiables before public launch

- Replace generated placeholder icon if you want final brand-quality art.
- If you want zero-warning one-click installs, buy/configure code-signing:
  - Apple Developer ID Application cert + notarization credentials.
  - Windows code signing certificate or Azure Trusted Signing.
- If avoiding paid signing, publish unsigned artifacts and document Windows/macOS warning bypass steps.
- Configure npm trusted publishing or `NPM_TOKEN`.
- Do a clean install smoke test on each OS before undrafting the GitHub release.
