# Jev port notes: Google Antigravity (not implemented)

Source: https://antigravity.google/docs/hooks (checked 2026-10-18).

- Location: global `~/.gemini/config/hooks.json` (App, IDE, CLI); the CLI also reads hooks in `~/.gemini/antigravity-cli/settings.json`.
- Schema: hook name -> event -> array of `{matcher, hooks: [{type: "command", command, timeout}]}`, optional `enabled`.
- Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. Common input: `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`.
- Gate: `PreToolUse` with matcher on `run_command`; input `toolCall {name, args}`; output `decision` = `allow` | `auto_approve` | `deny` | `ask` | `force_ask` | `deny_unless_prior_grant`, plus `reason`. Assumption: IDE enforcement of deny is reported unreliable on the Google AI developer forum; test before relying on it.
- Route: no prompt-submit event. `PreInvocation` can return `injectSteps` (for example an `ephemeralMessage`), which is the closest per-turn context hook.
- Needed: Node entry for `PreToolUse` and `PreInvocation`, plus a json-merge fragment for `~/.gemini/config/hooks.json`.
