# Jev port notes: GitHub Copilot (not implemented)

Source: https://docs.github.com/en/copilot/reference/hooks-configuration (checked 2026-10-18).

- Location: `*.json` in `~/.copilot/hooks/` (`$COPILOT_HOME/hooks/` when set), or a `hooks` key in `~/.copilot/settings.json`.
- Schema: `{"version": 1, "hooks": {"<event>": [{"type": "command", "bash": "...", "powershell": "...", "timeoutSec": 30}]}}`; `command` is a cross-platform fallback.
- Gate (diff_risk before commit/push/destructive commands): `preToolUse`. Input (camelCase form): `toolName`, `toolArgs`, `cwd`, `sessionId`. Output: `permissionDecision` = `allow` | `deny` | `ask`, plus `permissionDecisionReason`. `ask` is treated as deny in cloud agent and CLI autopilot. A PascalCase event name (`PreToolUse`) selects the VS Code-compatible payload (`tool_name`, `tool_input`).
- Route (advisory note per prompt): not possible with config-file hooks. `userPromptSubmitted` output `modifiedPrompt` is honoured only by SDK hooks. Context can be added via `additionalContext` on `sessionStart`, `subagentStart`, `notification`, `postToolUse`, so a port could emit a one-time session note, not a per-prompt route.
- Needed: a Node entry that maps `toolArgs` to the Jev gate input and prints the decision JSON; one file in `~/.copilot/hooks/`.
