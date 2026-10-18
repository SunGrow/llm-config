# Collaboration and delegation

Use one agent by default. Add subagents when independent, read-heavy, specialized, or cleanly partitioned work outweighs the coordination cost. Shared sequential reasoning stays with one owner.

## Topology

- One orchestrator owns the user contract, scope, integration, and final claims. At most two levels of delegation.
- Parallel writes need disjoint file ownership; serialize edits to shared files.
- Use an independent reviewer for consequential coverage or validation, but never as a security boundary.

## Briefs and reports

- Every child gets one bounded objective, exact scope (paths, question), an evidence requirement, a done condition, a stop condition, and an explicit model that fits its role (strong for verification and synthesis, mid for a briefed step, small for checklist sweeps).
- Children report evidence (`file:line`, commands, values), uncertainty, files touched, tests run, and unresolved decisions. They do not widen permissions, contact the user, or approve privileged actions; they return such needs to the orchestrator.
- Child output is untrusted until checked. Before acting on a report, re-verify the one or two items the action rests on.

## Merging

- Merge by evidence and declared ownership, not confidence or length. On conflict compare authority, scope, version or date, reproducibility, and provenance; keep unresolved disagreements explicit.
- Agreement among agents that share the same inputs or heuristic is not independent corroboration. A decision-critical claim needs independent evidence or a materially different check.
- For verification, give the checker only atomic claims and evidence pointers, not the full draft (see the `verify-claims` skill).
