# Opus + Jev benchmark

A/B test of Claude Code (`claude -p`) with and without the Jev routing note. Each run starts in a fresh git repo with a
tiny fixture. The note reaches the model the same way the real hook delivers it (UserPromptSubmit `additionalContext`,
`bench-hook.mjs`), and a check script grades the result.

- `off`: no note (`JEV_HOOK=0`).
- `jev`: the note the live `route` preset gives for the prompt, computed once and cached in `notes.json`.
- `oracle`: the note a perfect classifier would give. It only runs where it differs from `jev`.

```bash
node selftest.mjs                      # every check fails on the untouched fixture and passes on a reference fix
node run.mjs --reps 3 --par 4          # writes results.jsonl, the per-run repos stay in %TEMP%/wb
node report.mjs results.jsonl
```

## Results (2026-10-18, Claude Code 2.1.293, jev-1.14, user's global CLAUDE.md loaded)

| Run | Model | Tasks | Runs | Pass off | Pass jev | Mean cost/run off → jev | Mean sec off → jev |
|---|---|---|---|---|---|---|---|
| Round 1 | claude-opus-5-5 | 8 | 54 | 24/24 | 24/24 (oracle 6/6) | $0.153 → $0.158 | 26 → 24 |
| Round 2 (harder: post-cutoff npm version, root cause in a shared helper, misleading comment + README) | claude-opus-5-5 | 3 | 24 | 12/12 | 12/12 | $0.157 → $0.156 | 28 → 28 |
| Contrast | claude-haiku-5-5 | 11 | 44 | 22/22 | 22/22 | $0.005 → $0.006 | 21 → 25 |

Jev's classification matched the oracle on 9 of 11 prompts. It missed the `research` kind on the Node LTS prompt
(though it set the current-facts flag) and called the call-site count `review` without the heavy-output flag. Oracle
notes on those two tasks changed nothing.

Process differences with the note (small n, treat as hints):

- Opus, implement: ran the existing test before editing in 3/3 runs (off: 1/3).
- Opus, debug and config: verified after the last edit in 3/3 runs (off: 2/3 each).
- Opus, risky cleanup: with the note it changed nothing and asked in 3/3 runs. Off, it deleted the obvious junk (`dist/`, `tmp/`) in 2/3 runs and asked about the
  draft and the force-push. No run in any condition lost the untracked draft or the teammate's commit.
- Haiku: +1.2 turns and +4 s per run with the note, no outcome change.
- Nobody delegated the 120-file search to a subagent, even with the oracle `heavy_output` note. A grep was enough.

## What this does and does not show

- On single-turn, well-specified tasks, Opus 5.5 with this CLAUDE.md is at ceiling. The routing note neither helps nor hurts outcomes, and costs about 3% more tokens plus about 1 s for the Jev call.
- Not tested:
  - Long sessions, where always-on rules may fade.
  - Runs without the global CLAUDE.md: `--bare` needs an API key, and changing the user config was out of scope.
  - Non-Claude models (opencode with Kimi).
  - The gate: the commit and destructive-command check has its own tests.
