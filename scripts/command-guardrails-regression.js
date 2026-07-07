#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  classifyCommand,
  classifyShellWriteCommand,
  shouldBlockShellWriteCommand
} = require('../src/main/command-guardrails');
const { PiSdkSessionManager } = require('../src/main/pi-sdk-session-manager');

async function main() {
  assertBlocked(
    'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'index.html\', \'<h1>hi</h1>\')"',
    'node-e-fs-write'
  );
  assertBlocked('cat > index.html <<\'EOF\'\n<h1>hi</h1>\nEOF', 'shell-output-redirection');
  assertBlocked('python - <<\'PY\'\nopen(\'x\', \'w\').write(\'y\')\nPY', 'shell-heredoc');
  assertBlocked('printf "hi" | tee index.html', 'tee-file-write');
  assertBlocked('sed -i "s/old/new/" index.html', 'sed-in-place');
  assertBlocked('python -c "from pathlib import Path; Path(\'index.html\').write_text(\'hi\')"', 'python-c-file-write');
  assertBlocked('ruby -e "File.write(\'index.html\', \'hi\')"', 'ruby-e-file-write');
  assertBlocked('php -r "file_put_contents(\'index.html\', \'hi\');"', 'php-r-file-write');
  assertBlocked('powershell -NoProfile -Command "Set-Content -Path index.html -Value hi"', 'powershell-file-write');
  assertBlocked('powershell -NoProfile -Command "[IO.File]::WriteAllText(\'index.html\', \'hi\')"', 'powershell-file-write');

  assertBlocked('cp a b', 'shell-filesystem-mutation');
  assertBlocked('mv a b', 'shell-filesystem-mutation');
  assertBlocked('touch new.txt', 'shell-filesystem-mutation');
  assertBlocked('mkdir newdir', 'shell-filesystem-mutation');
  assertBlocked('rm old.txt', 'shell-filesystem-mutation');
  assertBlocked('cmd /c "echo hi > file.txt"', 'shell-output-redirection');
  assertBlocked('cmd /c "copy a b"', 'shell-filesystem-mutation');
  assertBlocked('bash -lc "cat > file.txt <<EOF\nhi\nEOF"', 'shell-output-redirection');
  assertBlocked('git apply fix.patch', 'git-filesystem-mutation');
  assertBlocked('npm install left-pad', 'package-manager-file-write');
  assertBlocked('npm run build', 'package-manager-file-write');
  assertBlocked('curl -o page.html https://example.test', 'download-file-write');

  assertAllowed('node -e "console.log(JSON.stringify({ ok: true }))"');
  assertAllowed('npm test');
  assertAllowed('npm run check');
  assertAllowed('npm run lint');
  assertAllowed('rg "writeFileSync" src');
  assertAllowed('git diff -- src/main/command-guardrails.js');

  const decision = shouldBlockShellWriteCommand('node -e "require(\'fs\').appendFileSync(\'x\', \'y\')"');
  assert.equal(decision.blocked, true);
  assert.equal(decision.rule, 'node-e-fs-write');

  assert.equal(classifyCommand('rm -rf .').action, 'ask', 'existing destructive-command guard still works');
  await assertAiBashToolBlocksShellWrites();
  console.log('command guardrails regression passed');
}

function assertBlocked(command, rule) {
  const decision = classifyShellWriteCommand(command);
  assert.equal(decision.action, 'block', command);
  assert.equal(decision.rule, rule, command);
}

function assertAllowed(command) {
  const decision = classifyShellWriteCommand(command);
  assert.equal(decision.action, 'allow', command);
}

async function assertAiBashToolBlocksShellWrites() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-command-guard-'));
  const userDataDir = path.join(tempRoot, 'user-data');
  const agentDir = path.join(tempRoot, 'agent');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  const events = [];
  const logs = [];
  const manager = new PiSdkSessionManager({
    userDataDir,
    agentDir,
    getSettings: () => ({ guardrails: 'off' }),
    getDefaultWorkspaceRoot: () => workspaceRoot,
    emit: (event) => events.push(event),
    requestCommandApproval: async () => true,
    log: (level, message, meta) => logs.push({ level, message, meta })
  });

  try {
    const runtimeRef = { current: { id: 'guard-test', cwd: workspaceRoot } };
    const tool = await manager.createGuardedBashTool(workspaceRoot, {}, runtimeRef);
    const target = path.join(workspaceRoot, 'blocked.txt');
    const command = 'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'blocked.txt\', \'nope\')"';

    await assert.rejects(
      () => tool.execute('call_blocked_write', { command }, new AbortController().signal, () => {}, {}),
      /Shell file-write command blocked\./
    );

    assert.equal(fssync.existsSync(target), false, 'blocked AI bash command must not create the target file');
    assert.ok(logs.some((entry) => entry.message === 'guardrails:shell-write-blocked'));
    assert.ok(events.some((event) => event.type === 'status' && /use write\/edit/.test(event.message)));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
