# Jev port notes: Cursor (not implemented)

Source: https://cursor.com/docs/agent/hooks (checked 2026-10-18).

- Location: `~/.cursor/hooks.json` (user, all projects). Schema: `{"version": 1, "hooks": {"<event>": [{"command": "...", "timeout": ..., "matcher": ..., "failClosed": ...}]}}`. A json-merge fragment can register entries without touching other keys.
- Common stdin fields: `conversation_id`, `generation_id`, `model`, `hook_event_name`, `cursor_version`, `workspace_roots`, `transcript_path`, and others.
- Gate: `beforeShellExecution` (adds `command`, `cwd`, `sandbox`) returns `permission` = `allow` | `deny` | `ask`; this is the right event for commit/push/destructive commands. `preToolUse` accepts only allow/deny in practice (`ask` is not enforced). Exit code 2 blocks.
- Route: `beforeSubmitPrompt` cannot add context (only `continue`, `user_message`). `additional_context` is accepted on `sessionStart`, `postToolUse`, `postToolUseFailure`, so a per-prompt route note is not possible; a session-start note is.
- Needed: Node entry translating `beforeShellExecution` input to the Jev gate and printing `{"permission": ...}`.
