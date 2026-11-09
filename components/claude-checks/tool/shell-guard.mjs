#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash|PowerShell): a foreground command that waits by polling (sleep inside a loop,
// or one long sleep) blocks the session. Push back once; re-issuing the same command goes through, since some
// waits are on processes Claude did not start (an editor, a game build) and have no completion notice.
import { readStdinJson, optedOut, logHookError, tail, parseLines } from './common.mjs';
import { firstTime } from './once.mjs';

// Monitor runs its command in the background by design, but the hook sees it as a plain Bash call (tool_name Bash,
// no run_in_background). The transcript's tool_use with the same id names the tool that started it. The hook can run
// before that entry is written, so a miss is retried for up to a second; only commands about to be refused pay it.
export function startedBy(input, tries = 10) {
  if (!input?.transcript_path || !input.tool_use_id) return null;
  for (let i = 0; i < tries; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    try {
      for (const e of parseLines(tail(input.transcript_path, 1 << 20)).reverse())
        for (const c of Array.isArray(e.message?.content) ? e.message.content : []) if (c.type === 'tool_use' && c.id === input.tool_use_id) return c.name;
    } catch { return null; /* no transcript */ }
  }
  return null;
}

// Heredoc bodies are data (a test script may loop and sleep on its own), so they are cut before matching.
export const stripHeredocs = (s) => String(s).replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(\n|$)/g, '\n');
// A wait loop: while/until, a counted for (seq, 1..N, C-style), or PowerShell do { } while/until, with a sleep inside.
// A for over a fixed list (send these keys, one short pause each) is not a wait. A single sleep counts from 30 s.
export const POLL_LOOP = new RegExp([
  String.raw`\b(while|until)\b[\s\S]{0,600}?\b(sleep|Start-Sleep)\b`,
  String.raw`\bfor\b[^\n]{0,120}?(\bseq\b|\.\.|\(\()[\s\S]{0,600}?\b(sleep|Start-Sleep)\b`,
  String.raw`\bdo\s*\{[\s\S]{0,600}?\bStart-Sleep\b[\s\S]{0,600}?\}\s*(while|until)\b`,
  String.raw`(^|[;&|\n]\s*)(sleep|Start-Sleep)\s+(-s(econds)?\s+)?([3-9]\d|\d{3,}|[1-9]\d*m)\b`,
].join('|'), 'i');

export function isPollWait(command) { return POLL_LOOP.test(stripHeredocs(command)); }

if (process.argv[1]?.endsWith('shell-guard.mjs')) {
  try {
    const input = readStdinJson();
    const ti = input?.tool_input || {};
    if (['Bash', 'PowerShell'].includes(input?.tool_name) && !ti.run_in_background && !optedOut(input.cwd) && isPollWait(ti.command) && startedBy(input) !== 'Monitor' && firstTime('poll\n' + ti.command)) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This command waits in the foreground (a sleep loop or a long sleep) and blocks the session. If it waits for a job you start, start that job with run_in_background and continue other work; you are notified when it exits. If it must wait for a process you did not start, re-issue the same command unchanged.' } }));
    }
  } catch (e) { logHookError('shell-guard', e); /* fail open */ }
}
