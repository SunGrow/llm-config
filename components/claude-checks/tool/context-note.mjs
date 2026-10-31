// Screenshot note for PostToolUse (main thread only), run by post-tool.mjs: every IMAGE_EVERY-th image result
// in a session points Claude at heavy-output-runner for the rest of the sequence. Large text results are
// handled by spill.mjs instead.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const IMAGE_EVERY = Number(process.env.CLAUDE_CHECKS_IMAGE_EVERY) || 3;
const TOOLS = /^(mcp__.*|Bash|PowerShell|Read)$/;
const DIR = process.env.CLAUDE_CHECKS_COUNTERS || join(homedir(), '.agents', 'cache', 'claude-checks-images');

export const isImage = (tool, text) => /"type"\s*:\s*"image"/.test(text) || /screenshot|__computer$/i.test(tool);

function bumpImages(sessionId) {
  mkdirSync(DIR, { recursive: true });
  const p = join(DIR, sessionId.replace(/[^A-Za-z0-9-]/g, '') + '.img');
  let n = 1; try { n += parseInt(readFileSync(p, 'utf8'), 10) || 0; } catch { /* first image */ }
  writeFileSync(p, String(n));
  return n;
}

// The note for this tool result, or null.
export function contextNote(input) {
  const tool = String(input?.tool_name || '');
  if (!TOOLS.test(tool) || input.agent_id || !input.session_id || input.harness === 'grok') return null;
  const r = input.tool_response;
  const text = typeof r === 'string' ? r : JSON.stringify(r ?? '');
  if (isImage(tool, text)) {
    const n = bumpImages(String(input.session_id));
    return n % IMAGE_EVERY === 0 ? `Context note: ${n} image/screenshot results have entered the main conversation in this session (latest from ${tool}). Each stays in context until compaction. The heavy-output-runner subagent can run the remaining screenshot sequence and return only the observed details.` : null;
  }
  return null;
}
