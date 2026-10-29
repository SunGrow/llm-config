#!/usr/bin/env node
// Claude Code PostToolUse hook (Write|Edit|MultiEdit): run the fast checker for the edited file and hand any
// error straight back to Claude. Silent when the file is fine, unknown, or the check tool is missing.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, extname } from 'node:path';
import { optedOut, readStdinJson } from './common.mjs';

const MAX_BYTES = 2 << 20;

// Control characters other than tab, LF, CR and ESC: the usual trace of a shell eating a backslash (\b -> 0x08).
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F]/;

function run(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error) return null; // tool not installed: skip
  return r;
}

export function checkFile(path) {
  const problems = [];
  if (!existsSync(path)) return problems;
  const buf = readFileSync(path);
  if (buf.length > MAX_BYTES || buf.includes(0)) return problems; // large or binary
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const ctl = lines.findIndex(l => CONTROL.test(l));
  if (ctl >= 0) {
    const ch = lines[ctl].match(CONTROL)[0].charCodeAt(0);
    problems.push(`line ${ctl + 1} contains control character 0x${ch.toString(16).padStart(2, '0')} (often a backslash lost to shell escaping; rewrite the line with the Edit tool)`);
  }
  if (/^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text)) problems.push('contains merge conflict markers');
  const ext = extname(path).toLowerCase(), name = basename(path).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const r = run(process.execPath, ['--check', path]);
    if (r && r.status !== 0) problems.push('node --check: ' + (r.stderr || r.stdout).trim().split('\n').slice(0, 6).join('\n'));
  } else if (ext === '.json' && !/^(tsconfig|jsconfig).*\.json$|^devcontainer\.json$|\.code-workspace$/.test(name) && !/[\\/]\.vscode[\\/]/.test(path)) {
    try { JSON.parse(text.replace(/^﻿/, '')); } catch (e) { problems.push('JSON: ' + e.message); }
  } else if (ext === '.py') {
    const r = run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'py_compile', path]);
    if (r && r.status === 1 && /Error/.test(r.stderr)) problems.push('py_compile: ' + r.stderr.trim().split('\n').slice(-4).join('\n'));
  } else if (ext === '.sh' || ext === '.bash') {
    const r = run('bash', ['-n', path]);
    if (r && r.status === 2 && r.stderr) problems.push('bash -n: ' + r.stderr.trim().split('\n').slice(0, 4).join('\n'));
  }
  return problems;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  try {
    const input = readStdinJson();
    const path = input?.tool_input?.file_path;
    if (path && !optedOut(input.cwd)) {
      const problems = checkFile(path);
      if (problems.length) {
        console.log(JSON.stringify({ decision: 'block', reason: `Post-edit check of ${path}:\n- ${problems.join('\n- ')}\nFix this before continuing.` }));
      }
    }
  } catch { /* never break the session */ }
}
