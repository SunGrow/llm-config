---
name: task-start
description: Start a new multi-session task. Writes .agent-work/<task-id>/task.md (goal, done-when checks, reply shape, verbatim prohibitions), investigates read-only, proposes a plan, and makes no project edits.
disable-model-invocation: true
argument-hint: "<task-id> <description>"
---

# Start a task (task note only, no project edits)

Arguments: the text the user typed after the skill name. First token = task id (ticket number or short slug); the rest = description.

## Standing rules (whole task)

- This skill writes only the task note. It does not authorize code, asset, config, or git changes; wait for explicit approval of the plan.
- Evidence rules from the core: label guesses `Assumption:`, cite `file:line` / command / source for facts, end conclusions with "Verified up to X; not checked: Y".
- No commit, checkout, stash, or push unless the user asks in this session. Reply in the user's language.

## Steps

1. Run `git branch --show-current`, `git status --short`, and `git log -8 --oneline` (skip if not a git repo).
2. Task id: first argument, else a clear ticket token in the branch name. Unknown: ask once and stop. No description: ask for the goal before writing anything.
3. Read `~/.agents/ROUTER.md` and the packs it selects.
4. Folder: `.agent-work/<task-id>[-short-slug]/` at the repository root (or the current directory outside a repo). If the project instructions name another task-notes location, use that instead.
   - Several matches for `<task-id>*`: list them and ask.
   - The folder already has `task.md` or `handoff-*.md`: not a new task. Say so, suggest `task-continue <task-id>`, and stop.
5. Before writing, check `git check-ignore -q .agent-work`. If it is not ignored, ask whether to add `.agent-work/` to `.git/info/exclude` (local, untracked) or keep the notes tracked. Do not edit `.gitignore` without approval.
6. Write `task.md`:
   - **Task / goal**: one line each
   - **Done when**: at least one observable check (test name, build target, command and expected output, screenshot path). Ask if unclear; never invent one.
   - **Reply shape**: what the chat reply must look like (numbered list, table, short paragraph, link only). Long reports belong in files. Ask once if unclear.
   - **Prohibitions**: the user's exact words, verbatim (ask if none were given)
   - **Known facts**: only with evidence
   - **Assumptions**: each prefixed `Assumption:`
   - **Open questions**
   Without a concrete Done-when check and a Reply shape, do not create `task.md`; ask.
7. Investigate read-only and add only evidenced facts to `task.md`.
8. Propose a 3-7 step plan, each step with its verification check and how it runs (`code-research` for research needing current sources; implementation in the main thread or one briefed subagent per step). Stop and wait for approval.
9. Tell the user: save state with `handoff`, resume with `task-continue <task-id>`.

## Forbidden

- Claiming done beyond the verified layer.
- A long essay in chat when the Reply shape asked for something compact.
