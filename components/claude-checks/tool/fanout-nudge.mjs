#!/usr/bin/env node
// Claude Code PostToolUse hook (all tools): once per turn, when the main thread reaches NUDGE_AT tool calls
// without delegating anything, remind Claude to split off independent parts. Advisory context only.
import { optedOut, readStdinJson, tail, parseLines, isTypedPrompt, logHookError } from './common.mjs';
import { firstTime } from './once.mjs';

export const NUDGE_AT = Number(process.env.CLAUDE_CHECKS_FANOUT_AT) || 40;
const DELEGATE = new Set(['Agent', 'Task', 'Workflow']);

// Tool calls since the last typed prompt, whether any delegated, and that prompt's uuid.
export function turnState(entries) {
  let start = -1;
  entries.forEach((e, i) => { if (isTypedPrompt(e)) start = i; });
  const ids = new Set(); let delegated = false;
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant') continue;
    for (const c of e.message?.content || []) if (c.type === 'tool_use' && !ids.has(c.id)) { ids.add(c.id); if (DELEGATE.has(c.name)) delegated = true; }
  }
  return { calls: ids.size, delegated, promptId: start >= 0 ? entries[start].uuid || String(start) : null };
}

export const NOTE = `This turn has made ${NUDGE_AT} tool calls on the main thread without a subagent. If the remaining work splits into independent parts (separate areas to explore, separate files to change, a long check that can run beside other work), hand those parts to subagents now, each with an explicit model, and keep only the shared, sequential reasoning here.`;

if (process.argv[1]?.endsWith('fanout-nudge.mjs')) {
  try {
    const input = readStdinJson();
    if (input?.transcript_path && !input.agent_id && !optedOut(input.cwd)) {
      const s = turnState(parseLines(tail(input.transcript_path, 4 << 20)));
      if (!s.delegated && s.calls >= NUDGE_AT && firstTime('fanout\n' + input.session_id + '\n' + s.promptId)) {
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: NOTE } }));
      }
    }
  } catch (e) { logHookError('fanout-nudge', e); /* fail open */ }
}
