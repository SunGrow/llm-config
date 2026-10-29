# llm-config

One set of rules, skills and subagents for coding agents, installed into every harness you use with one script.
It aims at two things: **fewer wasted tokens** (a short always-loaded core, everything else loaded only when a task needs it)
and **fewer wrong answers** (evidence before claims, explicit "verified up to X; not checked: Y", verification subagents).

Works on Linux, macOS and Windows. Needs Node.js 18+ (20+ recommended).

## Install

One line, no clone needed (downloads the repo to `~/.llm-config/repo`, using git if present, else a tarball):

```sh
curl -fsSL https://raw.githubusercontent.com/SunGrow/llm-config/main/get.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/SunGrow/llm-config/main/get.ps1 | iex
```

Pass options after `sh -s --`, e.g. `curl -fsSL …/get.sh | sh -s -- --yes --components claude,opencode`
(PowerShell: `& ([scriptblock]::Create((irm …/get.ps1))) --yes --components claude,opencode`).
Running the same line again updates the files and re-applies what you installed.

Or from a clone:

```sh
git clone https://github.com/SunGrow/llm-config.git && cd llm-config
./install.sh            # interactive picker (Linux/macOS, also Git Bash)
```

```powershell
.\install.ps1           # Windows PowerShell 5.1 / 7
```

The picker shows what was detected on your machine and pre-selects it. Nothing is written until you confirm.
Non-interactive:

```sh
./install.sh --dry-run --all                      # see every change and diff, write nothing
./install.sh --yes --components claude,codex,jev  # install exactly these (plus what they need)
./install.sh --check                              # exit 3 if installed files drifted from the repo
./install.sh --uninstall                          # remove everything this installer added
```

## Update

```sh
./update.sh             # git pull, then re-apply every installed component (Windows: .\update.ps1)
```

`update.sh` accepts the installer's options (`--dry-run`, `--yes`). `--update` alone re-applies the installed components
from the current checkout without pulling; `LLM_CONFIG_NO_PULL=1` skips the pull.

Re-running is safe: a second run reports "Nothing to change". Existing files are backed up to
`~/.llm-config/backups/<timestamp>/` before any change; your own text in shared files (CLAUDE.md, AGENTS.md, settings.json)
is kept, the installer only manages marked blocks and the JSON keys it added.

## Components

| Component | What you get |
|---|---|
| `core` | `~/.agents/CORE.md` (always-on rules, ~3.6k chars), `ROUTER.md` and just-in-time packs (security, software, research, collaboration, reasoning) |
| `skills` | `verify-claims`, `code-research`, `task-start` / `task-continue` / `handoff`, written once to `~/.agents/skills` (and to `~/.claude/skills` for Claude Code) |
| `claude` | Claude Code: CLAUDE.md block, 5 role subagents with explicit models, commit/PR attribution off |
| `codex` | Codex CLI: AGENTS.md block, 5 custom agents, optional `lean` profile (never touches `config.toml`) |
| `opencode` | opencode: AGENTS.md block, 5 subagents |
| `copilot` | GitHub Copilot CLI / VS Code: `copilot-instructions.md` block, 5 custom agents |
| `cursor` | Cursor: paste-ready user rules (Cursor keeps them in the app), subagents if no Claude/Codex agents exist |
| `antigravity`, `gemini` | Google Antigravity rule file; Gemini CLI `GEMINI.md` block |
| `kilo`, `goose`, `kiro`, `cline`, `devin` | Global rules for Kilo Code, Goose, Kiro, Cline, Devin Desktop (ex-Windsurf, compact version under its 6,000-char cap) |
| `jev` (optional) | Jev decision model hooks: a risk check before git commit/push and destructive commands (Claude Code, Codex, opencode) and an advisory routing note on each prompt (Codex, opencode). Needs an OpenRouter key, ~$0.0001 per call. See `components/jev/SKILL.md.tmpl` |
| `jev-route-claude` (optional) | The routing note in Claude Code too. Notes cover only first steps the core rules do not already state (refactor, review, config change, feedback, risky action). Off by default: it changed no outcomes for Opus or Haiku in `bench/jev-opus` |
| `jev-recall-claude` (optional) | After compaction, Claude Code is told how to recall earlier turns by question (`recall.mjs`, OpenRouter rerank model, local BM25 fallback, ~$0.01 per question). In `bench/recall` it halved turns and time on recall questions |
| `claude-checks` (optional) | Rule-based Claude Code hooks, no model calls: a syntax and control-character check after each edit, a done-check when code changed after the last test or build (fired on 4% of edit turns in a replay of a week of sessions), a cached project map at session start, a one-time push back on foreground sleep/poll waits (re-issue to run anyway), a once-per-turn reminder to delegate when a turn reaches 40 tool calls without a subagent, a one-time refusal of a Read that repeats an unchanged file and range, and a hook health note at session start (missing hook scripts, errors the fail-open hooks logged). Also `session-stats.mjs` and the terminal-only `safe-commit.mjs` |
| `unreal` (optional) | Unreal Engine pack and generic UE C++ rules |

Always-loaded size after install: about 4.5k characters per tool, plus short skill and agent descriptions.

### Jev key

If no key is found (`OPENROUTER_API_KEY`, `~/.config/jev/key`, or on Windows the user environment), the installer asks:
paste it now (hidden input, checked against OpenRouter, saved to `~/.config/jev/key` with mode 600 after you confirm the install),
add it later (Jev is installed but stays inactive), or skip Jev. With `--yes` it installs and prints how to add the key.
The key is never printed, backed up or written to the manifest; uninstall leaves the key file in place. To add it yourself:

```sh
mkdir -p ~/.config/jev && printf %s "$OPENROUTER_API_KEY" > ~/.config/jev/key && chmod 600 ~/.config/jev/key
```

or export `OPENROUTER_API_KEY`. Prompts, the previous reply's tail and git diffs are sent to OpenRouter after secret redaction.
Turn the hooks off with `JEV_HOOK=0` or an empty `.agents/jev-off` file in a project.

## After installing

Open a new session in each tool. Codex asks you to review new hooks in `/hooks`. Cursor user rules have to be pasted
from `~/.cursor/llm-config/user-rules.md` into Settings → Rules.

## Private additions

Put your own components in `local/components/<id>/` (git-ignored, same format). They are installed with the public ones;
a local component can extend a public one with the same id, shadow files it writes, or `replace` it.
The format is in [CONTRACT.md](CONTRACT.md).

## Tests

```sh
node installer/test/run.mjs        # installer engine
node components/jev/test/run.mjs   # Jev redaction, command parsing, adapters (offline; --live for real calls)
```
