#!/usr/bin/env node
// Subagent context size. Every call a subagent makes re-reads its whole context, so a long-lived agent costs more
// with each step. In one 17-hour jam session, calls at 200k tokens of context or more were 63% of the spend, and the
// two biggest agents compacted 20 and 18 times. Two checks, both fail open:
// - agentSizeNote (PostToolUse inside a subagent, run by post-tool.mjs): when the agent's context passes LIMIT, and
//   again every STEP above it, tell it to finish the step it is on and end with a handoff.
// - sendDecision (PreToolUse SendMessage on the main thread, this file's CLI): when the target subagent's context is
//   past LIMIT, deny once per STEP band and point to a fresh agent; re-issuing the same call goes through.
// The state file per agent (ctx, last band told) also shows that the hook found the agent's transcript.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { tail, optedOut, readStdinJson, logHookError } from './common.mjs';
import { firstTime } from './once.mjs';

export const LIMIT = Number(process.env.CLAUDE_CHECKS_AGENT_LIMIT) || 150000;
export const STEP = 50000;
const STATE = process.env.CLAUDE_CHECKS_AGENT_STATE || join(homedir(), '.agents', 'cache', 'claude-checks-agent-size');
const ID = /^a[0-9a-f]{12,}$/;

// The subagent's own transcript: the hook's transcript_path itself, or <session>/subagents/agent-<id>.jsonl beside it.
export function agentTranscript(transcriptPath, sessionId, agentId) {
  if (!transcriptPath || !agentId) return null;
  if (basename(transcriptPath) === `agent-${agentId}.jsonl`) return transcriptPath;
  const dir = dirname(transcriptPath), name = `agent-${agentId}.jsonl`;
  for (const base of [basename(transcriptPath, '.jsonl'), sessionId].filter(Boolean)) {
    const p = join(dir, base, 'subagents', name);
    if (existsSync(p)) return p;
  }
  const up = join(dirname(dir), name); // transcript_path already inside subagents/
  return existsSync(up) ? up : null;
}

// Context of the newest assistant call: input + cache write + cache read tokens. Null when none is found.
export function lastContext(path) {
  for (const bytes of [1 << 20, 8 << 20, 32 << 20]) {
    let text; try { text = tail(path, bytes); } catch { return null; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"') || !lines[i].includes('"usage"')) continue;
      try {
        const u = JSON.parse(lines[i]).message?.usage;
        if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      } catch { /* partial line */ }
    }
    try { if (statSync(path).size <= bytes) return null; } catch { return null; }
  }
  return null;
}

const band = (ctx) => Math.floor((ctx - LIMIT) / STEP);
const k = (n) => Math.round(n / 1000) + 'k';

function record(agentId, data) {
  try {
    mkdirSync(STATE, { recursive: true });
    for (const f of readdirSync(STATE)) { const p = join(STATE, f); try { if (Date.now() - statSync(p).mtimeMs > 3 * 86400e3) unlinkSync(p); } catch { /* raced */ } }
    const p = join(STATE, agentId.replace(/[^A-Za-z0-9-]/g, '') + '.json');
    let old = {}; try { old = JSON.parse(readFileSync(p, 'utf8')); } catch { /* first */ }
    writeFileSync(p, JSON.stringify({ ...old, ...data, t: new Date().toISOString() }));
    return old;
  } catch { return {}; }
}

export const NOTE = (ctx) => `Context note: this subagent's context is ${k(ctx)} tokens, past the ${k(LIMIT)} working limit, and each further call re-reads all of it. Finish the step you are on, then end with a handoff in your final report: what is done (with evidence), what is left, the files involved and open questions. The coordinator starts a fresh agent for the rest.`;

// PostToolUse inside a subagent: the note, or null.
export function agentSizeNote(input) {
  if (!input?.agent_id || input.harness === 'grok' || !ID.test(String(input.agent_id))) return null;
  const id = String(input.agent_id);
  const p = agentTranscript(input.transcript_path, input.session_id, id);
  if (!p) { if (firstTime('agent-size-missing\n' + id, 86400e3)) logHookError('agent-size', `no transcript for agent ${id} near ${input.transcript_path}`); return null; }
  const ctx = lastContext(p);
  if (ctx == null) return null;
  const b = ctx >= LIMIT ? band(ctx) : -1;
  const old = record(id, { ctx, told: b });
  return b >= 0 && (old.told ?? -1) < b ? NOTE(ctx) : null;
}

// Agent id for a SendMessage target: an agentId as given, or the id returned by the latest Agent call with that
// name (a newer agent takes over a name).
export function resolveAgent(to, mainTranscript) {
  const s = String(to || '').trim();
  if (ID.test(s)) return s;
  if (!s || s === 'main' || !mainTranscript) return null;
  let text; try { text = readFileSync(mainTranscript, 'utf8'); } catch { return null; }
  let useId = null, found = null;
  for (const line of text.split('\n')) {
    if (line.includes('"name":"Agent"') && line.includes(JSON.stringify(s))) {
      try { for (const c of JSON.parse(line).message?.content || []) if (c.type === 'tool_use' && c.name === 'Agent' && c.input?.name === s) useId = c.id; } catch { /* */ }
    } else if (useId && line.includes(useId)) {
      const m = line.match(/agentId: (a[0-9a-f]{12,})/);
      if (m) { found = m[1]; useId = null; }
    }
  }
  return found;
}

export const DENY = (ctx) => `This subagent's context is ${k(ctx)} tokens, past the ${k(LIMIT)} working limit, so each call it makes re-reads all of that. For new work, start a fresh agent with a brief built from this one's last report. To answer a question it is waiting on, or to let it finish its current step, re-issue the same message.`;

// PreToolUse SendMessage on the main thread: { deny } or {}.
export function sendDecision(input) {
  if (input?.agent_id || input?.tool_name !== 'SendMessage' || optedOut(input.cwd)) return {};
  const id = resolveAgent(input.tool_input?.to, input.transcript_path);
  if (!id) return {};
  const p = agentTranscript(input.transcript_path, input.session_id, id);
  const ctx = p && lastContext(p);
  if (!ctx || ctx < LIMIT) return {};
  return firstTime(`send-size\n${input.session_id}\n${id}\n${band(ctx)}`, 7 * 86400e3) ? { deny: DENY(ctx) } : {};
}

if (process.argv[1]?.endsWith('agent-size.mjs')) {
  try {
    const input = readStdinJson();
    const d = input ? sendDecision(input) : {};
    if (d.deny) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.deny } }));
  } catch (e) { logHookError('agent-size', e); /* fail open */ }
}
