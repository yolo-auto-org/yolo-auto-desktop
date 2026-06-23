# Release guide

## Local checks

```bash
npm ci
npm run check
npm run icons
npm run dist:dir
```

Build platform installers on the matching OS:

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Artifacts are written to `release/`.

## GitHub deploy flow

The `.github/workflows/release.yml` workflow is the deployment path for the public repo. This is the quick checklist to follow when asked to cut a release.

### Agent-friendly command order

> Replace `0.1.2` / `v0.1.2` with the target version. Push the tag only after all release changes are committed; tag push starts the release workflow.

```bash
# 1. Inspect state and confirm the target version/tag are free.
git status -sb
git fetch origin main --tags
git ls-remote --exit-code --tags origin refs/tags/v0.1.2 || true

# 2. Bump package.json and package-lock.json.
npm version 0.1.2 --no-git-tag-version

# 3. Run the local gate.
npm run check

# 4. Commit the exact release contents.
git status --short
git add package.json package-lock.json <changed-files>
git commit -m "Release v0.1.2"

# 5. Create an annotated tag exactly matching package.json.
git tag -a v0.1.2 -m "YOLO Auto Desktop v0.1.2"

# 6. Push main first, then the tag.
git push origin main
git push origin v0.1.2

# 7. Watch the GitHub Actions release workflow.
gh run list --workflow release.yml --limit 5
gh run watch <run-id> --exit-status

# 8. Verify the published GitHub Release.
gh release view v0.1.2 --json tagName,targetCommitish,isDraft,isPrerelease,publishedAt,url,assets \
  --jq '{tagName,targetCommitish,isDraft,isPrerelease,publishedAt,url,assetCount:(.assets|length)}'
```

Expected workflow result: GitHub Actions builds Windows/macOS/Linux artifacts, publishes a GitHub Release, and attaches installers plus updater metadata (`latest*.yml` and `.blockmap` files). Published releases are visible to the in-app auto-updater.

### If a tag-triggered release started too early

If the release workflow is already running but the GitHub Release has **not** been created yet, cancel the run, commit the missing changes, move the tag, and force-push only that tag:

```bash
gh run cancel <run-id>
# make changes, run npm run check, commit them
git tag -fa v0.1.2 -m "YOLO Auto Desktop v0.1.2"
git push origin main
git push --force origin v0.1.2
gh run watch <new-run-id> --exit-status
```

If a public GitHub Release already exists, do not rewrite it; bump to a new patch version instead.

You can also run **Actions → Release → Run workflow** manually. Manual runs create/reuse `v<package.json version>`; set `draft=true` if you want a private smoke-test draft first. Draft releases are useful for testing, but auto-update clients cannot see them until they are published.

## Auto-update behavior

Packaged builds use `electron-updater` with the public GitHub Releases provider configured in `electron-builder.config.cjs`.

- Windows NSIS builds use `latest.yml`, the setup `.exe`, and `.blockmap` files.
- macOS builds use `latest-mac.yml` and the `.zip` update asset. Reliable macOS auto-update requires Developer ID signing/notarization.
- Linux AppImage builds use `latest-linux.yml`.
- Prerelease versions such as `0.2.0-beta.1` become GitHub prereleases and are not offered to stable users.
- Set `YOLO_AUTO_DISABLE_UPDATES=1` to disable update checks for a packaged build.

The app checks on startup, then every 6 hours. When an update is downloaded, it prompts the user to restart and install. Settings → Logs includes a manual **Check for updates** button.

## Free / unsigned or ad-hoc-signed path

You can publish installers without paid Apple/Microsoft signing.

- Windows: `YOLO-Auto-Desktop-Setup-<version>-x64.exe` is a real one-click NSIS installer. Users will see Windows SmartScreen / unknown publisher warnings until you code-sign.
- macOS: free builds are ad-hoc signed so Electron's modified binaries have internally valid page signatures, but they are still not Apple-trusted or notarized. This is **not truly one-click** for downloaded apps. Users usually need right-click → Open, or remove quarantine manually. True one-click macOS distribution and reliable auto-update require paid Apple Developer ID signing + notarization.
- Linux: AppImage/deb/rpm are usable without paid signing. Some distros may still warn.

By default the GitHub release workflow builds unpaid/free artifacts if signing secrets are absent: Windows remains unsigned, while macOS is ad-hoc signed but not notarized. Set these repository variables only when you want to enforce paid signing:

- `REQUIRE_WINDOWS_SIGNING=true`
- `REQUIRE_MAC_SIGNING=true`
- `MAC_NOTARIZE=true`
- `PUBLISH_NPM=true` if tag pushes should publish npm automatically

## Optional GitHub secrets / variables

### npm

Preferred: configure npm Trusted Publishing for this GitHub repo/package, then the workflow can publish with provenance via OIDC.

Fallback secret:

- `NPM_TOKEN`

Protect the `npm-production` GitHub environment with required reviewers.

### macOS signing + notarization, optional paid path

Secrets:

- `MACOS_CSC_LINK` — Developer ID Application certificate as base64/data URL/file URL accepted by electron-builder.
- `MACOS_CSC_KEY_PASSWORD`

Preferred notarization secrets:

- `APPLE_API_KEY_BASE64` — base64 of the App Store Connect `AuthKey_XXXX.p8` file.
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Alternative notarization secrets:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

### Windows signing, optional paid path

Option A: PFX certificate secrets:

- `WINDOWS_CSC_LINK`
- `WINDOWS_CSC_KEY_PASSWORD`

Option B: Azure Trusted Signing variables/secrets:

Variables:

- `WINDOWS_AZURE_SIGNING=true`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET` if not using federated credentials

## Public-launch smoke test

On a clean VM/user account for each OS:

- Install from generated installer.
- Launch app from Start/Menu/Applications.
- Open Settings, save API base/model/key, verify key is not echoed back.
- Create a session and send a simple non-tool prompt.
- Pick a temp workspace folder.
- Test file read/write on a disposable file.
- Test a harmless command (`!echo hello`).
- Verify dangerous command prompt appears for a broad delete attempt and cancel it.
- Open Logs settings and run **Check for updates**.
- Quit and relaunch; verify sessions/settings persist.

## npm publish notes

The npm package is not the primary desktop installer. It is a public source/package-manager artifact. The one-click user install path is the signed GitHub Release installer.

The workflow runs:

```bash
npm publish --provenance --access public
```

Prerelease versions like `0.2.0-beta.1` publish under the `next` npm tag; normal versions publish under `latest`.
