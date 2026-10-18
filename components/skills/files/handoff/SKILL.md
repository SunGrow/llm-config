---
name: handoff
description: Save task state for a fresh session as a new dated .agent-work/<task-id>/handoff-YYYY-MM-DD[-N].md (never overwrites) with done work, decisions, verbatim prohibitions, verified facts vs Assumption:, and the next step.
disable-model-invocation: true
argument-hint: "[task-id]"
---

# Handoff

Arguments: the text the user typed after the skill name (optional task id).

## Rules

- Write only the handoff file. No commit, no edits to code, assets, or other notes.
- Never overwrite an earlier handoff; they are the task's history.
- Record work as done only if its verification was shown in this session, with depth ("Verified up to X; not checked: Y").
- Aim for 80 lines or fewer. Link detail files instead of copying them. Write in the user's language.

## Steps

1. Run `git branch --show-current`, `git status --short`, and `git log -8 --oneline` (skip if not a git repo).
2. Task id: the argument, else a clear ticket token in the branch name, else the only folder under `.agent-work/`. Unknown: ask once and stop.
3. Folder: `.agent-work/<task-id>*` (or the location the project instructions name). One match: use it. Several: ask. None: create `.agent-work/<task-id>-<short-slug>/` after the same `git check-ignore -q .agent-work` check as `task-start` (ask before adding tracked files).
4. File: `handoff-<today YYYY-MM-DD>.md`; if it exists use `-2`, `-3`, and so on.
5. Sections, in order:
   1. **Task / branch / goal**: one line each; link `task.md` if present
   2. **Done**: commits (hash and subject), files and assets touched
   3. **Decisions and why**
   4. **Prohibitions**: the user's exact words, verbatim
   5. **Rejected approaches**
   6. **Verified facts** (each with `file:line` / command / source) and, separately, **Assumptions** (each `Assumption:`)
   7. **Current state**: what works, what is broken; last verification and its depth
   8. **Open questions**
   9. **Next step**: one concrete action, its check, and how to run it
6. End the file and the chat reply with the line to paste in the next session:

   `task-continue <task-id>` (in Claude Code: `/task-continue <task-id>`), or in words: "Continue <task-id>: read the latest handoff in .agent-work/<task-id>*/, check it against the code, and propose the next step."
