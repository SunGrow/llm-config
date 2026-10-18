---
trigger: always_on
description: "Shared core rules from ~/.agents (llm-config)."
---

@[Core rules](~/.agents/CORE.md)

## Antigravity

- The rules above are included from `~/.agents/CORE.md`; do not re-read it. If no "Core rules" section appears above (the include did not resolve), read that file now. A "Gemini CLI" section from `~/.gemini/GEMINI.md` may also be loaded; it is meant for Gemini CLI, so do not read CORE.md again because of it.
- Before file writes, multi-step tool work, delegation, or current-fact research, read `~/.agents/ROUTER.md`, then only the packs it selects in `~/.agents/instructions/`. If a file is missing, continue with this rule and say so.
- Skills are installed in `~/.gemini/config/skills/` and `~/.gemini/antigravity-cli/skills/` (same set as `~/.agents/skills/`). Use `verify-claims` before treating a report as fact or committing.
- Subagents in `~/.gemini/config/agents/`: `heavy-output-runner` (bulky read-only evidence), `step-runner` (one briefed step), `project-explorer` (project map), `claim-verifier` and `evidence-overseer` (verification, model `pro`). Read-only roles are not enforced by the harness; their instructions forbid writes.
