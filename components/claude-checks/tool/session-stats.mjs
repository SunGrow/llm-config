#!/usr/bin/env node
// Per-session numbers from Claude Code transcripts, for before/after comparisons of config changes. Read-only.
// Usage: node session-stats.mjs [--days 7] [--project <substring>] [--top 15] [--json]
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { parseLines, isTypedPrompt } from './common.mjs';

export function sessionStats(entries) {
  const s = { prompts: 0, interrupts: 0, compactions: 0, toolCalls: 0, toolErrors: 0, gateAsks: 0, repeatedCommands: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, tools: {}, models: {}, first: null, last: null };
  const seenMsg = new Set(), cmds = new Map(), gateIds = new Set();
  let prevT = 0;
  s.activeMs = 0;
  for (const e of entries) {
    if (e.timestamp) { s.first ??= e.timestamp; s.last = e.timestamp; }
    const c = e.message?.content;
    if (e.type === 'user') {
      const text = typeof c === 'string' ? c : '';
      if (text.startsWith('This session is being continued from a previous conversation')) s.compactions++;
      else if (/^\[Request interrupted/.test(text) || (Array.isArray(c) && c.some(x => x.type === 'text' && /^\[Request interrupted/.test(x.text)))) s.interrupts++;
      else if (isTypedPrompt(e)) s.prompts++;
      if (Array.isArray(c)) for (const x of c) if (x.type === 'tool_result' && x.is_error) s.toolErrors++;
    }
    if (e.type === 'assistant') {
      const id = e.message?.id;
      if (id && !seenMsg.has(id) && e.message.usage) {
        seenMsg.add(id);
        const u = e.message.usage;
        s.tokens.input += u.input_tokens || 0; s.tokens.cacheRead += u.cache_read_input_tokens || 0;
        s.tokens.cacheWrite += u.cache_creation_input_tokens || 0; s.tokens.output += u.output_tokens || 0;
        const m = e.message.model || '?'; s.models[m] = (s.models[m] || 0) + 1;
      }
      for (const x of Array.isArray(c) ? c : []) {
        if (x.type !== 'tool_use') continue;
        s.toolCalls++; s.tools[x.name] = (s.tools[x.name] || 0) + 1;
        const cmd = x.input?.command;
        if (cmd) cmds.set(cmd, (cmds.get(cmd) || 0) + 1);
      }
    }
    // Permission asks from PreToolUse hooks (the Jev gate): hook_success attachments whose stdout asks; once per tool call.
    const at = e.attachment;
    if (e.type === 'attachment' && at?.type === 'hook_success' && at.hookEvent === 'PreToolUse' && /"permissionDecision"\s*:\s*"ask"/.test(at.stdout || '')) gateIds.add(at.toolUseID || e.uuid);
    if (e.timestamp) { const t = Date.parse(e.timestamp); if (prevT && t > prevT) s.activeMs += Math.min(t - prevT, IDLE_MS); prevT = t; }
  }
  s.gateAsks = gateIds.size;
  s.repeatedCommands = [...cmds.values()].filter(n => n >= 3).length;
  return s;
}

// Active time: gaps between transcript events, each capped at IDLE_MS, so overnight pauses do not count.
const IDLE_MS = 15 * 60e3;
const hours = (s) => s.activeMs / 3600e3;

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const a = process.argv.slice(2), opt = (k, d) => a.includes(k) ? a[a.indexOf(k) + 1] : d;
  const days = Number(opt('--days', 7)), proj = opt('--project', ''), top = Number(opt('--top', 15));
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const since = Date.now() - days * 86400e3, rows = [];
  for (const d of readdirSync(root)) {
    if (proj && !d.toLowerCase().includes(proj.toLowerCase())) continue;
    let files; try { files = readdirSync(join(root, d)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = join(root, d, f);
      if (statSync(p).mtimeMs < since) continue;
      const s = sessionStats(parseLines(readFileSync(p, 'utf8')));
      if (!s.prompts && !s.toolCalls) continue;
      rows.push({ project: d, session: f.slice(0, 8), ...s });
    }
  }
  const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
  const total = { sessions: rows.length, prompts: sum(r => r.prompts), toolCalls: sum(r => r.toolCalls), toolErrors: sum(r => r.toolErrors),
    interrupts: sum(r => r.interrupts), compactions: sum(r => r.compactions), gateAsks: sum(r => r.gateAsks), repeatedCommands: sum(r => r.repeatedCommands),
    outputTokens: sum(r => r.tokens.output), hours: +sum(hours).toFixed(1) };
  if (a.includes('--json')) { console.log(JSON.stringify({ days, total, sessions: rows }, null, 1)); process.exit(0); }
  console.log(`Last ${days} day(s)${proj ? `, projects matching "${proj}"` : ''}:`);
  console.table([total]);
  console.table(rows.sort((x, y) => y.toolCalls - x.toolCalls).slice(0, top).map(r => ({
    project: r.project.slice(-28), session: r.session, hours: +hours(r).toFixed(1), prompts: r.prompts, tools: r.toolCalls,
    'err %': r.toolCalls ? Math.round(100 * r.toolErrors / r.toolCalls) : 0, interrupts: r.interrupts, compact: r.compactions,
    gate: r.gateAsks, 'repeat cmds': r.repeatedCommands, 'out tok': r.tokens.output,
  })));
}
