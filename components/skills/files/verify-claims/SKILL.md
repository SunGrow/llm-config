---
name: verify-claims
description: Blind check of atomic claims against independent evidence (Verified / Contradicted / Not checked / Abstain). Use after an investigation or subagent report, before treating findings as fact, and before material commits. Does not fix code.
---

# verify-claims (blind, factored)

## Rules

- You are the checker, not the author. Do not read or ask for the author's full draft or narrative; work from atomic claims plus evidence pointers (`file:line`, log path, test name, command, URL).
- When delegating the check, give the checker subagent only the claim list and pointers, and use a strong model.
- Labels: **Verified** | **Contradicted** | **Not checked** | **Abstain**. Prefer Abstain to guessing: a wrong Verified is worse than an Abstain.
- One claim per row. Do not merge claims. No "looks fine overall".

## Procedure

1. Restate each claim in one line without adding assertions.
2. For each claim, gather independent evidence with tools (read the code and its call sites, run the test, grep the log, open the primary source). The author's prose is not evidence.
3. Emit:

| # | Claim | Label | Evidence (`file:line` / command / source) | Note |
|---|-------|-------|-------------------------------------------|------|

4. End with: which claims must be re-checked before any change, and which block a commit.

## Out of scope

Implementing fixes, redesigning, or agreeing with anyone without evidence.
