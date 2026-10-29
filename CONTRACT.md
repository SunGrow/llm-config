# Component contract (for contributors and the installer)

The installer (`installer/install.mjs`, run by `install.sh` / `install.ps1`) knows nothing about specific
tools. Everything it installs is described by `components/<id>/component.json`, plus the same
structure under `local/components/<id>/` (git-ignored private overlay, installed only when present).

## component.json

```json
{
  "id": "claude",
  "title": "Claude Code adapter",
  "description": "One line shown in the picker.",
  "group": "tools",                     // "base" | "tools" | "extras"
  "requires": ["core"],                 // auto-selected with this one
  "default": "detect",                  // true | false | "detect" (selected if detect matches)
  "detect": { "commands": ["claude"], "paths": ["{CLAUDE_HOME}"] },
  "platforms": ["linux", "darwin", "win32"],
  "requiresBinaries": ["node"],          // checked; missing -> warning and skip
  "postInstall": "Short text printed after install (e.g. 'set OPENROUTER_API_KEY').",
  "actions": [ ... ]
}
```

## Actions

Every action may have `"when": "<component id>"` or `"when": ["a","b"]` (run only if all those
components are selected) and `"platforms": [...]`. Paths in `to` and file contents of every
`*.tmpl` source are expanded with the variables below. Sources are relative to the component folder.

| type | fields | install | uninstall |
|---|---|---|---|
| `copy` | `from` (file or dir/), `to` | copy; files ending in `.tmpl` are expanded and the suffix dropped; existing different file is backed up first | delete the files it wrote (only if unchanged since install, else keep and warn) |
| `block` | `from`, `to`, optional `id` | insert or replace a managed block between `<!-- llm-config:begin <id> -->` and `<!-- llm-config:end <id> -->` (`#` comment markers for .toml/.rules/.sh); rest of the file untouched; creates the file if missing | remove the block |
| `json-merge` | `from`, `to` | deep-merge objects; arrays: append items not already present (deep-equal); scalars: set only if the key is absent unless `"override": true` | remove exactly the keys/array items it added (recorded in the manifest) |
| `npm-install` | `dir` | `npm install --omit=dev --no-audit --no-fund` in that installed dir | — |
| `chmod` | `to`, `mode` | POSIX only | — |

More action fields:
- `"unless": "<id>"` or `[...]`: skip the action if any listed component is selected or installed (complement of `when`).
- `json-merge` with `"onlyIfExists": true`: skip when the target file does not exist (files with fields the tool writes itself).
- `.tmpl` sources may contain `{{include:<path>}}` on its own line: replaced by that repo file (relative to the component
  folder, must stay inside the repo, no nesting, trailing whitespace trimmed), then variables are expanded.

More component fields:
- `"replaces": ["<id>"]`: when this component is selected, the listed one is not installed (e.g. a private overlay of a public pack).
- `"omits": ["{CLAUDE_HOME}/skills/x/", "{AGENTS_HOME}/file.md"]`: when this component is selected, no other component copies to these targets (a folder when it ends in `/`, else one file), and copies installed there earlier are removed. Use it to drop part of a public pack, e.g. generic skills your own ones stand in for.
- `"apiKey": { "name", "env", "configFile", "prefix"?, "url"?, "checkUrl"? }`: the component needs a key, found in env `env`,
  in `$XDG_CONFIG_HOME/<configFile>` (else `~/.config/<configFile>`), or on Windows in the user environment (registry).
  If none is found, an interactive install offers: paste it now (hidden; checked with a GET to `checkUrl`, 401/403 = rejected;
  saved with mode 600 after the install is confirmed), add it later, or skip the component and everything that requires it.
  `--yes` installs and warns; `--dry-run` only warns.

Shadowing: if several selected components copy to the same file, the last one in plan order (dependencies first, then
group and id; local overlays extend the component they name) owns it and the others skip that file.

## Variables

`{HOME}` user home · `{AGENTS_HOME}` = `~/.agents` · `{CLAUDE_HOME}` = `$CLAUDE_CONFIG_DIR` or `~/.claude` ·
`{CODEX_HOME}` = `$CODEX_HOME` or `~/.codex` · `{OPENCODE_HOME}` = `$OPENCODE_CONFIG_DIR` or
`$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` · `{GEMINI_HOME}` = `~/.gemini` ·
`{JEV_HOME}` = `{AGENTS_HOME}/tools/jev` · `{COPILOT_HOME}` = `$COPILOT_HOME` or `~/.copilot` ·
`{CURSOR_HOME}` = `~/.cursor` · `{CURSOR_CLI_HOME}` = `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor` on Linux, else `~/.cursor` ·
`{KILO_HOME}` = `$XDG_CONFIG_HOME/kilo` or `~/.config/kilo` · `{GOOSE_HOME}` = `%APPDATA%/Block/goose/config` on Windows,
else `$XDG_CONFIG_HOME/goose` or `~/.config/goose` · `{KIRO_HOME}` = `$KIRO_HOME` (absolute, not home or above) or `~/.kiro` ·
`{NODE}` absolute path of node · `{OS}` linux|darwin|win32. With `--home`, environment overrides are ignored.
All paths are written with forward slashes (valid on Windows too).

## Installer guarantees

- `--dry-run` prints every planned change and a unified diff for modified text files, writes nothing.
  `--check` exits 3 on drift; `--json` prints the plan as JSON. Files are written atomically (temp file + rename, retried on Windows EPERM).
  Size budgets warn when an always-loaded file grows past a tool's limit (Codex AGENTS.md 16 KiB of its 32 KiB cap, Devin 6,000 chars).
- Before overwriting or modifying any existing file it copies it to `~/.llm-config/backups/<timestamp>/<path relative to home>`.
- Records everything in `~/.llm-config/manifest.json` (plus `source`, the checkout it ran from); `--uninstall [ids]` reverses it.
  `--update` re-applies every installed component from the current checkout; `--check` with no selection checks the installed set.
- Writes a secret only when the user pastes it at an `apiKey` prompt, and only to that key file; never prints, logs,
  backs up or records it. Never edits a file outside the variables above.
- `--home <dir>` redirects HOME (and all variables) for tests.

## Shared layout after install

- `~/.agents/` — tool-agnostic source of truth: `CORE.md`, `ROUTER.md`, `instructions/*.md`, `skills/<name>/SKILL.md`, `tools/jev/`.
- Each tool gets a thin adapter that points at `~/.agents`: `~/.claude/CLAUDE.md` block, `~/.codex/AGENTS.md` block,
  `~/.config/opencode/AGENTS.md` block, `~/.gemini/GEMINI.md` block, plus native subagent files and hook/plugin registration.
- Skills live in `~/.agents/skills` (read natively by Codex, opencode, Gemini, Cursor) and are also copied to
  `~/.claude/skills` when Claude is selected (Claude Code does not read `~/.agents/skills`).
