const os = require('node:os');

const GUARDRAIL_MODE_ASK = 'ask';
const GUARDRAIL_MODE_OFF = 'off';
const GUARDRAIL_MODES = new Set([GUARDRAIL_MODE_ASK, GUARDRAIL_MODE_OFF]);
const FILESYSTEM_MUTATING_COMMANDS = new Set([
  'add-content', 'attrib', 'chgrp', 'chmod', 'chown', 'clear-content', 'copy', 'copy-item', 'cp', 'del', 'erase',
  'ed', 'ex', 'icacls', 'install', 'ln', 'md', 'mkdir', 'mklink', 'move', 'move-item', 'mv', 'new-item',
  'ni', 'out-file', 'patch', 'rd', 'ren', 'rename', 'rename-item', 'remove-item', 'ri', 'rm', 'rmdir',
  'robocopy', 'rsync', 'set-content', 'sponge', 'takeown', 'touch', 'truncate', 'xcopy'
]);
const WINDOWS_CMD_SHELLS = new Set(['cmd']);
const UNIX_SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh']);
const POWERSHELL_SHELLS = new Set(['powershell', 'pwsh']);

function normalizeGuardrailsMode(value, fallback = GUARDRAIL_MODE_ASK) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (raw === 'yolo' || raw === 'disabled' || raw === 'disable' || raw === 'none' || raw === 'false' || raw === '0') return GUARDRAIL_MODE_OFF;
  if (raw === 'approval' || raw === 'approve' || raw === 'confirm' || raw === 'on' || raw === 'true' || raw === '1') return GUARDRAIL_MODE_ASK;
  if (GUARDRAIL_MODES.has(raw)) return raw;
  return GUARDRAIL_MODES.has(fallback) ? fallback : GUARDRAIL_MODE_ASK;
}

function normalizeGuardrails(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' ? value : { mode: value };
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : { mode: fallback };
  const yolo = source.yoloMode ?? source.yolo ?? source.disableProtections;
  return {
    mode: yolo === true ? GUARDRAIL_MODE_OFF : normalizeGuardrailsMode(source.mode, fallbackSource.mode || GUARDRAIL_MODE_ASK)
  };
}

function guardrailsAreDisabled(settings = {}) {
  return normalizeGuardrails(settings.guardrails).mode === GUARDRAIL_MODE_OFF;
}

function shouldAskCommandApproval(command, settings = {}, options = {}) {
  if (guardrailsAreDisabled(settings)) {
    return { requiresApproval: false, disabled: true, classification: classifyCommand(command, options) };
  }

  const classification = classifyCommand(command, options);
  return {
    ...classification,
    requiresApproval: classification.action === 'ask'
  };
}

function shouldBlockShellWriteCommand(command, _settings = {}, options = {}) {
  const classification = classifyShellWriteCommand(command, options);
  return {
    ...classification,
    blocked: classification.action === 'block'
  };
}

function classifyShellWriteCommand(command, options = {}) {
  if ((options.shellWriteDepth || 0) > 8) {
    return block('Nested shell command is too deep to prove read-only; use the write or edit tool for file changes.', 'nested-shell-command');
  }

  const text = normalizeCommandText(command);
  if (!text) return allow();

  const redirection = findShellOutputRedirection(text);
  if (redirection) {
    return block('Shell output redirection writes files; use the write or edit tool instead.', 'shell-output-redirection', { operator: redirection });
  }

  const heredoc = findShellHeredoc(text);
  if (heredoc) {
    return block('Shell heredocs can smuggle generated scripts or file content through the terminal; use read/write/edit tools instead.', 'shell-heredoc', { operator: heredoc });
  }

  const powerShellDecision = classifyPowerShellWriteText(text);
  if (powerShellDecision.action === 'block') return powerShellDecision;

  for (const segment of splitShellWriteSegments(text)) {
    const decision = classifyShellWriteSegment(segment, options);
    if (decision.action === 'block') return decision;
  }

  return allow();
}

function classifyCommand(command, options = {}) {
  const text = normalizeCommandText(command);
  if (!text) return allow();

  const sharedOptions = {
    homeDir: options.homeDir || safeHomeDir(),
    cwd: options.cwd || process.cwd(),
    platform: options.platform || process.platform
  };

  const powerShellDecision = classifyPowerShellText(text, sharedOptions);
  if (powerShellDecision.action === 'ask') return powerShellDecision;

  for (const segment of splitShellSegments(text)) {
    const decision = classifySegment(segment, sharedOptions);
    if (decision.action === 'ask') return decision;
  }

  return allow();
}

function classifySegment(segment, options) {
  const tokens = stripCommandPrefix(shellTokenize(segment));
  if (!tokens.length) return allow();

  const name = commandName(tokens[0]);
  if (!name) return allow();

  if (name === 'rm') return classifyRm(tokens, options);
  if (name === 'chmod' || name === 'chown' || name === 'chgrp') return classifyRecursivePermissionChange(tokens, options);
  if (name === 'dd') return classifyDd(tokens);
  if (name === 'wipefs') return ask('wipefs can erase filesystem signatures from disks.', 'wipefs');
  if (name === 'diskpart') return ask('diskpart can repartition or wipe disks.', 'diskpart');
  if (name === 'format') return classifyFormat(tokens);
  if (name === 'rd' || name === 'rmdir' || name === 'del' || name === 'erase') return classifyWindowsDelete(tokens, options);
  if (name === 'remove-item' || name === 'ri') return classifyPowerShellRemove(tokens, options);
  if (name === 'sgdisk' && tokens.some((token) => /^--zap-all$/i.test(token) || token === '-Z')) {
    return ask('sgdisk --zap-all wipes partition tables.', 'sgdisk-zap-all');
  }
  if (name === 'mkfs' || name.startsWith('mkfs.')) return ask('mkfs formats a filesystem.', 'mkfs');

  return allow();
}

function classifyShellWriteSegment(segment, options = {}) {
  const tokens = stripCommandPrefix(shellTokenize(segment));
  if (!tokens.length) return allow();

  const name = commandName(tokens[0]);
  if (!name) return allow();

  const nestedDecision = classifyNestedShellWriteCommand(name, tokens, options);
  if (nestedDecision.action === 'block') return nestedDecision;

  const mutationDecision = classifyFilesystemMutationCommand(name, tokens);
  if (mutationDecision.action === 'block') return mutationDecision;

  if ((name === 'sed' || name === 'gsed') && tokens.slice(1).some(isSedInPlaceFlag)) {
    return block('sed in-place editing modifies files through the shell; use the edit tool instead.', 'sed-in-place');
  }

  if (name === 'perl' && tokens.slice(1).some(isPerlInPlaceFlag)) {
    return block('perl in-place editing modifies files through the shell; use the edit tool instead.', 'perl-in-place');
  }

  if (name === 'perl' && hasPerlEvalFlag(tokens) && perlEvalWritesFiles(tokens)) {
    return block('perl -e file-write scripts are blocked; use the write or edit tool instead.', 'perl-e-file-write');
  }

  if (name === 'ruby' && hasRubyEvalFlag(tokens) && rubyEvalWritesFiles(tokens)) {
    return block('ruby -e file-write scripts are blocked; use the write or edit tool instead.', 'ruby-e-file-write');
  }

  if (name === 'php' && hasPhpEvalFlag(tokens) && phpEvalWritesFiles(tokens)) {
    return block('php -r file-write scripts are blocked; use the write or edit tool instead.', 'php-r-file-write');
  }

  if (name === 'tee') {
    const target = tokens.slice(1).find(isTeeWriteTarget);
    if (target) return block(`tee writes to ${target}; use the write or edit tool instead.`, 'tee-file-write', { target });
  }

  if (name === 'node' && hasNodeEvalFlag(tokens) && nodeEvalWritesFiles(tokens)) {
    return block('node -e file-write scripts are blocked; use the write or edit tool instead.', 'node-e-fs-write');
  }

  if (isPythonCommandName(name) && hasPythonEvalFlag(tokens) && pythonEvalWritesFiles(tokens)) {
    return block('python -c file-write scripts are blocked; use the write or edit tool instead.', 'python-c-file-write');
  }

  const powerShellDecision = classifyPowerShellWriteText(segment);
  if (powerShellDecision.action === 'block') return powerShellDecision;

  return allow();
}

function classifyNestedShellWriteCommand(name, tokens, options = {}) {
  const nested = nestedShellCommandText(name, tokens);
  if (!nested) return allow();
  const decision = classifyShellWriteCommand(nested, { ...options, shellWriteDepth: (options.shellWriteDepth || 0) + 1 });
  if (decision.action === 'block') return decision;
  return allow();
}

function nestedShellCommandText(name, tokens) {
  if (WINDOWS_CMD_SHELLS.has(name)) {
    const index = tokens.findIndex((token) => /^\/(?:c|k)$/i.test(token));
    return index >= 0 ? tokens.slice(index + 1).join(' ').trim() : '';
  }

  if (UNIX_SHELLS.has(name)) {
    const index = tokens.findIndex((token) => /^-[^-]*c/.test(token) || token === '-c' || token === '--command');
    return index >= 0 ? tokens.slice(index + 1).join(' ').trim() : '';
  }

  if (POWERSHELL_SHELLS.has(name)) {
    if (tokens.some((token) => /^-(?:e|ec|encodedcommand)$/i.test(token))) {
      return 'set-content encoded-command-blocked';
    }
    const index = tokens.findIndex((token) => /^-(?:c|command)$/i.test(token));
    return index >= 0 ? tokens.slice(index + 1).join(' ').trim() : '';
  }

  return '';
}

function classifyFilesystemMutationCommand(name, tokens) {
  if (FILESYSTEM_MUTATING_COMMANDS.has(name)) {
    return block(`${name} modifies filesystem state through the shell; use the write or edit tool instead.`, 'shell-filesystem-mutation', { command: name });
  }

  if (name === 'dd' && tokens.slice(1).some((token) => /^of=/i.test(token))) {
    return block('dd with of= writes files or devices through the shell; use the write tool instead.', 'dd-output-write');
  }

  if (name === 'tar' && tarExtractsFiles(tokens)) {
    return block('tar extraction creates or overwrites files through the shell; use write/edit for file changes.', 'archive-extract-write', { command: name });
  }

  if ((name === 'unzip' || name === '7z' || name === '7za' || name === 'jar') && archiveCommandWritesFiles(name, tokens)) {
    return block(`${name} can create or overwrite files through the shell; use write/edit for file changes.`, 'archive-extract-write', { command: name });
  }

  if (name === 'zip') {
    return block('zip creates or modifies archive files through the shell; use write/edit for file changes.', 'archive-create-write', { command: name });
  }

  if ((name === 'curl' || name === 'curl.exe') && curlWritesOutput(tokens)) {
    return block('curl output-to-file writes through the shell; use the write tool instead.', 'download-file-write', { command: name });
  }

  if ((name === 'wget' || name === 'wget.exe') && wgetWritesOutput(tokens)) {
    return block('wget writes downloaded files through the shell; use web/read tools or write explicitly.', 'download-file-write', { command: name });
  }

  if (name === 'git') return classifyGitFilesystemMutation(tokens);
  if (isPackageManagerCommand(name)) return classifyPackageManagerMutation(name, tokens);

  return allow();
}

function tarExtractsFiles(tokens) {
  return tokens.slice(1).some((token) => {
    const value = String(token || '').toLowerCase();
    return value === '--extract' || value === '--get' || (/^-[a-z]*x[a-z]*$/.test(value) && !value.startsWith('--'));
  });
}

function archiveCommandWritesFiles(name, tokens) {
  const args = tokens.slice(1).map((token) => String(token || '').toLowerCase());
  if (name === 'unzip') return !args.some((token) => token === '-l' || token === '-t' || token === '-v');
  if (name === 'jar') return args.some((token) => /^-[a-z]*[cux][a-z]*$/.test(token));
  if (name === '7z' || name === '7za') return args.some((token) => token === 'x' || token === 'e' || token === 'a' || token === 'u' || token === 'd');
  return false;
}

function curlWritesOutput(tokens) {
  return tokens.slice(1).some((token, index, args) => {
    const value = String(token || '').toLowerCase();
    if (value === '-o' || value === '--output' || value === '--create-dirs') return true;
    if (value === '-O' || value === '--remote-name' || value === '--remote-header-name') return true;
    if (value.startsWith('--output=')) return !value.endsWith('=-');
    if (value.startsWith('-o') && value.length > 2) return value !== '-o-';
    return (args[index - 1] === '-o' || args[index - 1] === '--output') && value !== '-';
  });
}

function wgetWritesOutput(tokens) {
  const args = tokens.slice(1).map((token) => String(token || '').toLowerCase());
  if (args.includes('--spider')) return false;
  if (args.includes('-o') || args.includes('--output-file')) return true;
  const outputIndex = args.findIndex((token) => token === '-O' || token === '--output-document');
  if (outputIndex >= 0) return args[outputIndex + 1] !== '-';
  if (args.some((token) => token.startsWith('--output-document=') && !token.endsWith('=-'))) return true;
  return true;
}

function classifyGitFilesystemMutation(tokens) {
  const subcommand = tokens.slice(1).find((token) => !String(token || '').startsWith('-'));
  const name = String(subcommand || '').toLowerCase();
  if (!name) return allow();
  if (new Set(['add', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'init', 'merge', 'mv', 'pull', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch']).has(name)) {
    return block(`git ${name} changes repository or workspace files through the shell; use write/edit or ask the user.`, 'git-filesystem-mutation', { command: name });
  }
  return allow();
}

function isPackageManagerCommand(name) {
  return new Set(['bun', 'cargo', 'composer', 'dotnet', 'go', 'npm', 'pip', 'pip3', 'pnpm', 'yarn']).has(name);
}

function classifyPackageManagerMutation(name, tokens) {
  const args = tokens.slice(1).map((token) => String(token || '').toLowerCase()).filter((token) => token && !token.startsWith('-'));
  const subcommand = args[0] || '';
  const mutatingByTool = {
    bun: new Set(['add', 'i', 'install', 'remove', 'rm', 'update', 'upgrade']),
    cargo: new Set(['add', 'install', 'remove', 'rm', 'update']),
    composer: new Set(['install', 'remove', 'require', 'update']),
    dotnet: new Set(['add', 'new', 'remove', 'restore']),
    go: new Set(['get', 'install', 'mod', 'work']),
    npm: new Set(['add', 'ci', 'i', 'init', 'install', 'link', 'remove', 'rm', 'uninstall', 'update']),
    pip: new Set(['install', 'uninstall']),
    pip3: new Set(['install', 'uninstall']),
    pnpm: new Set(['add', 'i', 'import', 'install', 'link', 'remove', 'rm', 'uninstall', 'update', 'upgrade']),
    yarn: new Set(['add', 'import', 'install', 'link', 'remove', 'unplug', 'upgrade'])
  };
  if (mutatingByTool[name]?.has(subcommand)) {
    return block(`${name} ${subcommand} writes files through the shell; use write/edit for file changes.`, 'package-manager-file-write', { command: name, subcommand });
  }

  if ((name === 'npm' || name === 'pnpm' || name === 'bun' || name === 'yarn') && (subcommand === 'run' || subcommand === 'run-script')) {
    const scriptName = args[1] || '';
    if (scriptName && !isReadOnlyPackageScript(scriptName)) {
      return block(`${name} ${subcommand} ${scriptName} may write files through the shell; use write/edit for file changes.`, 'package-manager-file-write', { command: name, subcommand, scriptName });
    }
  }

  return allow();
}

function isReadOnlyPackageScript(scriptName) {
  return /^(?:audit|check|doctor|lint|list|ls|outdated|status|test|typecheck|verify|why)(?::|$)/i.test(String(scriptName || ''));
}

function isSedInPlaceFlag(token) {
  const value = String(token || '').toLowerCase();
  return value === '-i' || value.startsWith('-i') || value === '--in-place' || value.startsWith('--in-place=');
}

function isPerlInPlaceFlag(token) {
  const value = String(token || '');
  if (value.startsWith('-I')) return false;
  return value === '-i' || value.startsWith('-i') || /^-[A-Za-z]*i$/.test(value) || /^-[A-Za-z]*i[A-Za-z]*$/.test(value);
}

function hasPerlEvalFlag(tokens) {
  return tokens.slice(1).some((token) => String(token || '') === '-e' || String(token || '').startsWith('-e'));
}

function perlEvalWritesFiles(tokens) {
  const code = tokens.join(' ');
  return /\bopen\s*\(?\s*[^,;]+\s*,\s*['"]?[>+wa]/i.test(code)
    || /\b(?:unlink|rename|mkdir|rmdir|chmod|chown)\s*\(/i.test(code);
}

function hasRubyEvalFlag(tokens) {
  return tokens.slice(1).some((token) => String(token || '') === '-e' || String(token || '').startsWith('-e'));
}

function rubyEvalWritesFiles(tokens) {
  const code = tokens.join(' ');
  return /\b(?:File|IO)\s*\.\s*(?:write|binwrite|delete|rename|truncate|mkdir)\s*\(/i.test(code)
    || /\bFile\s*\.\s*open\s*\([^)]*,\s*['"]?[wa]/i.test(code);
}

function hasPhpEvalFlag(tokens) {
  return tokens.slice(1).some((token) => String(token || '') === '-r' || String(token || '').startsWith('-r'));
}

function phpEvalWritesFiles(tokens) {
  const code = tokens.join(' ');
  return /\b(?:file_put_contents|fwrite|unlink|rename|mkdir|rmdir|chmod|chown)\s*\(/i.test(code)
    || /\bfopen\s*\([^)]*,\s*['"]?[wa]/i.test(code);
}

function isTeeWriteTarget(token) {
  const value = stripWrappingQuotes(String(token || '').trim());
  if (!value || value.startsWith('-')) return false;
  const lowered = value.toLowerCase();
  return lowered !== '-' && lowered !== '/dev/null' && lowered !== 'nul' && !lowered.startsWith('>(');
}

function hasNodeEvalFlag(tokens) {
  return tokens.slice(1).some((token) => {
    const value = String(token || '');
    return value === '-e'
      || value === '-p'
      || value === '--eval'
      || value === '--print'
      || value.startsWith('--eval=')
      || value.startsWith('--print=')
      || (/^-[A-Za-z]*[ep][A-Za-z]*$/.test(value) && !value.startsWith('--'));
  });
}

function nodeEvalWritesFiles(tokens) {
  const code = tokens.join(' ');
  const fsMethod = /\b(?:fs|fsp|fsPromises)(?:\s*\.\s*promises)?\s*\.\s*(?:writeFile|appendFile|createWriteStream|truncate|copyFile|cp|rename|rm|unlink|mkdir)(?:Sync)?\b/i;
  const fsImport = /\b(?:require|import)\s*\(\s*['"]?(?:node:)?fs(?:\/promises)?['"]?\s*\)/i;
  const fsWriteFunction = /\b(?:writeFile|appendFile|createWriteStream|truncate|copyFile|cp|rename|rm|unlink|mkdir)(?:Sync)?\s*\(/i;
  return fsMethod.test(code) || (fsImport.test(code) && fsWriteFunction.test(code));
}

function isPythonCommandName(name) {
  return name === 'python' || name === 'python3' || name === 'py';
}

function hasPythonEvalFlag(tokens) {
  return tokens.slice(1).some((token) => String(token || '') === '-c' || String(token || '').startsWith('-c'));
}

function pythonEvalWritesFiles(tokens) {
  const code = tokens.join(' ');
  return /\bopen\s*\([^)]*,\s*['"]?[wax]/i.test(code)
    || /\.\s*(?:write_text|write_bytes)\s*\(/i.test(code);
}

function classifyPowerShellWriteText(text) {
  if (/(?:\[\s*(?:system\.)?io\.file\s*\]|(?:system\.)?io\.file)\s*::\s*(?:writealltext|writeallbytes|appendalltext|appendallbytes)\b/i.test(text)) {
    return block('PowerShell .NET file-write calls are blocked; use the write or edit tool instead.', 'powershell-file-write');
  }
  if (/\b(?:set-content|add-content|clear-content|out-file)\b/i.test(text)) {
    return block('PowerShell content-writing commands are blocked; use the write or edit tool instead.', 'powershell-file-write');
  }
  if (/\b(?:new-item|copy-item|move-item|rename-item|remove-item)\b/i.test(text)) {
    return block('PowerShell filesystem mutation commands are blocked; use the write or edit tool instead.', 'powershell-file-write');
  }
  return allow();
}

function findShellOutputRedirection(text) {
  let quote = '';
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char !== '>') continue;

    const previous = text[index - 1] || '';
    const next = text[index + 1] || '';
    if (previous === '<' || next === '(' || next === '=') continue;
    if (next === '&' && /\d/.test(text[index + 2] || '')) continue;
    return next === '>' ? '>>' : (previous === '&' ? '&>' : '>');
  }

  return '';
}

function findShellHeredoc(text) {
  let quote = '';
  let escaped = false;

  for (let index = 0; index < text.length - 1; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '<' && text[index + 1] === '<') return text[index + 2] === '<' ? '<<<' : '<<';
  }

  return '';
}

function splitShellWriteSegments(text) {
  const segments = [];
  let current = '';
  let quote = '';
  let escaped = false;

  const push = () => {
    const value = current.trim();
    if (value) segments.push(value);
    current = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }

    if (char === ';' || char === '\n' || char === '\r') {
      push();
      continue;
    }

    if (char === '&' && text[index + 1] === '&') {
      push();
      index += 1;
      continue;
    }

    if (char === '|') {
      push();
      if (text[index + 1] === '|') index += 1;
      continue;
    }

    current += char;
  }

  push();
  return segments;
}

function classifyRm(tokens, options) {
  let recursive = false;
  const targets = [];
  let endOfFlags = false;

  for (const token of tokens.slice(1)) {
    if (!endOfFlags && token === '--') {
      endOfFlags = true;
      continue;
    }

    if (!endOfFlags && isRmFlag(token)) {
      const flag = token.toLowerCase();
      if (flag === '--recursive' || flag === '--dir' || flag.includes('r')) recursive = true;
      continue;
    }

    targets.push(token);
  }

  if (!recursive) return allow();
  const target = targets.find((entry) => isBroadDestructiveTarget(entry, options));
  if (!target) return allow();

  return ask(`Recursive delete targets a broad/system path (${target}).`, 'rm-recursive-broad-target', { target });
}

function classifyRecursivePermissionChange(tokens, options) {
  const hasRecursive = tokens.slice(1).some((token) => token === '-R' || token === '-r' || /^-[A-Za-z]*[Rr][A-Za-z]*$/.test(token) || /^--recursive$/i.test(token));
  if (!hasRecursive) return allow();

  const target = tokens.slice(1).find((token) => !token.startsWith('-') && isBroadDestructiveTarget(token, options));
  if (!target) return allow();

  return ask(`Recursive permission/ownership change targets a broad/system path (${target}).`, 'recursive-permission-broad-target', { target });
}

function classifyDd(tokens) {
  const output = tokens.find((token) => /^of=/i.test(token));
  if (!output) return allow();

  const target = output.slice(output.indexOf('=') + 1);
  if (!isRawDiskDevice(target)) return allow();

  return ask(`dd writes directly to a raw disk device (${target}).`, 'dd-raw-disk', { target });
}

function classifyFormat(tokens) {
  const target = tokens.slice(1).find((token) => /^[a-z]:$/i.test(token) || /^\\{1,2}\.\\physicaldrive\d+$/i.test(token));
  if (!target) return allow();
  return ask(`format targets a disk/drive (${target}).`, 'format-drive', { target });
}

function classifyWindowsDelete(tokens, options) {
  const name = commandName(tokens[0]);
  const hasRecursive = tokens.slice(1).some((token) => /^\/s$/i.test(token) || /^-r(?:ecurse)?$/i.test(token));
  if (!hasRecursive) return allow();

  const target = tokens.slice(1).find((token) => !/^[/-]/.test(token) && isBroadDestructiveTarget(token, options));
  if (!target) return allow();

  return ask(`${name} recursively targets a broad/system path (${target}).`, 'windows-recursive-delete-broad-target', { target });
}

function classifyPowerShellRemove(tokens, options) {
  const hasRecursive = tokens.slice(1).some((token) => /^-(r|recurse)$/i.test(token) || /^-recurse$/i.test(token));
  if (!hasRecursive) return allow();

  const target = tokens.slice(1).find((token) => !token.startsWith('-') && isBroadDestructiveTarget(token, options));
  if (!target) return allow();

  return ask(`PowerShell recursive delete targets a broad/system path (${target}).`, 'powershell-remove-item-broad-target', { target });
}

function classifyPowerShellText(text, options) {
  if (!/\b(remove-item|ri)\b/i.test(text)) return allow();
  if (!/(?:-|\/)\s*(?:recurse|r)\b/i.test(text)) return allow();

  const broadTargetPattern = /(^|\s)(?:['"]?(?:[a-z]:[\\/](?:\*)?|~(?:[\\/]\*)?|\.\.?[\\/]?(?:\*)?|\*|\$env:(?:userprofile|home)(?:[\\/]\*)?|%userprofile%(?:[\\/]\*)?|\/(?:\*)?)['"]?)(?=\s|$)/i;
  if (broadTargetPattern.test(text)) return ask('PowerShell recursive delete targets a broad/system path.', 'powershell-remove-item-broad-target');

  for (const token of shellTokenize(text)) {
    if (isBroadDestructiveTarget(token, options)) {
      return ask(`PowerShell recursive delete targets a broad/system path (${token}).`, 'powershell-remove-item-broad-target', { target: token });
    }
  }

  return allow();
}

function isRmFlag(token) {
  if (!token || token === '-') return false;
  if (token === '--recursive' || token === '--dir' || token === '--force' || token === '--interactive=never' || token === '--no-preserve-root') return true;
  if (token.startsWith('--')) return false;
  return /^-[A-Za-z]+$/.test(token);
}

function isBroadDestructiveTarget(target, options = {}) {
  const raw = stripWrappingQuotes(String(target || '').trim());
  if (!raw) return false;

  const lowered = raw.toLowerCase();
  if (new Set(['/', '/*', '/**', '~', '~/', '~/*', '~/**', '$home', '$home/', '$home/*', '${home}', '${home}/', '${home}/*', '.', './', './*', './**', '..', '../', '../*', '../**', '*']).has(lowered)) {
    return true;
  }

  if (/^[a-z]:[\\/](?:\*|\*\*)?$/i.test(raw)) return true;
  if (/^\\{1,2}\.\\physicaldrive\d+$/i.test(raw)) return true;
  if (/^%userprofile%(?:[\\/](?:\*|\*\*)?)?$/i.test(raw)) return true;
  if (/^\$env:(?:userprofile|home)(?:[\\/](?:\*|\*\*)?)?$/i.test(raw)) return true;

  return isHomeDirectoryTarget(raw, options.homeDir) || isWorkspaceWideTarget(raw, options.cwd);
}

function isHomeDirectoryTarget(target, homeDir) {
  if (!homeDir) return false;
  const normalizedTarget = normalizePathLike(target);
  const normalizedHome = normalizePathLike(homeDir);
  return normalizedTarget === normalizedHome || normalizedTarget === `${normalizedHome}/*` || normalizedTarget === `${normalizedHome}/**`;
}

function isWorkspaceWideTarget(target, cwd) {
  if (!cwd) return false;
  const raw = stripWrappingQuotes(String(target || '').trim());
  if (!raw || raw.startsWith('-')) return false;
  if (!/^(?:\.\.?|\.\.?[\\/]|\*)/.test(raw)) return false;
  return new Set(['.', './', './*', './**', '..', '../', '../*', '../**', '*']).has(raw.replace(/\\/g, '/').toLowerCase());
}

function isRawDiskDevice(target) {
  const raw = stripWrappingQuotes(String(target || '').trim());
  return /^\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d+n\d+|mmcblk\d+|disk\d+|rdisk\d+)$/i.test(raw) || /^\\{1,2}\.\\physicaldrive\d+$/i.test(raw);
}

function stripCommandPrefix(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const name = commandName(tokens[index]);
    if (name === 'sudo' || name === 'doas') {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const flag = tokens[index];
        index += 1;
        if (/^-(?:u|g|h|p|C|T|t|U)$/.test(flag) || /^--(?:user|group|host|prompt|chdir|role|type|other-user)$/i.test(flag)) {
          index += 1;
        }
      }
      continue;
    }
    if (name === 'env') {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index += 1;
      continue;
    }
    if (name === 'command' || name === 'builtin' || name === 'time') {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function commandName(token) {
  const value = stripWrappingQuotes(String(token || '').trim());
  if (!value) return '';
  const base = value.split(/[\\/]/).pop() || value;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

function splitShellSegments(text) {
  return text
    .split(/(?:\r?\n|&&|\|\||;)/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function shellTokenize(input) {
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;
  const text = String(input || '');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      const next = text[index + 1] || '';
      if (quote !== "'" && (!next || /[\s"'\\$`]/.test(next))) {
        escaped = true;
      } else {
        current += char;
      }
      continue;
    }

    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}

function normalizeCommandText(command) {
  return String(command || '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\u0000/g, '')
    .trim();
}

function normalizePathLike(value) {
  return stripWrappingQuotes(String(value || '').trim())
    .replace(/\\/g, '/')
    .replace(/[\/]+$/g, '')
    .toLowerCase();
}

function stripWrappingQuotes(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function safeHomeDir() {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

function allow() {
  return { action: 'allow' };
}

function ask(reason, rule, extra = {}) {
  return { action: 'ask', reason, rule, ...extra };
}

function block(reason, rule, extra = {}) {
  return { action: 'block', reason, rule, ...extra };
}

module.exports = {
  GUARDRAIL_MODE_ASK,
  GUARDRAIL_MODE_OFF,
  classifyCommand,
  classifyShellWriteCommand,
  guardrailsAreDisabled,
  normalizeGuardrails,
  normalizeGuardrailsMode,
  shouldAskCommandApproval,
  shouldBlockShellWriteCommand
};
