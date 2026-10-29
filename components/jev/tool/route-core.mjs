// Tool-neutral prompt routing: classify a user prompt with Jev's "route" preset and build a short
// advisory note. Adapters (Claude Code, Codex, opencode) only translate their hook I/O to this call.
// Never throws: any failure returns { note: null }.
import { openSync, readSync, fstatSync, closeSync, readFileSync, statSync } from 'node:fs';
import zlib from 'node:zlib';
import { join } from 'node:path';
import { runPreset, redact, optedOut, HERE } from './lib.mjs';

export const MIN_PROMPT_CHARS = 30;
export const KIND_MIN = 0.6;   // on the 26-prompt eval every kind hint shown at >= 0.6 was correct
// Per-flag thresholds picked on the same eval (no false positives at these values).
// Real sessions 16-24.10 (60 judged prompts): implement and review misfired at 0.68-0.82, and behavior_claims
// filled half of all shown lines with 11 of 25 partly or wholly off; these need more confidence.
export const KIND_MIN_BY = { review: 0.85 };
export const FLAG_MIN = { risky: 0.7 };
export const PREV_CHARS = 1200;
export const NOTE_HEADER = 'Jev routing note (fast classifier, advisory; it can be wrong, overrule it with evidence):';

const CLI = join(HERE, 'jev.mjs').replace(/\\/g, '/');

// Each hint names a concrete first step that the always-loaded core rules do not already state. Kinds and flags
// the preset still returns but that have no entry here get no note: debug, implement, research, explain,
// needs_current_facts, behavior_claims and heavy_output only repeated CORE.md (reproduce first, done-check before
// editing, read the implementation, verify current facts, delegate bulky output), which every adapter loads.
// Kinds absent here (continue, hold, chat) get no note either.
export const HINTS = {
  refactor: 'refactor: first run or name the test that pins current behavior, and rerun it after each step',
  review: `review: first list concrete failing scenarios with file:line; with 5+ findings triage them via \`node ${CLI} preset finding_severity\``,
  config: 'configuration change: first read and back up the exact target file, then make the smallest edit',
  feedback: 'feedback on your result: first restate what to change and what to keep, then compare against the reference before editing',
};
export const FLAGS = {
  risky: 'destructive or outward-facing action in play: if the user has not already named this exact action, confirm it with them first',
};

// Prompts that are not typed by the user: slash commands, harness messages such as <task-notification>,
// and the summary that opens a compacted session (on 16-18.10 ~75% of route calls, all "continue").
export const stripPasted = (text) => String(text).replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' [pasted text] ').trim();

export function skipPrompt(prompt) {
  if (prompt.length < MIN_PROMPT_CHARS) return 'short';
  if (prompt.startsWith('/')) return 'slash-command';
  if (prompt.startsWith('[Request interrupted')) return 'interrupt';
  if (prompt.startsWith('<') || prompt.startsWith('This session is being continued from a previous conversation')) return 'harness';
  return null;
}

export function formatNote(answers) {
  const a = answers || {};
  const lines = [];
  if (a.kind && a.kind.confidence >= (KIND_MIN_BY[a.kind.choice] ?? KIND_MIN) && HINTS[a.kind.choice]) lines.push(`- ${HINTS[a.kind.choice]} (p=${a.kind.confidence})`);
  for (const [k, text] of Object.entries(FLAGS)) if (a[k]?.p >= FLAG_MIN[k]) lines.push(`- ${text} (p=${a[k].p})`);
  return lines.length ? NOTE_HEADER + '\n' + lines.join('\n') : null;
}

// Returns { note: string|null, skipped?: reason, result?: decide() result }.
export async function routeNote({ prompt, previousReply = '', cwd, deadline = Date.now() + 6500, timeout = 6000, label } = {}) {
  try {
    const p = String(prompt || '').trim();
    if (optedOut(cwd)) return { note: null, skipped: 'opted-out' };
    // Text the user pasted from elsewhere is material, not their request: classify only their own words
    // (on 24-29.10 pasted drafts drew 'feedback' notes and an interrupt marker drew a 'risky' one).
    const own = stripPasted(p);
    const why = skipPrompt(own);
    if (why) return { note: null, skipped: why };
    // Structured state with descriptive field names (docs.typesafe.ai/concepts/state); the previous
    // reply lets Jev tell "Yes, go ahead" from a new task (eval: shown hints 7/11 -> 11/11 correct).
    const prev = previousReply ? redact(previousReply).slice(-PREV_CHARS) : ''; // redact first: a cut can drop a key's prefix
    const state = prev ? { assistant_previous_reply_tail: prev, user_new_message: own } : { user_new_message: own };
    const opts = { timeout, retries: 0, deadline };
    if (label) opts.label = label;
    const r = await runPreset('route', state, opts);
    return { note: r.ok ? formatNote(r.answers) : null, result: r };
  } catch (e) {
    return { note: null, skipped: 'error: ' + String(e?.message || e).slice(0, 200) };
  }
}

// Text of the last assistant message in a Claude/Codex-style JSONL transcript, read from the file's tail only.
// Claude lines: {type:'assistant', message:{content:[{type:'text',text}]}}.
// Codex rollout lines: {type:'response_item', payload:{type:'message', role:'assistant', content:[{type:'output_text',text}]}}.
// Codex stores rollouts as .jsonl.zst: those are decompressed whole (needs Node >= 22.15), capped at 8 MB compressed.
function tailText(path) {
  if (path.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function' || statSync(path).size > 8 << 20) return '';
    return zlib.zstdDecompressSync(readFileSync(path)).toString('utf8').slice(-512 * 1024);
  }
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size, len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

export function lastAssistantText(path) {
  try {
    const lines = tailText(path).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      let j; try { j = JSON.parse(lines[i]); } catch { continue; }
      let content = null;
      if (j.type === 'assistant' && Array.isArray(j.message?.content)) content = j.message.content;
      else if (j.payload?.role === 'assistant' && Array.isArray(j.payload.content)) content = j.payload.content;
      if (!content) continue;
      const text = content.filter(c => c.type === 'text' || c.type === 'output_text').map(c => c.text).join('\n').trim();
      if (text) return redact(text).slice(-PREV_CHARS);
    }
  } catch { /* no transcript */ }
  return '';
}

// Claude Code sets CLAUDE_CODE_ENTRYPOINT to "sdk-cli" for `claude -p` and keeps a value the SDK host passed
// (sdk-ts, sdk-py); interactive runs are "cli", "claude-desktop", "claude-vscode", ...
export function isClaudeHeadless(env = process.env) {
  if (env.JEV_ROUTE_HEADLESS === '1') return false;
  const e = env.CLAUDE_CODE_ENTRYPOINT || '';
  return e.startsWith('sdk-') || e === 'claude-code-github-action';
}
