#!/usr/bin/env node
// Hooks fail open, so a broken one goes quiet instead of failing loudly. This finds two kinds of breakage:
// a registered hook whose program or script file is missing, and errors the hooks logged since the last report.
// --hook: SessionStart (startup). Prints a short note only when something is wrong, once per new problem.
// Without --hook: prints the full report for the user.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readStdinJson, optedOut, HOOK_ERRORS, logHookError } from './common.mjs';

const SCRIPT = /\.(m?js|cjs|ps1|py|sh|bat|cmd|exe)$/i;
const SEEN = process.env.AGENTS_HOOK_HEALTH_SEEN || join(homedir(), '.agents', 'cache', 'hook-health.seen');

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// Settings files that can register hooks for a session in `cwd`.
export function settingsFiles(cwd) {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const files = [join(home, 'settings.json')];
  if (cwd) files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
  return files.filter(existsSync);
}

// Command hooks whose program or script path does not exist. Only absolute paths are checked; a bare
// program name (node, pwsh) is resolved through PATH by the shell and is left alone.
export function missingFiles(settingsPaths) {
  const out = [];
  for (const f of settingsPaths) {
    const hooks = readJson(f)?.hooks || {};
    for (const [event, groups] of Object.entries(hooks)) for (const g of groups || []) for (const h of g.hooks || []) {
      if (h.type !== 'command') continue;
      const parts = h.args ? [h.command, ...h.args] : String(h.command || '').match(/"[^"]+"|'[^']+'|\S+/g) || [];
      for (const raw of parts) {
        const p = String(raw).replace(/^["']|["']$/g, '');
        if ((p === parts[0] || SCRIPT.test(p)) && isAbsolute(p) && !p.includes('$') && !existsSync(p)) out.push({ event, matcher: g.matcher || '', path: p, settings: f });
      }
    }
  }
  return out;
}

// Logged hook errors after `since` (ISO time), counted per hook with the latest message.
export function recentErrors(since = '', logPath = HOOK_ERRORS) {
  let text = ''; try { text = readFileSync(logPath, 'utf8'); } catch { return []; }
  const by = new Map();
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e?.t || e.t <= since) continue;
    const r = by.get(e.hook) || { hook: e.hook, count: 0, last: '', err: '' };
    r.count++; if (e.t >= r.last) { r.last = e.t; r.err = e.err; }
    by.set(e.hook, r);
  }
  return [...by.values()];
}

export function report({ cwd, since } = {}) {
  const missing = missingFiles(settingsFiles(cwd));
  const errors = recentErrors(since);
  const lines = [
    ...missing.map(m => `- ${m.event}${m.matcher ? ' ' + m.matcher : ''}: ${m.path} does not exist (registered in ${m.settings})`),
    ...errors.map(e => `- ${e.hook}: ${e.count} error(s), latest ${e.last}: ${e.err.slice(0, 300)}`),
  ];
  return { missing, errors, lines };
}

if (process.argv[1]?.endsWith('hook-health.mjs')) {
  const asHook = process.argv.includes('--hook');
  try {
    const input = asHook ? readStdinJson() : { cwd: process.cwd() };
    if (!(asHook && optedOut(input?.cwd))) {
      const seen = asHook ? (() => { try { return readFileSync(SEEN, 'utf8').trim(); } catch { return ''; } })() : '';
      const r = report({ cwd: input?.cwd, since: seen.split('\n')[0] });
      // Missing files repeat every session until fixed, so they are reported once per distinct set.
      const missKey = r.missing.map(m => m.path).sort().join('|');
      const prev = seen.split('\n')[1] || '';
      const show = asHook ? [...(missKey !== prev ? r.lines.slice(0, r.missing.length) : []), ...r.lines.slice(r.missing.length)] : r.lines;
      if (asHook) {
        mkdirSync(dirname(SEEN), { recursive: true });
        writeFileSync(SEEN, new Date().toISOString() + '\n' + missKey);
        if (show.length) console.log(`Hook health: some Claude Code hooks are broken and are being skipped silently. Tell the user once, briefly, and suggest running node "${process.argv[1].replace(/\\/g, '/')}" for the full report:\n${show.join('\n')}`);
      } else {
        console.log(show.length ? show.join('\n') : 'All registered hook files exist; no hook errors logged.');
        console.log(`(error log: ${HOOK_ERRORS})`);
      }
    }
  } catch (e) { if (asHook) logHookError('hook-health', e); else throw e; }
}
