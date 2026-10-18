# Jev port notes: Kiro (not implemented)

Sources: https://kiro.dev/docs/hooks/ and https://kiro.dev/docs/configuration/ (checked 2026-10-18; trigger list page not read).

- Location: global hooks in `~/.kiro/hooks/` (Kiro CLI V3; `KIRO_HOME` moves it); agent files also take a `hooks` field (CLI only).
- Triggers named on the page: `PreToolUse`, `PostToolUse`, `PostFileSave`, `Stop`; PreToolUse can "block tool execution". Command actions get session context as JSON on stdin.
- Not checked: the blocking mechanism (exit code or JSON field), whether an ask decision exists, and whether a prompt-submit trigger can add context. Read https://kiro.dev/docs/hooks/ trigger reference before porting.
