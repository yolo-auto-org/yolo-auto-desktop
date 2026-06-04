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

## GitHub release flow

1. Update `package.json` version.
2. Commit everything.
3. Tag exactly the package version:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

4. GitHub Actions builds Windows/macOS/Linux artifacts.
5. The workflow attaches artifacts to a **draft** GitHub Release.
6. Download and smoke-test each installer.
7. Publish/undraft the GitHub Release.

## Free / unsigned one-click path

You can publish installers without paid Apple/Microsoft signing.

- Windows: `YOLO Auto Desktop-Setup-<version>-x64.exe` is a real one-click NSIS installer. Users will see Windows SmartScreen / unknown publisher warnings until you code-sign.
- macOS: unsigned `.dmg` / `.zip` artifacts can be built, but this is **not truly one-click** for downloaded apps. Users usually need right-click → Open, or remove quarantine manually. True one-click macOS distribution requires paid Apple Developer ID signing + notarization.
- Linux: AppImage/deb/rpm are usable without paid signing. Some distros may still warn.

By default the GitHub release workflow now builds unsigned artifacts if signing secrets are absent. Set these repository variables only when you want to enforce paid signing:

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
- Open logs button.
- Quit and relaunch; verify sessions/settings persist.

## npm publish notes

The npm package is not the primary desktop installer. It is a public source/package-manager artifact. The one-click user install path is the signed GitHub Release installer.

The workflow runs:

```bash
npm publish --provenance --access public
```

Prerelease versions like `0.2.0-beta.1` publish under the `next` npm tag; normal versions publish under `latest`.
