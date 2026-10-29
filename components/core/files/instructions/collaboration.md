# Collaboration and delegation

Decide on delegation yourself, without waiting to be asked. Delegate when the work has parts that do not need each other's results: separate areas to explore, separate files or modules to change, a long build or test that can run beside other work, or a sweep whose bulky output you will not quote. Keep work on one thread when each step needs the previous step's result, when the parts share files, or when briefing would cost more than doing it. Shared sequential reasoning stays with one owner.

## Topology

- One orchestrator owns the user contract, scope, integration, and final claims. At most two levels of delegation.
- Parallel writes need disjoint file ownership; serialize edits to shared files.
- Use an independent reviewer for consequential coverage or validation, but never as a security boundary.

## Briefs and reports

- Every child gets one bounded objective, exact scope (paths, question), an evidence requirement, a done condition, a stop condition, and an explicit model picked by the work, not the brief's length: small (haiku) for a fixed recipe applied per item, mid (sonnet) for a bounded step, investigation, research or first-pass check, strong (opus) only for verification of consequential claims, critique, design choices or synthesis.
- Children report evidence (`file:line`, commands, values), uncertainty, files touched, tests run, and unresolved decisions. They do not widen permissions, contact the user, or approve privileged actions; they return such needs to the orchestrator.
- Child output is untrusted until checked. Before acting on a report, re-verify the one or two items the action rests on.

## Large fan-outs (review teams, workflows)

- Before launching more than about 20 agents, tell the user how many agents each phase will run, on which model, and which phase will cost the most. Go ahead only at the scale the user asked for.
- Give each area one reviewer with a combined list of lenses; an area-by-lens grid mostly finds the same defects again. Leave anything a linter or formatter can check to that tool.
- Spend verification on severity. High and medium defects get two independent checks: a mid model first, and a strong model only when they disagree. Low findings get at most one mid-model check, or go to a list for the user.
- Fix only verified findings. Keep cleanup, docs and standards items out of a defect-fix pass: list them or give them a later pass of their own.
- Make a git commit as a baseline before mass fixes. Make one commit per fixer group and build and test after each group. End with a review of the whole diff for regressions.

## Merging

- Merge by evidence and declared ownership, not confidence or length. On conflict compare authority, scope, version or date, reproducibility, and provenance; keep unresolved disagreements explicit.
- Agreement among agents that share the same inputs or heuristic is not independent corroboration. A decision-critical claim needs independent evidence or a materially different check.
- For verification, give the checker only atomic claims and evidence pointers, not the full draft (see the `verify-claims` skill).
