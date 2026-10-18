# Jev port notes: Cline (not implemented)

Sources: search results for https://docs.cline.bot/features/hooks (the hook-reference page only points to the SDK Plugins page; not read in full, 2026-10-18).

- Location: global hooks in `~/Documents/Cline/Hooks/` (an older post says `~/Documents/Cline/Rules/Hooks/`); project hooks in `.clinerules/hooks/`. Global hooks run before workspace hooks.
- Events include `PreToolUse` and `UserPromptSubmit`. Output on stdout: JSON with `cancel` (bool), `contextModification` (string), `errorMessage`.
- Gate: `PreToolUse` with `cancel: true` blocks; no documented "ask".
- Route: `UserPromptSubmit` with `contextModification`; it affects the next API request.
- Not checked: exact file naming, stdin fields, Windows support.
