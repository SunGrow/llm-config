# Installer additions needed by the copilot, cursor, antigravity, kilo, goose, kiro, cline and devin components

None of these is implemented in `installer/install.mjs` yet (checked with `--dry-run --home <tmp>`). Until they are: actions using a new variable fail with "must start with a variable"; `.tmpl` files with `{{include:...}}` are written with the directive left literal (cline installs today in that state, and its rule tells the agent to read `~/.agents/CORE.md` in that case); `unless` is ignored, so the action runs. `devin` and `antigravity` need nothing new and dry-run cleanly today.

## New variables

Each must also be added to the write roots (`WRITE_ROOT_VARS`) and honour `--home` (env overrides ignored when HOME is redirected, as today).

| Variable | Resolution | Used by | Evidence |
|---|---|---|---|
| `{COPILOT_HOME}` | `$COPILOT_HOME` if set, else `{HOME}/.copilot` (all OSes) | copilot | docs.github.com cli-config-dir-reference: COPILOT_HOME replaces the whole `~/.copilot` path |
| `{CURSOR_HOME}` | `{HOME}/.cursor` (all OSes) | cursor (agents, user-rules paste file) | cursor.com/docs/context/subagents; no env override documented for agents |
| `{CURSOR_CLI_HOME}` | `$CURSOR_CONFIG_DIR` if set; else on Linux `$XDG_CONFIG_HOME/cursor` if `XDG_CONFIG_HOME` is set (Assumption: exact XDG subfolder not documented); else `{HOME}/.cursor` | cursor (cli-config.json) | cursor.com/docs/cli/reference/configuration: both variables "can override the global location" |
| `{KILO_HOME}` | `$XDG_CONFIG_HOME/kilo` if set, else `{HOME}/.config/kilo` on all OSes (Assumption: mirrors opencode; no env override or Windows path documented) | kilo | kilo.ai/docs/customize/custom-instructions, /custom-subagents |
| `{GOOSE_HOME}` | linux/darwin: `$XDG_CONFIG_HOME/goose` if set (Assumption), else `{HOME}/.config/goose`; win32: `%APPDATA%/Block/goose/config` | goose | goose-docs.ai/docs/guides/config-files (config.yaml paths); global AGENTS.md assumed to sit next to config.yaml |
| `{KIRO_HOME}` | `$KIRO_HOME` if set and absolute and not HOME or an ancestor of it, else `{HOME}/.kiro` | kiro | kiro.dev/docs/configuration |

`{GOOSE_HOME}` on Windows resolves outside `{HOME}` only if APPDATA is redirected; the root check then needs `{GOOSE_HOME}` itself as a write root.

## Include directive in `*.tmpl`

`{{include:<path>}}` on a line of its own inside a `.tmpl` source: replaced by the contents of `<path>`, resolved relative to the component folder (the same base as `from`), which must stay inside the repository root. Trailing newlines of the included file are trimmed; variables inside the included text are expanded like the rest of the template; no nested includes. Used as `{{include:../core/files/CORE.md}}` by copilot, cursor, kilo, goose, kiro, cline, so the always-on text has one source of truth.

## `unless` on actions

`"unless": "<id>"` or `["a","b"]`: skip the action if any listed component is selected (complement of `when`, which needs all). Recorded in the manifest like `when`, so that selecting a listed component later removes the action's files on the next install. Used by cursor: `~/.cursor/agents/` only when neither `claude` nor `codex` is selected, because Cursor already reads `~/.claude/agents` and `~/.codex/agents`.

## Cross-component sources

`kilo` copies `../opencode/files/agents/` and antigravity, kiro and cline copy `../skills/files/` (gated by `"when": "skills"`). The current `sourcePath` check (inside the repository root) already allows this; no change needed.
