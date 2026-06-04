#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const targets = parseTargets(process.argv.slice(2));
const failures = [];

checkPackageMetadata();
checkTagMatchesVersion();

for (const target of targets) {
  if (target === 'mac') checkMacSigning();
  else if (target === 'win') checkWindowsSigning();
  else if (target === 'npm') checkNpmPublishing();
}

if (failures.length) {
  console.error('Release preflight failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release preflight passed${targets.length ? ` (${targets.join(', ')})` : ''}.`);

function parseTargets(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--target' && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    } else if (arg.startsWith('--target=')) {
      values.push(arg.slice('--target='.length));
    } else if (!arg.startsWith('-')) {
      values.push(arg);
    }
  }

  if (envEnabled('REQUIRE_SIGNING')) values.push('mac', 'win');
  if (envEnabled('REQUIRE_NPM')) values.push('npm');
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function checkPackageMetadata() {
  if (pkg.private === true) failures.push('package.json still has private=true; npm publish would be blocked.');
  if (!pkg.name) failures.push('package.json is missing name.');
  if (!isSemver(pkg.version)) failures.push(`package.json version is not valid semver: ${pkg.version}`);
  if (!pkg.license) failures.push('package.json is missing license. Use UNLICENSED or an SPDX license before publishing.');
  if (!pkg.repository?.url) failures.push('package.json is missing repository.url.');
  if (!Array.isArray(pkg.files) || !pkg.files.length) failures.push('package.json should use a files whitelist before public npm publish.');
}

function checkTagMatchesVersion() {
  const refType = env('GITHUB_REF_TYPE');
  const refName = env('GITHUB_REF_NAME');
  if (refType !== 'tag' || !refName) return;
  const expected = `v${pkg.version}`;
  if (refName !== expected) failures.push(`git tag ${refName} does not match package version ${expected}.`);
}

function checkMacSigning() {
  if (!anyEnv(['CSC_LINK', 'MACOS_CSC_LINK'])) {
    failures.push('mac release needs a Developer ID Application certificate in CSC_LINK or MACOS_CSC_LINK.');
  }
  if (!anyEnv(['CSC_KEY_PASSWORD', 'MACOS_CSC_KEY_PASSWORD'])) {
    failures.push('mac release needs CSC_KEY_PASSWORD or MACOS_CSC_KEY_PASSWORD for the signing certificate.');
  }

  const hasApiKey = allEnv(['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
    || allEnv(['APPLE_API_KEY_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']);
  const hasAppleId = allEnv(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']);
  const hasKeychainProfile = allEnv(['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE']);
  if (!hasApiKey && !hasAppleId && !hasKeychainProfile) {
    failures.push('mac release needs notarization credentials: APPLE_API_KEY(+ID+ISSUER), APPLE_API_KEY_BASE64(+ID+ISSUER), APPLE_ID(+APP_SPECIFIC_PASSWORD+TEAM_ID), or APPLE_KEYCHAIN(+PROFILE).');
  }
}

function checkWindowsSigning() {
  if (envEnabled('WINDOWS_AZURE_SIGNING')) {
    for (const name of [
      'AZURE_TRUSTED_SIGNING_ENDPOINT',
      'AZURE_TRUSTED_SIGNING_ACCOUNT_NAME',
      'AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME',
      'AZURE_TRUSTED_SIGNING_PUBLISHER_NAME'
    ]) {
      if (!env(name)) failures.push(`windows Azure Trusted Signing is missing ${name}.`);
    }
    if (!allEnv(['AZURE_TENANT_ID', 'AZURE_CLIENT_ID']) && !env('AZURE_FEDERATED_TOKEN_FILE')) {
      failures.push('windows Azure Trusted Signing needs Azure auth env (usually AZURE_TENANT_ID + AZURE_CLIENT_ID plus client secret/federated credentials).');
    }
    return;
  }

  const hasPfx = allEnv(['CSC_LINK', 'CSC_KEY_PASSWORD']) || allEnv(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) || allEnv(['WINDOWS_CSC_LINK', 'WINDOWS_CSC_KEY_PASSWORD']);
  if (!hasPfx) failures.push('windows release needs WINDOWS_AZURE_SIGNING=1 or a code-signing certificate in CSC_LINK/CSC_KEY_PASSWORD.');
}

function checkNpmPublishing() {
  if (env('NPM_TOKEN') || env('NODE_AUTH_TOKEN')) return;
  if (env('GITHUB_ACTIONS') && env('ACTIONS_ID_TOKEN_REQUEST_URL')) return;
  failures.push('npm publish needs npm Trusted Publishing/OIDC or NPM_TOKEN/NODE_AUTH_TOKEN.');
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(value || ''));
}

function env(name) {
  return String(process.env[name] || '').trim();
}

function envEnabled(name) {
  return ['1', 'true', 'yes', 'on'].includes(env(name).toLowerCase());
}

function anyEnv(names) {
  return names.some((name) => Boolean(env(name)));
}

function allEnv(names) {
  return names.every((name) => Boolean(env(name)));
}
