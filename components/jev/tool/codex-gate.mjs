#!/usr/bin/env node
// Codex CLI PreToolUse adapter (matcher "Bash"). Codex hooks cannot "ask" (an ask fails the hook and the tool
// runs), so confirmation comes from execpolicy rules (~/.codex/rules/jev-guard.rules, decision "prompt").
// This hook covers what those prefix rules cannot express (e.g. `git -C x reset --hard`, `git push origin main -f`,
// compound scripts Codex does not split, PowerShell on Windows): it denies the call and tells the agent to ask
// the user, then rerun with the marker `# jev-confirmed` appended.
// Default: deterministic hard list only, no network. JEV_CODEX_RISK=1 also runs Jev diff_risk on commit/push and
// denies (with the same marker escape) when it flags risk.
// Opt out: env JEV_HOOK=0, or a file .agents/jev-off or .claude/jev-off in the project.
import { readFileSync } from 'node:fs';
import { gateDecision, shellCommandText, coveredByCodexRules, hasConfirmMarker, CONFIRM_MARKER } from './gate-core.mjs';

const T0 = Date.now();
const BUDGET_MS = 10000; // hooks.json gives this hook 12 s

const deny = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: `${reason} Blocked until the user confirms: ask the user in chat; only if they explicitly confirm, rerun the same command with \`${CONFIRM_MARKER}\` appended. If they decline, do not retry.`,
} }));

try {
  if (process.env.JEV_HOOK !== '0') {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const command = shellCommandText(input.tool_input?.command);
    if (command && !hasConfirmMarker(command)) {
      const r = await gateDecision({ command, cwd: input.cwd || process.cwd(), toolUseId: input.tool_use_id, deadline: T0 + BUDGET_MS, hardOnly: process.env.JEV_CODEX_RISK !== '1' });
      if (r.decision === 'ask' && !(r.level === 'hard' && coveredByCodexRules(command, r.found.hard))) deny(r.reason);
    }
  }
} catch { /* fail open */ }
