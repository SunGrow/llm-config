#!/usr/bin/env node
// Codex CLI UserPromptSubmit adapter (registered in ~/.codex/hooks.json). Codex adds plain stdout of this hook
// as developer context. Never blocks; any error means no output.
// Opt out: env JEV_HOOK=0, or a file .agents/jev-off or .claude/jev-off in the project.
import { readFileSync } from 'node:fs';
import { routeNote, lastAssistantText } from './route-core.mjs';

const T0 = Date.now();
const BUDGET_MS = 6500; // hooks.json gives this hook 8 s

try {
  if (process.env.JEV_HOOK !== '0') {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (!input.agent_id) {
      const prev = input.transcript_path ? lastAssistantText(input.transcript_path) : '';
      const { note } = await routeNote({ prompt: input.prompt, previousReply: prev, cwd: input.cwd, deadline: T0 + BUDGET_MS });
      if (note) process.stdout.write(note + '\n');
    }
  }
} catch { /* fail open */ }
