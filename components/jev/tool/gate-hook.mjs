#!/usr/bin/env node
// Claude Code PreToolUse adapter (Bash/PowerShell): runs gate-core.mjs and, when it says the user should confirm,
// returns permissionDecision "ask". Silent otherwise; any error means no output (fail open).
// Registered with broad `if` rules (git *, rm *, ...) in settings.json, because `if` patterns match only
// the command prefix and miss forms like `git -C dir commit`; the parser in gate-core does the filtering.
// Opt out: env JEV_HOOK=0, or a file .agents/jev-off or .claude/jev-off in the project.
import { readFileSync } from 'node:fs';
import { gateDecision } from './gate-core.mjs';
import { logHookError } from './lib.mjs';

const T0 = Date.now();
const BUDGET_MS = 10000; // settings.json gives this hook 12 s; git calls and Jev share this budget

const ask = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason,
  additionalContext: reason + ' (if the user declined, do not retry the same command)',
} }));

try {
  if (process.env.JEV_HOOK !== '0') {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const r = await gateDecision({ command: input.tool_input?.command, cwd: input.cwd || process.cwd(), toolUseId: input.tool_use_id, deadline: T0 + BUDGET_MS });
    if (r.decision === 'ask') ask(r.reason);
  }
} catch (e) { logHookError('gate-hook', e); /* fail open */ }
