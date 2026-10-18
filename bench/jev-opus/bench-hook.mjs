#!/usr/bin/env node
// UserPromptSubmit hook for the benchmark: emits the pre-computed note from BENCH_NOTE_FILE (empty file = no note),
// in the same shape as the real Jev route hook.
import { readFileSync, writeFileSync } from 'node:fs';
try {
  readFileSync(0, 'utf8');
  const note = process.env.BENCH_NOTE_FILE ? readFileSync(process.env.BENCH_NOTE_FILE, 'utf8').trim() : '';
  if (note) { writeFileSync(process.env.BENCH_NOTE_FILE + '.delivered', ''); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } })); }
} catch { /* fail open */ }
