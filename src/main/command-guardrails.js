const os = require('node:os');

const GUARDRAIL_MODE_ASK = 'ask';
const GUARDRAIL_MODE_OFF = 'off';
const GUARDRAIL_MODES = new Set([GUARDRAIL_MODE_ASK, GUARDRAIL_MODE_OFF]);

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

module.exports = {
  GUARDRAIL_MODE_ASK,
  GUARDRAIL_MODE_OFF,
  classifyCommand,
  guardrailsAreDisabled,
  normalizeGuardrails,
  normalizeGuardrailsMode,
  shouldAskCommandApproval
};
