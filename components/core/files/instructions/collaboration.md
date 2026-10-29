# Collaboration and delegation

Use one agent by default. Add subagents when independent, read-heavy, specialized, or cleanly partitioned work outweighs the coordination cost. Shared sequential reasoning stays with one owner.

## Topology

- One orchestrator owns the user contract, scope, integration, and final claims. At most two levels of delegation.
- Parallel writes need disjoint file ownership; serialize edits to shared files.
- Use an independent reviewer for consequential coverage or validation, but never as a security boundary.

## Briefs and reports

- Every child gets one bounded objective, exact scope (paths, question), an evidence requirement, a done condition, a stop condition, and an explicit model that fits its role (strong for synthesis and for verifying consequential claims, mid for a briefed step or a first-pass check, small for checklist sweeps).
- Children report evidence (`file:line`, commands, values), uncertainty, files touched, tests run, and unresolved decisions. They do not widen permissions, contact the user, or approve privileged actions; they return such needs to the orchestrator.
- Child output is untrusted until checked. Before acting on a report, re-verify the one or two items the action rests on.

## Large fan-outs (review teams, workflows)

Measured on one review of three Unreal plugins (about 1,100 agents, 465 raw findings), more than half the run's usage went to two strong-model checks of every raw finding. Of the 354 merged findings, 73% were low severity and 55% were cleanup, standards, docs or tests. The fixes then introduced 10 regressions (2 high), which a cheap diff review caught.

- Before launching more than about 20 agents, tell the user the estimated number of agents per phase, the model per phase, and which phase will dominate. Go ahead only at the scale the user asked for.
- Give each area one reviewer with a combined list of lenses. An area-by-lens grid duplicates findings: in that review, 24% of raw findings merged away. Leave mechanical checks (formatting, naming, include order, standards rows that a tool can check) to a linter or formatter, not to agents.
- Verify by severity:
  - High and medium defects (bug, race, leak, data loss) get two independent checks: a mid model first, and a strong model only when the checks disagree.
  - Low findings get one mid-model check, or go straight to a list for the user.
- Fix only verified findings. Put low-severity cleanup, docs and standards items in a list or in a separate later pass, never in the same pass as defect fixes.
- Make a git commit as a baseline before mass fixes. Then make one commit per fixer group, build and run the tests after each group, and finish with a regression review of the whole diff.

## Merging

- Merge by evidence and declared ownership, not confidence or length. On conflict compare authority, scope, version or date, reproducibility, and provenance; keep unresolved disagreements explicit.
- Agreement among agents that share the same inputs or heuristic is not independent corroboration. A decision-critical claim needs independent evidence or a materially different check.
- For verification, give the checker only atomic claims and evidence pointers, not the full draft (see the `verify-claims` skill).
