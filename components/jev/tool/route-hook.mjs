#!/usr/bin/env node
// Claude Code UserPromptSubmit adapter: classify the prompt (route-core.mjs) and add a short advisory note to
// Claude's context. Never blocks and never fails the prompt: any error means no output.
// Skips subagent prompts and headless/SDK runs (CLAUDE_CODE_ENTRYPOINT sdk-cli, sdk-ts, sdk-py or the GitHub
// action); set JEV_ROUTE_HEADLESS=1 to route those too.
// Opt out: env JEV_HOOK=0, or a file .agents/jev-off or .claude/jev-off in the project.
import { readFileSync } from 'node:fs';
import { routeNote, lastAssistantText, isClaudeHeadless } from './route-core.mjs';
import { logHookError } from './lib.mjs';

const T0 = Date.now();
const BUDGET_MS = 6500; // settings.json gives this hook 8 s

try {
  if (process.env.JEV_HOOK !== '0' && !isClaudeHeadless()) {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (!input.agent_id) {
      // Claude's transcript format only; Grok (hookEventName set) keeps its own.
      const prev = input.transcript_path && !input.hookEventName ? lastAssistantText(input.transcript_path) : '';
      const { note } = await routeNote({ prompt: input.prompt, previousReply: prev, cwd: input.cwd, deadline: T0 + BUDGET_MS });
      if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } }));
    }
  }
} catch (e) { logHookError('route-hook', e); /* fail open */ }
