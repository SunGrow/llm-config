// Shared helpers for the deterministic Claude Code checks (no model calls).
import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync, appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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
  try { return fromGrok(JSON.parse(readFileSync(0, 'utf8') || '{}')); } catch { return null; }
}

// Grok runs the hooks in ~/.claude/settings.json with its own tool names, input keys and result shapes, plus
// Claude's snake_case keys. Hooks see Claude's names; `harness: 'grok'` marks the rest (results, transcript).
const GROK_TOOLS = { run_terminal_command: 'Bash', read_file: 'Read', search_replace: 'Edit', write: 'Write', grep: 'Grep', list_dir: 'Glob', web_fetch: 'WebFetch', web_search: 'WebSearch', spawn_subagent: 'Agent' };
export function fromGrok(input) {
  if (typeof input?.hookEventName !== 'string') return input;
  const raw = String(input.tool_name || ''), ti = { ...(input.tool_input || {}) };
  const tool = GROK_TOOLS[raw] || (raw.includes('__') && !raw.startsWith('mcp__') ? 'mcp__' + raw : raw);
  if (ti.file_path == null && ti.target_file != null) ti.file_path = ti.target_file;
  if (ti.file_path != null && input.cwd) ti.file_path = resolve(input.cwd, String(ti.file_path));
  if (ti.path == null && ti.target_directory != null) ti.path = ti.target_directory;
  return { ...input, harness: 'grok', grok_tool_name: raw, tool_name: input.tool_name == null ? undefined : tool, tool_input: ti, agent_id: input.agent_id ?? input.subagentType };
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
