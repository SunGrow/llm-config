// Retrieval benchmark: each method ranks all corpus chunks for each question; a hit is any gold chunk.
// Usage: node run.mjs [method ...]   (default: all). Results are cached per method in data/results/<method>.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bm25Index, rerank, jevRank } from './rankers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data'), OUT = join(DATA, 'results');
mkdirSync(OUT, { recursive: true });
const corpus = JSON.parse(readFileSync(join(DATA, 'corpus.json'), 'utf8'));
const questions = JSON.parse(readFileSync(join(DATA, 'questions.json'), 'utf8'));
const texts = corpus.chunks.map(c => c.text);
const bm25 = bm25Index(texts);
const POOL = 50;

// A method maps a question to { order (chunk indices), cost, ms }.
const rr = (model, pool) => async (q) => {
  if (!pool) return rerank(model, q, texts, { topN: 20 });
  const cand = bm25(q).slice(0, pool);
  const r = await rerank(model, q, cand.map(i => texts[i]), { topN: 20 });
  return { ...r, order: r.order.map(k => cand[k]) };
};
const METHODS = {
  bm25: async (q) => { const t0 = Date.now(); return { order: bm25(q), cost: 0, ms: Date.now() - t0 }; },
  'cohere-4-fast': rr('cohere/rerank-4-fast'),
  'cohere-4-pro': rr('cohere/rerank-4-pro'),
  'voyage-2.5': rr('voyageai/rerank-2.5'),
  'voyage-3': rr('voyageai/rerank-3'),
  'qwen3-8b': rr('qwen/qwen3-reranker-8b'),
  'nemotron-free': rr('nvidia/nemotron-3.5-rerank-8b:free'),
  'bm25>cohere-4-fast': rr('cohere/rerank-4-fast', POOL),
  'bm25>cohere-4-pro': rr('cohere/rerank-4-pro', POOL),
  'bm25>jev': async (q) => { const cand = bm25(q).slice(0, POOL); const r = await jevRank(q, cand.map(i => texts[i])); return { ...r, order: r.order.map(k => cand[k]) }; },
};

function score(order, gold) {
  const gi = new Set(gold.map(g => corpus.chunks.findIndex(c => c.id === g)));
  const rank = order.findIndex(i => gi.has(i)) + 1; // 0 = miss
  return { rank, hit1: rank === 1, hit5: rank > 0 && rank <= 5, hit10: rank > 0 && rank <= 10, rr: rank ? 1 / rank : 0 };
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(METHODS);
for (const name of want) {
  const file = join(OUT, name.replace(/[>/]/g, '_') + '.json');
  const cached = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const q of questions) {
    if (cached[q.id]?.order) continue;
    try { cached[q.id] = { ...(await METHODS[name](q.q)), lang: q.lang }; }
    catch (e) { cached[q.id] = { error: String(e.message).slice(0, 300) }; console.error(name, q.id, cached[q.id].error); if (/40[0-4]/.test(e.message)) break; }
    writeFileSync(file, JSON.stringify(cached));
  }
}

// Summary table over every cached method.
const rows = [];
for (const name of Object.keys(METHODS)) {
  const file = join(OUT, name.replace(/[>/]/g, '_') + '.json');
  if (!existsSync(file)) continue;
  const res = JSON.parse(readFileSync(file, 'utf8'));
  const s = questions.filter(q => res[q.id]?.order).map(q => ({ ...score(res[q.id].order, q.gold), lang: q.lang, cost: res[q.id].cost || 0, ms: res[q.id].ms }));
  if (!s.length) continue;
  const avg = (xs, f) => xs.length ? xs.reduce((a, x) => a + Number(f(x)), 0) / xs.length : NaN;
  const ru = s.filter(x => x.lang === 'ru');
  const ms = s.map(x => x.ms).sort((a, b) => a - b);
  rows.push({ method: name, n: s.length, 'hit@1': avg(s, x => x.hit1).toFixed(2), 'hit@5': avg(s, x => x.hit5).toFixed(2), 'hit@10': avg(s, x => x.hit10).toFixed(2), MRR: avg(s, x => x.rr).toFixed(3), 'ru hit@5': avg(ru, x => x.hit5).toFixed(2), '$/query': avg(s, x => x.cost).toFixed(4), 'p50 ms': ms[Math.floor(ms.length / 2)] });
}
console.table(rows);
writeFileSync(join(DATA, 'summary.json'), JSON.stringify(rows, null, 1));
