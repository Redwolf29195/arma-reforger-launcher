// SPDX-License-Identifier: GPL-3.0-only
'use strict';

// Offline publication check. Findings contain only file paths and issue types.
// Pass --files-list to validate an exact newline-separated publication manifest.
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_KEY_PATH = 'src/security/release-public-key.pem';
const ROOT_FILES = new Set([
  '.gitignore', 'AGENTS.md', 'LICENSE', 'README.md', 'RELEASE-PROCESS.md',
  'THIRD_PARTY_NOTICES.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'electron-builder.release.cjs', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'
]);
const SOURCE_ROOTS = new Set(['src', 'scripts', 'tests', 'support', '.github']);
const GENERATED_ROOTS = /^(?:\.git|node_modules|\.pnpm-store|dist(?:-.*)?|release|artifacts|coverage|\.build(?:-staging)?|\.secure-build|\.local-.*)$/i;
const PRIVATE_NAMES = /(?:^|\/)(?:backups?|private|secrets?|release-keys|ReleaseKeys|\.algz-release-key[^/]*|\.env(?:\.(?!example$)[^/]*)?|AI-HANDOFF\.md|CHAT-HANDOFF-[^/]*|LOCAL-ENVIRONMENT\.md|MOVE-TO-NEW-PC\.md|FULL-PROJECT-TRANSFER\.md|TRANSFER-MANIFEST\.json|RESTORE-FULL\.ps1|(?:prepare|restore)-(?:full-)?project-transfer\.ps1|verify-project-transfer\.js|full-transfer-common\.ps1)(?:\/|$)/i;
const PRIVATE_EXTENSIONS = /\.(?:pem|key|pfx|p12|p8|ppk|zip|7z|rar|tar|gz|age|gpg|log|dmp|sqlite|sqlite3|db|bak)$/i;
const TEXT_EXTENSIONS = /\.(?:js|cjs|mjs|json|ya?ml|ps1|c|gproj|md|html|css|txt|svg)$/i;
const PUBLIC_BINARY_ASSETS = /^(?:src\/renderer\/assets\/[^\r\n]+\.(?:png|jpe?g|webp|ico|ttf|woff2?)|support\/ALGZLauncherWorkshopBridge\/resourceDatabase\.rdb)$/i;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

function normalizeRelative(value) {
  return String(value).replace(/\\/g, '/');
}

function collectCandidateFiles(root) {
  const files = [];
  const ignoredRoots = [];
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && GENERATED_ROOTS.test(entry.name)) {
        ignoredRoots.push(entry.name);
        continue;
      }
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name);
      else files.push(name);
    }
  }
  visit(root);
  return { files: files.sort(), ignoredRoots: ignoredRoots.sort() };
}

function auditFiles(root, filenames) {
  const findings = [];
  const inspected = new Set();
  const absoluteRoot = path.resolve(root);
  const add = (file, type) => findings.push({ path: file, type });
  for (const original of filenames) {
    const file = normalizeRelative(original);
    if (!file || inspected.has(file)) continue;
    inspected.add(file);
    if (file.includes('\0') || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file)
      || file.split('/').some(part => !part || part === '..' || part === '.')) {
      add(file, 'unsafe-relative-path');
      continue;
    }
    if (PRIVATE_NAMES.test(file) || (file !== PUBLIC_KEY_PATH && PRIVATE_EXTENSIONS.test(file))) {
      add(file, 'private-or-generated-file');
      continue; // Never open private keys, backups, logs or databases.
    }
    const parts = file.split('/');
    if (!ROOT_FILES.has(file) && !(parts.length > 1 && SOURCE_ROOTS.has(parts[0]))) {
      add(file, 'outside-public-allowlist');
      continue;
    }
    let current = absoluteRoot;
    let stat;
    let inaccessible = false;
    for (const part of parts) {
      current = path.join(current, part);
      try { stat = fs.lstatSync(current); } catch { add(file, 'missing-or-unreadable-file'); inaccessible = true; break; }
      if (stat.isSymbolicLink()) { add(file, 'symbolic-link'); inaccessible = true; break; }
    }
    if (inaccessible) continue;
    if (!stat.isFile()) { add(file, 'not-a-regular-file'); continue; }
    const isText = ROOT_FILES.has(file) || TEXT_EXTENSIONS.test(file) || file === PUBLIC_KEY_PATH;
    if (!isText) {
      if (!PUBLIC_BINARY_ASSETS.test(file)) add(file, 'unrecognized-binary-or-data-file');
      continue;
    }
    if (stat.size > MAX_TEXT_BYTES) { add(file, 'text-file-too-large-to-audit'); continue; }
    let contents;
    try { contents = fs.readFileSync(current, 'utf8'); } catch { add(file, 'missing-or-unreadable-file'); continue; }
    if (file === PUBLIC_KEY_PATH) {
      if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/.test(contents)) {
        add(file, 'invalid-public-verification-key-envelope');
      }
      continue;
    }
    // A quoted marker used by a defensive test is not private-key material.
    if (/^\s*-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*$/m.test(contents)
      || /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{24,}/.test(contents)) {
      add(file, 'private-key-material');
    }
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{24,})\b/.test(contents)) {
      add(file, 'credential-shaped-token');
    }
    if (/Bearer\s+[A-Za-z0-9_.-]{24,}/i.test(contents)
      || /https?:\/\/[^\s/:"'<>]+:[^\s/@"'<>]+@/i.test(contents)) {
      add(file, 'embedded-authentication');
    }
    const credentialAssignments = [...contents.matchAll(/(?<![\w.-])(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*(["'])([^"'\r\n]{4,})\1/gi)];
    if (credentialAssignments.some(match => !/^(?:example|test|dummy|placeholder|redacted|changeme|password)$/i.test(match[2]))) {
      add(file, 'credential-literal-assignment');
    }
    if (/(?:[A-Z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b)|User(?:[\\/]|\b))[^\s/\\"']+|\/home\/(?!example(?:\/|\b)|user(?:\/|\b))[^\s/"']+)/i.test(contents)) {
      add(file, 'personal-home-path');
    }
  }
  return { ok: findings.length === 0, filesAudited: inspected.size, findings };
}

function main(args = process.argv.slice(2)) {
  let root = path.resolve(__dirname, '..');
  let listPath;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else if (args[index] === '--files-list' && args[index + 1]) listPath = path.resolve(args[++index]);
    else throw new Error('Usage: node scripts/audit-public-source.js [--root PATH] [--files-list PATH]');
  }
  const selection = listPath
    ? { files: fs.readFileSync(listPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean), ignoredRoots: [] }
    : collectCandidateFiles(root);
  const report = { ...auditFiles(root, selection.files), ignoredRoots: selection.ignoredRoots };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch { process.stderr.write('Public source audit failed to read the requested tree or file list.\n'); process.exitCode = 1; }
}

module.exports = { auditFiles, collectCandidateFiles, main };
