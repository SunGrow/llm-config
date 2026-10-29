// Shared helpers for the deterministic Claude Code checks (no model calls).
import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync, appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Hooks fail open, so their errors would vanish. They append here instead; hook-health.mjs reports them.
// Same path and format as logHookError in the jev component.
export const HOOK_ERRORS = process.env.AGENTS_HOOK_ERRORS || join(homedir(), '.agents', 'cache', 'hook-errors.log');
export function logHookError(hook, e) {
  try {
    mkdirSync(dirname(HOOK_ERRORS), { recursive: true });
    try { if (statSync(HOOK_ERRORS).size > 256 << 10) writeFileSync(HOOK_ERRORS, readFileSync(HOOK_ERRORS, 'utf8').slice(-(128 << 10)).replace(/^[^\n]*\n/, '')); } catch { /* no log yet */ }
    appendFileSync(HOOK_ERRORS, JSON.stringify({ t: new Date().toISOString(), hook, err: String(e?.stack || e).split('\n').slice(0, 3).join(' | ') }) + '\n');
  } catch { /* nowhere to report */ }
}

// Off everywhere: env CLAUDE_CHECKS=0. Off in one project: .claude/checks-off or .agents/checks-off.
export function optedOut(cwd) {
  if (process.env.CLAUDE_CHECKS === '0') return true;
  if (!cwd) return false;
  return existsSync(join(cwd, '.claude', 'checks-off')) || existsSync(join(cwd, '.agents', 'checks-off'));
}

export function readStdinJson() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return null; }
}

// Last `bytes` of a file as text (whole lines only).
export function tail(path, bytes = 8 << 20) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size, len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8');
    return len < size ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { closeSync(fd); }
}

// A typed user prompt (not a tool result, harness message or compaction summary).
export function isTypedPrompt(e) {
  if (e?.type !== 'user' || e.isMeta) return false;
  const c = e.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) && c.every(x => x.type === 'text') ? c.map(x => x.text).join('\n') : null;
  if (text == null) return false;
  const t = text.trim();
  return !!t && !t.startsWith('<') && !t.startsWith('This session is being continued from a previous conversation');
}

export function parseLines(text) {
  const out = [];
  for (const s of text.split('\n')) { if (!s) continue; try { out.push(JSON.parse(s)); } catch { /* partial line */ } }
  return out;
}
