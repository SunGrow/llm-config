// Rankers for transcript recall: lexical BM25, OpenRouter rerank models, and Jev (yes/no relevance per chunk).
// Every ranker returns chunk indices, best first. Text leaves the machine only after Jev's secret redaction.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const JEV = join(homedir(), '.agents', 'tools', 'jev');
const { apiKey, redact, decide } = await import(pathToFileURL(join(JEV, 'lib.mjs')).href);
export { redact };

// ---- BM25 (Latin + Cyrillic words, lowercase, no stemming)
const tok = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(w => w.length > 1);
export function bm25Index(texts, k1 = 1.2, b = 0.75) {
  const docs = texts.map(tok), N = docs.length, df = new Map();
  const avg = docs.reduce((s, d) => s + d.length, 0) / N;
  const tfs = docs.map(d => { const m = new Map(); for (const w of d) m.set(w, (m.get(w) || 0) + 1); for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1); return m; });
  return (query) => {
    const q = [...new Set(tok(query))];
    const scores = tfs.map((tf, i) => q.reduce((s, w) => {
      const f = tf.get(w); if (!f) return s;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      return s + idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * docs[i].length / avg));
    }, 0));
    return scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  };
}

// ---- OpenRouter rerank. docs: array of strings. Returns { order, cost, ms }.
export async function rerank(model, query, docs, { topN = 10, maxChars = 2000 } = {}) {
  const t0 = Date.now();
  const body = { model, query, documents: docs.map(d => redact(d).slice(0, maxChars)), top_n: Math.min(topN, docs.length) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/rerank', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (r.ok) {
      const j = JSON.parse(txt.trim());
      return { order: j.results.map(x => x.index), cost: j.usage?.cost ?? null, ms: Date.now() - t0 };
    }
    if (r.status !== 429 && r.status < 500) throw new Error(`${model} ${r.status}: ${txt.slice(0, 200)}`);
    await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
  }
  throw new Error(`${model}: retries exhausted`);
}

// ---- Jev: one yes/no call per candidate ("does this excerpt answer the question?"), ranked by p.
export async function jevRank(query, docs, { concurrency = 12, maxChars = 2000 } = {}) {
  const t0 = Date.now();
  const scores = new Array(docs.length).fill(-1);
  let cost = 0, next = 0;
  const questions = { answers: { type: 'noul', instructions: 'Does the conversation excerpt contain the information needed to answer the question (the decision, reason, fact or number asked about)?', criteria: { true: 'The excerpt states the answer', false: 'The excerpt is about something else or only mentions the topic' } } };
  async function worker() {
    while (next < docs.length) {
      const i = next++;
      const r = await decide({ state: { question: query, conversation_excerpt: redact(docs[i]).slice(0, maxChars) }, questions }, { label: 'bench:recall', retries: 1, timeout: 15000 });
      if (r.ok) { scores[i] = r.answers.answers?.p ?? 0; cost += r.usage?.cost || 0; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { order: scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]), cost, ms: Date.now() - t0 };
}
