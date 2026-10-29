#!/usr/bin/env node
// Commit what is staged (and optionally push) after deterministic checks: message free of AI attribution, staged
// diff free of secrets and private patterns. Asks for confirmation on a terminal and refuses without one, so an
// agent cannot use it to get around the commit gate: run it in your own terminal.
// Usage: node safe-commit.mjs -F <message file> [-C <repo>] [--push] [--sign]
// Private patterns: one regex per line in ~/.config/llm-config/private-patterns (plus your home folder path).
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const ATTRIBUTION = /co-authored-by:[^\n]*(claude|anthropic|openai|chatgpt|gpt|copilot|gemini|cursor|codex)|generated (with|by)[^\n]*(claude|ai\b|gpt|copilot|gemini)|noreply@anthropic\.com|\u{1F916}/iu;
const SECRET = /\b(sk-[A-Za-z0-9_-]{20,}|sk-or-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function privatePatterns(home = homedir()) {
  const pats = [home, home.replace(/\\/g, '/')].map(h => new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const f = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'llm-config', 'private-patterns');
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
    try { pats.push(new RegExp(l, 'i')); } catch { /* skip a bad line */ }
  }
  return pats;
}

// Only added lines count: removing a leaked value must stay possible.
export function scanDiff(diff, patterns) {
  const hits = [];
  let file = '';
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(6); continue; }
    if (!l.startsWith('+') || l.startsWith('+++')) continue;
    if (SECRET.test(l)) hits.push(`${file}: secret-like value`);
    for (const p of patterns) if (p.test(l)) hits.push(`${file}: matches private pattern /${p.source.slice(0, 40)}/`);
  }
  return [...new Set(hits)];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2), opt = (k) => a.includes(k) ? a[a.indexOf(k) + 1] : null;
  const repo = opt('-C') || process.cwd(), msgFile = opt('-F');
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const die = (m, code = 1) => { console.error('safe-commit: ' + m); process.exit(code); };
  if (!process.stdin.isTTY || !process.stdout.isTTY) die('needs an interactive terminal (it asks before committing); run it yourself, not through an agent', 3);
  if (!msgFile || !existsSync(msgFile)) die('usage: safe-commit.mjs -F <message file> [-C <repo>] [--push] [--sign]', 2);
  const msg = readFileSync(msgFile, 'utf8');
  if (!msg.trim()) die('empty commit message');
  if (ATTRIBUTION.test(msg)) die('commit message contains AI attribution; remove it');
  const files = git('diff', '--cached', '--name-only').stdout.trim().split('\n').filter(Boolean);
  if (!files.length) die('nothing staged');
  const hits = scanDiff(git('diff', '--cached', '--no-color', '-U0').stdout, privatePatterns());
  if (hits.length) die('staged changes look private:\n  ' + hits.slice(0, 20).join('\n  '));
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const email = git('config', 'user.email').stdout.trim();
  console.log(`Repo ${repo}\nBranch ${branch}, author email ${email}\n${files.length} file(s): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ' ...' : ''}\nMessage: ${msg.split('\n')[0]}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const yes = /^y(es)?$/i.test((await rl.question(`Commit${a.includes('--push') ? ' and push' : ''}? [y/N] `)).trim());
  rl.close();
  if (!yes) die('cancelled', 1);
  const c = spawnSync('git', ['-C', repo, 'commit', ...(a.includes('--sign') ? ['-S'] : []), '-F', msgFile], { stdio: 'inherit' });
  if (c.status !== 0) die('git commit failed', c.status || 1);
  if (a.includes('--push')) { const p = spawnSync('git', ['-C', repo, 'push'], { stdio: 'inherit' }); if (p.status !== 0) die('git push failed', p.status || 1); }
}
