# Model routing evidence

Backs `ROUTES` in `components/jev/tool/agent-model-hook.mjs` and the table in `components/core/files/instructions/collaboration.md`. Accessed 2026-11-01; recheck when a model changes. Pages were read through a summarizing fetch, not as raw HTML. Numbers from different benchmarks are not comparable with each other.

## Gaps by domain

Vendor means Anthropic reported it. Effort is stated only where the source states it.

| Domain | Benchmark (source type) | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 | Fable 5.1 |
| --- | --- | --- | --- | --- | --- |
| General | Artificial Analysis Intelligence Index (independent) | see below | see below | see below | see below |
| Agentic code | Terminal-Bench 4.0 official board, max (independent, via BenchLM) | 64.85% | 61.82% | none | 57.88% |
| Agentic code | Terminal-Bench 4.0 (vendor) | 66.4% xhigh | 70.6% | 39.2% | 55.8% |
| Agentic code | FrontierCode 1.1 (vendor) | 54.6% medium, 54.4% max | 52.1% xhigh, 46.2% max | 46.4% | 50.3% |
| Agentic code | CursorBench 4.0 (vendor) | 57.8%, 52.5% medium | 55.5% | none | 51.8% max |
| Agentic work | arena.ai Agent, net improvement, cost, time (independent) | 20.94%, $6.91, 19.7 min, max | 13.84%, $4.12, 17.8 min, max | 1.43%, $0.10, 2 min, high | 13.35%, $7.24, 11.6 min, max |
| Code, human votes | arena.ai Coding (independent) | 1551 high | 1529 xhigh | 1489 high | 1537 max |
| Knowledge work | GDPval-AA v2.1 Elo (AA-run, vendor-published) | 1846 max | 1844 | 1620 | 1735 max |
| Reasoning | Humanity's Last Exam, tools (vendor) | 67.7% | 64.5% | 57.4% | 65.6% |
| Computer use | OSWorld 2.1 partial (vendor) | 81.8% | 80.1% | none on this subset | 80.7% |
| 3D scenes, human votes | AA-3D Elo, 55 scenes, 10,000+ votes, max (independent) | tested, not stated | 1194, first, top four tied | not stated | not stated, about $32 per scene |
| Vision to CAD code | BenchCAD Vision2Code no tools, tools (system card, via BenchLM) | 0.730, 0.962 | 0.747, 0.963 | none | none |
| Spatial | SpatialBench Verified (system card, via BenchLM) | 72.0% | 72.5% | none | none |
| Vision, human votes | arena.ai Vision (independent) | 1293 high | 1265 xhigh | not visible | 1288 max |
| Chart reading | Chartography, no tools (vendor) | 64.4% | 61.6% | 46.4% | none |

Roboflow Vision Evals (independent, updated 2026-10-26; set size not stated, some rows are 3-run means), score at low and high effort:

| Task | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| --- | --- | --- | --- |
| Visual reasoning | 83.0, 85.9 | 76.4, 83.9 | 68.9, 74.8 |
| Counting | 80.6, 82.0 | 79.3, 82.9 | 68.9, 73.0 |
| Object detection | 74.5, 76.0 | 74.3, 76.8 | 65.8, 68.2 |
| Identification | 93.8, 95.8 | 91.7, 90.6 | 83.3, 86.5 |
| OCR | 78.3, 79.9 | 66.3, not reported | 61.2, 65.3 |
| Cost per sample, reasoning | $0.0090, $0.011 | $0.0049, $0.0061 | $0.0004, $0.0006 |

## Effort

Artificial Analysis Intelligence Index and cost per task (independent; Haiku variants are not "with fallback", the others are):

| Effort | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 | Fable 5.1 |
| --- | --- | --- | --- | --- |
| low | 35, $0.98 | 25, $0.51 | 19, $0.04 | 38, $4.47 |
| medium | 48, $2.45 | 30, $0.78 | 25, $0.09 | 43, $5.56 |
| high | 52, $3.46 | 41, $1.64 | 30, $0.16 | 47, $7.54 |
| xhigh | 57, $6.05 | 50, $4.09 | 34, $0.25 | 50, $10.85 |
| max | 58, $10.04 | 54, $10.02 | 36, $0.41 | 49, $12.99 |

ARC-AGI-2, Opus 5.5 (independent, ARC Prize verified): low 70.1, medium 87.5, high 93.3, xhigh 92.5, max 91.7.

## Why each route

- **recipe, Haiku high:** same index as Sonnet medium at about a fifth of the cost. Anthropic recommends it for lookups and summaries as a subagent, and not for hard agentic code.
- **research, Sonnet high:** GDPval 1844 against 1846 for Opus. Sonnet below high falls steeply on the index (30 at medium). No research benchmark sweeps effort, so high is inferred from that index.
- **code, Sonnet high:** Sonnet trails Opus by 2 to 3 points at xhigh or max on the benchmarks with independent or labelled runs. No code benchmark measures Sonnet at high, so this route is the least measured; xhigh costs about 2.5 times as much on the index.
- **hard_code, Opus medium:** FrontierCode gives 54.6 at medium and 54.4 at max, above Sonnet xhigh, and the index cost is below Sonnet xhigh. CursorBench disagrees on medium (52.5 against 57.8), so xhigh is the next step if medium falls short.
- **build_3d, Sonnet high:** Sonnet ties Opus on BenchCAD and SpatialBench and comes first in AA-3D, where Opus's score is not stated. Tools matter far more than the model: BenchCAD rises from about 0.74 to 0.96 with tools, and in AA-3D viewing renders early correlates with rank (Spearman 0.82). No 3D benchmark sweeps effort, and none measures anatomy or taste.
- **visual, Sonnet high:** within noise of Opus on reasoning, counting and detection at high, about 5 points behind on identification. It loses 7.5 points on reasoning at low, so not below high. Haiku trails Sonnet by 4 to 10 points at high.
- **read_image_text, Opus low:** OCR 78.3 against Sonnet 66.3 at low and Haiku 65.3 at high. High effort adds only 1.6 points.
- **verify, Opus high:** ARC-AGI-2 peaks at high, and high adds 4 index points for about $1 over medium. xhigh adds 5 more for about $2.60, worth asking for on a very costly decision.
- **Never by default, max and Fable:** Sonnet at max scored below xhigh on FrontierCode, where it made out-of-scope edits; Opus at max scored below high on ARC-AGI-2. Fable costs more than Opus at every effort and scores lower on nearly every row above.

## Disagreements and limits

- Terminal-Bench 4.0 is reported differently by source: Sonnet is ahead in Anthropic's table, and behind in the official board and in Vals' mirror (65.15 against 64.14). The Vals snapshot text also gives 61.62 for Opus and 53.03 for Sonnet. Most of these do not state effort for Sonnet.
- Anthropic's tables mix effort levels, and some Sonnet figures differ between its own pages (OSWorld 80.1 and 83.9 on different subsets, GDPval 1844 and 1840).
- Opus and Fable runs have safeguards that fall back to other models, which Anthropic says likely lowers their scores.
- BenchCAD and SpatialBench numbers come through an aggregator that cites the system cards. The cards were not read directly. A secondary report of the BenchCAD paper gives lower Vision2Code numbers (0.384 rising to 0.650 with tools), so the size of the tool gain is less settled than the direction.
- Local blind test (`perception-tools.md`) agrees with the visual route on a small set: Sonnet found 8 to 11 of 12 surface defects across views and Opus 8 to 12, with no false alarms; Haiku found 4 to 7 with false alarms.
- No source measures judging character anatomy, the cost of these routes in subscription limits, or Sonnet's coding at high effort.
