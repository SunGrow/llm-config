# Transcript recall benchmark

Can Claude find details from the compacted part of a long session, and which ranker helps it most?

- **Corpus:** one real 13 MB Claude Code session with 3 compactions, plus the 10 most recent other sessions as distractors. In total that is 392 turns: the user message plus the assistant's text, with tool output dropped (`chunk.mjs`, shared with the shipped tool).
- **Questions:** 30 questions about the pre-compaction part (20 English, 10 Russian). They are paraphrased, with few literal identifiers, and cover six kinds: fact, number, reason, decision, failure and instruction. Each has gold turn ids and a reference answer.
- The corpus, questions and per-question results hold private transcript text, so they stay in `data/` (gitignored). Only aggregate numbers are reported here.

```bash
node build-corpus.mjs <session.jsonl> 10      # data/corpus.json
node run.mjs [method ...]                       # retrieval: hit@k, MRR, cost, latency -> data/summary.json
node claude-run.mjs native|tool [--model sonnet]   # end-to-end answers, judged by Jev against the reference
```

## Retrieval (all 392 turns; a hit means a gold turn was ranked at or above k)

| Method | hit@1 | hit@5 | MRR | Russian hit@5 | $/query | p50 latency |
|---|---|---|---|---|---|---|
| BM25 (local) | 0.57 | 0.70 | 0.63 | 0.30 | 0 | 0 s |
| cohere/rerank-4-fast | 0.77 | 0.90 | 0.84 | 0.80 | 0.014 | 2.7 s |
| cohere/rerank-4-pro | 0.83 | 0.97 | 0.89 | 1.00 | 0.018 | 2.8 s |
| **voyageai/rerank-2.5** | **0.90** | **0.97** | **0.93** | **1.00** | **0.010** | 2.2 s |
| voyageai/rerank-3 | 0.87 | 0.97 | 0.92 | 1.00 | 0.010 | 2.2 s |
| nvidia/nemotron-3.5-rerank-8b:free | 0.80 | 0.93 | 0.87 | 0.90 | 0 | 8.4 s |
| qwen/qwen3-reranker-8b (12 of 30: the provider kept failing) | 0.92 | 0.92 | 0.93 | 1.00 | 0.045 | 11.9 s |
| BM25 top 50, then cohere-4-pro | 0.70 | 0.73 | 0.72 | 0.30 | 0.003 | 1.5 s |
| BM25 top 50, then Jev yes/no per turn | 0.60 | 0.77 | 0.67 | 0.30 | 0.002 | 2.7 s |

- Rerankers handle questions that share no words with the answer, and Russian questions about English turns. BM25 does not.
- Pre-filtering with BM25 caps recall at what BM25 finds.
- Jev, the yes/no classifier, is no better than the pool it is given.
- So the shipped tool sends every turn (up to 1000) to `voyageai/rerank-2.5` and falls back to BM25 offline.

## End to end (Sonnet, `claude -p`, the same 30 questions, transcript cut before this benchmark began)

| Condition | Correct (Jev judge) | Correct (hand-checked disagreements) | Mean turns | Mean $ | Median time |
|---|---|---|---|---|---|
| Native: told the transcript path, searches it itself | 27/30 | about 28/30 | 5.8 | 0.153 | 36 s |
| With the recall CLI (cohere-4-fast at the time) | 28/30 | 30/30 | 2.8 | 0.111 | 17 s |

- Native search does well on a single known file.
- The tool roughly halves turns and time and cuts cost by about 27%.
- In one case native search latched onto an earlier, similar bug and gave the wrong cause.
- Caveats:
  - n = 30, with one session as the target.
  - The judge is a classifier, and its disagreements were checked by hand.
  - The end-to-end run used the weaker cohere-4-fast ranker.
