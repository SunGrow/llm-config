# Reasoning, effort, and context

Match effort to uncertainty, consequence, reversibility, and validation cost.

- Low: reversible lookups, formatting, narrow mechanical edits with clear checks.
- Medium: ordinary implementation, diagnosis, bounded research.
- High: architecture, security, migrations, ambiguous failures, synthesis across conflicting evidence.
- Maximum: only when material risk or demonstrated difficulty justifies the latency and token cost.

## Tools

- Start with the smallest sufficient evidence set. Observe current state with tools; do not rely on recollection for files, command output, versions, or live facts.
- Prefer deterministic checks (tests, grep, type checks, dumps) over repeated deliberation. Filter large output first (search patterns, time windows, line ranges), then read only the matching parts.
- Stop exploring when the decision is supported, material alternatives are covered, and the requested validation passes.

## Long tasks and compaction

- Keep durable task state in explicit files (for example a task note), not only in the conversation.
- Before compaction or a handoff, preserve canonical evidence references and active constraints: goal, open `Assumption:` items, changed files, verbatim prohibitions, open questions, last verification and its depth. A summary is navigation, not proof: re-verify volatile state after a restart.
- Do not reveal or store hidden reasoning. Communicate conclusions, evidence, assumptions, and checks. Keep identifiers, code, paths, and literals in their original language.
