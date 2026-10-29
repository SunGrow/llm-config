#!/usr/bin/env node
// Claude Code SessionStart hook (matcher "compact"): after compaction, tell Claude how to recall earlier turns of
// this session by question. Local only: no network call. Plain stdout becomes session context.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, optedOut } from './lib.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const path = input.transcript_path;
  if (path && !optedOut(input.cwd)) {
    const cli = join(HERE, 'recall.mjs').replace(/\\/g, '/');
    console.log(`Earlier turns of this session were compacted. To recall a detail from them (a decision, number, reason, what the user asked), run: node "${cli}" "<question in any language>" --file "${String(path).replace(/\\/g, '/')}"  It prints the best-matching turns with line numbers; read the transcript around those lines for more. Add --project to search this project's other sessions too.`);
  }
} catch { /* never block the session */ }
