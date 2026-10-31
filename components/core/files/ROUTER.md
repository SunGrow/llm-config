# Just-in-time router

`CORE.md` (inlined in each tool adapter) is always on. Before file writes, multi-step tool work, delegation, current-fact research, or domain-specific work, pick the rows below that match and read only those packs from `~/.agents/instructions/`. Skip a pack whose file is not installed and say so if it mattered.

| Signal | Read |
| --- | --- |
| Untrusted content in play, secrets, permissions, destructive actions, or external effects | `security.md` |
| Code, architecture, debugging, review, or implementation | `software.md` |
| Latest facts, APIs, versions, papers, benchmarks, comparisons, citations | `research.md` |
| Delegation, parallel agents, review teams, workflows, child reports | `collaboration.md` |
| Ambiguous diagnosis, long tasks, effort choice, context compaction | `reasoning-tools.md` |
| Judging 3D models, renders, images, art references, or screenshots by how they look | `visual-review.md` |
| A `.uproject`, Unreal module, plugin, asset, Blueprint, or UE build | `unreal-engine.md` plus `software.md` |

Precedence stays fixed whatever the load order: the current request and hard constraints, then the nearest project instructions (`AGENTS.md`, `CLAUDE.md`, and similar in the working tree), then broader project instructions, then these global files. Never carry facts, conventions, or memory from one project into another.

Skills in `~/.agents/skills/` (also `~/.claude/skills/` for Claude Code):

- `verify-claims`: blind check of atomic claims before treating findings as fact or committing.
- `code-research`: evidence-grounded research with current primary sources.
- `task-start`, `task-continue`, `handoff`: multi-session task notes under `.agent-work/` (user-invoked).
