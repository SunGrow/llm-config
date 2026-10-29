#!/usr/bin/env node
// Claude Code PreToolUse hook (Read): refuse once a Read of the same file and range that this session (or this
// subagent) already read, when the file's size and modification time have not changed since. Re-issuing the same
// Read goes through. --reset (SessionStart, matcher compact): forget the main thread's reads, since compaction
// drops the content from context.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readStdinJson, optedOut, logHookError } from './common.mjs';
import { firstTime } from './once.mjs';

const DIR = process.env.CLAUDE_CHECKS_READS || join(homedir(), '.agents', 'cache', 'claude-checks-reads');
const KEEP_MS = 2 * 86400e3;
const h = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

// One folder per session and thread, one file per read key holding "<size> <mtimeMs>".
const threadDir = (sessionId, agentId) => join(DIR, h(sessionId) + (agentId ? '-' + h(agentId) : ''));

export function readKey(ti) {
  let p = resolve(String(ti.file_path || ''));
  if (process.platform === 'win32') p = p.toLowerCase();
  return [p, ti.offset ?? '', ti.limit ?? '', ti.pages ?? ''].join('|');
}

// 'repeat' when this exact read was done before and the file is unchanged, else 'new'. Records the read.
export function checkRead(sessionId, agentId, ti) {
  let st; try { st = statSync(ti.file_path); } catch { return 'new'; }
  if (!st.isFile()) return 'new';
  const stamp = `${st.size} ${st.mtimeMs}`;
  const dir = threadDir(sessionId, agentId), f = join(dir, h(readKey(ti)));
  let prev = null; try { prev = readFileSync(f, 'utf8'); } catch { /* first read */ }
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, stamp);
  return prev === stamp ? 'repeat' : 'new';
}

export function resetThread(sessionId, agentId) { rmSync(threadDir(sessionId, agentId), { recursive: true, force: true }); }

function prune() {
  try { for (const d of readdirSync(DIR)) { const p = join(DIR, d); if (Date.now() - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { recursive: true, force: true }); } } catch { /* no state yet */ }
}

if (process.argv[1]?.endsWith('read-guard.mjs')) {
  try {
    const input = readStdinJson();
    if (input?.session_id && !optedOut(input.cwd)) {
      if (process.argv.includes('--reset')) { resetThread(input.session_id, null); prune(); }
      else if (input.tool_name === 'Read' && input.tool_input?.file_path) {
        const ti = input.tool_input;
        if (checkRead(input.session_id, input.agent_id, ti) === 'repeat' && firstTime(['reread', input.session_id, input.agent_id || '', readKey(ti)].join('\n'))) {
          console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Already read: ${ti.file_path} (same range) earlier in this ${input.agent_id ? 'subagent' : 'session'}, and it has not changed since. Use the content you already have, or Grep or read a specific range for the part you need. If that content is no longer in your context, re-issue the same Read.` } }));
        }
      }
    }
  } catch (e) { logHookError('read-guard', e); /* fail open */ }
}
