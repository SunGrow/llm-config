// Large tool results go to a file instead of the context. Used by post-tool.mjs (PostToolUse) through
// hookSpecificOutput.updatedToolOutput, which must keep the tool's result shape: only text fields shrink.
// Tool results: over SPILL_AT characters, the full text is saved and Claude sees the path, the size, the head
// and the tail. Read: over READ_AT characters (READ_AT_SUB in a subagent), Claude sees a contiguous first part
// and the line to continue from; the file itself is the full copy, so nothing is saved.
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const SPILL_AT = Number(process.env.CLAUDE_CHECKS_SPILL_AT) || 4000;
export const READ_AT = Number(process.env.CLAUDE_CHECKS_READ_SPILL_AT) || 40000;
// Subagents read to answer a bounded question, so their Reads get a lower cap than the main thread's.
export const READ_AT_SUB = Number(process.env.CLAUDE_CHECKS_READ_SPILL_AT_SUBAGENT) || 15000;
const HEAD = 2000, TAIL = 1000, LIST_KEEP = 50;
export const SPILL_DIR = process.env.CLAUDE_CHECKS_SPILL_DIR || join(homedir(), '.agents', 'cache', 'tool-output');
const KEEP_MS = 3 * 86400e3;

// Results Claude needs whole: subagent reports, tool schemas, skill bodies, instruction pages of MCP servers.
const EXEMPT = new RegExp(process.env.CLAUDE_CHECKS_SPILL_EXEMPT || String.raw`^(Agent|Task\w*|ToolSearch|Skill|AskUserQuestion|ExitPlanMode|TodoWrite)$|^mcp__.*__(read_me|readme|guide|instructions|help)$|^mcp__ccd_`);
const SPILL_TOOLS = /^(Bash|PowerShell|Grep|Glob|WebFetch|WebSearch|mcp__.+)$/;

const fwd = (p) => p.replace(/\\/g, '/');

// Text leaves of a result, skipping images and base64 payloads.
function texts(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => texts(x, out));
  else if (v && typeof v === 'object' && v.type !== 'image') for (const [k, x] of Object.entries(v)) if (k !== 'base64' && k !== 'source') texts(x, out);
  return out;
}

// Head and tail cut at line breaks when one is near, so no line is shown half.
function preview(s, path, total) {
  if (s.length <= HEAD + TAIL + 200) return s;
  const h = s.lastIndexOf('\n', HEAD), t = s.indexOf('\n', s.length - TAIL);
  const head = s.slice(0, h > HEAD / 2 ? h : HEAD), tail = s.slice(t >= 0 && t < s.length - TAIL / 2 ? t + 1 : s.length - TAIL);
  return `${head}\n\n[... ${s.length - head.length - tail.length} characters not shown. Full output (${total} characters): ${path} . Search it with Grep, read a range with Read offset/limit, or process it with a script; do not read it whole ...]\n\n${tail}`;
}

// Shrink every long string and long string list in place of the original, same shape.
function shrink(v, path, total) {
  if (typeof v === 'string') return v.length > HEAD + TAIL + 200 ? preview(v, path, total) : v;
  if (Array.isArray(v)) {
    if (v.length > LIST_KEEP && v.every((x) => typeof x === 'string')) return [...v.slice(0, LIST_KEEP), `[... ${v.length - LIST_KEEP} more entries; full list: ${path} ]`];
    return v.map((x) => shrink(x, path, total));
  }
  if (v && typeof v === 'object') {
    if (v.type === 'image') return v;
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = k === 'base64' || k === 'source' ? x : shrink(x, path, total);
    return o;
  }
  return v;
}

function prune() {
  try { for (const d of readdirSync(SPILL_DIR)) { const p = join(SPILL_DIR, d); if (Date.now() - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { recursive: true, force: true }); } } catch { /* nothing yet */ }
}

// Model-facing text of a Grok result (tagged objects; a string when Grok already cut it), or null to leave it.
function grokText(r) {
  if (typeof r === 'string') return r;
  if (/"(image|base64|pdf)/i.test(JSON.stringify(r).slice(0, 4000))) return null;  // a replacement drops images
  switch (r?.type) {
    case 'Bash': return r.output_for_prompt ?? null;
    case 'ReadFile': return r.FileContent?.content ?? null;
    case 'GrepSearch': return Array.isArray(r.stdout) ? Buffer.from(r.stdout).toString('utf8') : r.stdout ?? null;
    case 'ListDir': return r.Content?.content ?? null;
    default: return r && typeof r === 'object' && !r.type ? texts(r).join('\n') : null;  // MCP content
  }
}

function saveFull(input, text) {
  const dir = join(SPILL_DIR, createHash('sha256').update(String(input.session_id || 'nosession')).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(input.tool_use_id || Date.now()).replace(/[^\w-]/g, '')}.txt`);
  writeFileSync(file, text);
  prune();
  return fwd(file);
}

function readCut(input, c) {
  const ranged = input.tool_input?.offset != null || input.tool_input?.limit != null;
  const cap = input.agent_id && !ranged ? READ_AT_SUB : READ_AT;
  if (typeof c !== 'string' || c.length <= cap) return null;
  const cut = c.lastIndexOf('\n', cap);
  return { cap, kept: c.slice(0, cut > 0 ? cut : cap) };
}

// Grok takes a string as the replacement for any tool and shows it as written.
function spillGrok(input, tool, r) {
  const text = grokText(r);
  if (typeof text !== 'string') return null;
  if (tool === 'Read') {
    const k = readCut(input, text);
    return k && `${k.kept}\n[Read output cut at ${k.cap} characters. Continue with a ranged read of ${input.tool_input?.file_path || 'the file'}, or grep it for the part you need.]`;
  }
  if (!SPILL_TOOLS.test(tool) || text.length <= SPILL_AT) return null;
  return preview(text, saveFull(input, text), text.length);
}

// Returns the replacement result, or null to leave the result as it is.
export function spillResult(input) {
  const tool = String(input?.tool_name || ''), r = input?.tool_response;
  if (r == null || EXEMPT.test(tool)) return null;
  if (input.harness === 'grok') return spillGrok(input, tool, r);

  if (tool === 'Read') {
    // A subagent that asked for a range gets the main-thread cap: it already chose how much to read.
    const k = readCut(input, r?.file?.content);
    if (!k) return null;
    const { cap, kept } = k;
    const start = Number(r.file.startLine) || 1, shown = kept.split('\n').length, next = start + shown;
    const totalLines = r.file.totalLines ?? r.file.numLines ?? '?';
    const note = `\n[Read output cut at ${cap} characters: lines ${start}-${next - 1} of ${totalLines} shown. Continue with Read offset=${next} and a limit, or Grep the file for the part you need.]`;
    return { ...r, file: { ...r.file, content: kept + note } };
  }

  if (!SPILL_TOOLS.test(tool)) return null;
  const all = texts(r), total = all.reduce((n, s) => n + s.length, 0);
  if (total <= SPILL_AT) return null;
  return shrink(r, saveFull(input, all.join('\n')), total);
}
