#!/usr/bin/env node
// Claude Code PostToolUse hook (all tools), one process for every per-call check:
// spill.mjs (large results to a file), context-note.mjs (many screenshots), fanout-nudge.mjs (delegate reminder).
// Each part fails open on its own.
import { optedOut, readStdinJson, logHookError } from './common.mjs';
import { spillResult } from './spill.mjs';
import { contextNote } from './context-note.mjs';
import { fanoutNote } from './fanout-nudge.mjs';

if (process.argv[1]?.endsWith('post-tool.mjs')) {
  try {
    const input = readStdinJson();
    if (input && !optedOut(input.cwd)) {
      const out = { hookEventName: 'PostToolUse' }, notes = [];
      let replaced = null;
      try { replaced = spillResult(input); if (replaced) out.updatedToolOutput = replaced; } catch (e) { logHookError('spill', e); }
      // The size note looks at what Claude now sees, so a spilled result does not also draw it.
      try { const c = contextNote(replaced ? { ...input, tool_response: replaced } : input); if (c) notes.push(c); } catch (e) { logHookError('context-note', e); }
      try { const f = fanoutNote(input); if (f) notes.push(f); } catch (e) { logHookError('fanout-nudge', e); }
      if (notes.length) out.additionalContext = notes.join('\n\n');
      if (replaced || notes.length) console.log(JSON.stringify({ hookSpecificOutput: out }));
    }
  } catch (e) { logHookError('post-tool', e); /* fail open */ }
}
