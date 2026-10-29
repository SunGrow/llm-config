// Transcript recall: split Claude Code session transcripts (JSONL) into turns and rank them against a question,
// with an OpenRouter rerank model (text redacted first) or, offline / opted out / on failure, local BM25.
// Benchmark behind the defaults: bench/recall in the llm-config repo.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { apiKey, redact } from './lib.mjs';

export const MAX_CHARS = 2400;     // per chunk; longer turns are split into "(cont.)" parts
export const SEND_CHARS = 2000;    // per chunk sent to the rerank model
export const MAX_SEND = 1000;      // rerank-2.5 request limit; above it BM25 preselects (weak for Russian: bench hit@5 0.30)
export const RECALL_MODEL = process.env.JEV_RECALL_MODEL || 'voyageai/rerank-2.5';
const COMPACT = 'This session is being continued from a previous conversation';

// A turn = the user's typed message plus the assistant's text; tool calls become "[tool: Name]", tool output is dropped.
// Harness messages (strings starting with "<") and compaction summaries do not start turns.
export function chunkTranscript(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const chunks = [], compactions = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join('\n').trim();
    if (text.length > 40) {
      for (let i = 0, k = 0; i < text.length; i += MAX_CHARS, k++) {
        chunks.push({ id: `${basename(path).slice(0, 8)}:${cur.start}${k ? '.' + k : ''}`, file: path, start: cur.start, end: cur.end, text: (k ? '(cont.) ' : '') + text.slice(i, i + MAX_CHARS) });
      }
    }
    cur = null;
  };
  lines.forEach((s, i) => {
    if (!s) return;
    let e; try { e = JSON.parse(s); } catch { return; }
    const ln = i + 1;
    if (e.type === 'user' && typeof e.message?.content === 'string') {
      const t = e.message.content;
      if (t.startsWith(COMPACT)) { compactions.push(ln); flush(); return; }
      if (t.startsWith('<')) return;
      flush();
      cur = { start: ln, end: ln, parts: ['USER: ' + t.trim()] };
      return;
    }
    if (!cur || e.type !== 'assistant') return;
    for (const c of e.message?.content || []) {
      if (c.type === 'text' && c.text?.trim()) cur.parts.push('ASSISTANT: ' + c.text.trim());
      else if (c.type === 'tool_use') cur.parts.push(`[tool: ${c.name}]`);
    }
    cur.end = ln;
  });
  flush();
  return { chunks, compactions };
}

// BM25 over Latin and Cyrillic word tokens (lowercase, no stemming). Returns query => chunk indices, best first.
const tok = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(w => w.length > 1);
export function bm25Index(texts, k1 = 1.2, b = 0.75) {
  const docs = texts.map(tok), N = docs.length || 1, df = new Map();
  const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const tfs = docs.map(d => { const m = new Map(); for (const w of d) m.set(w, (m.get(w) || 0) + 1); for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1); return m; });
  return (query) => {
    const q = [...new Set(tok(query))];
    const scores = tfs.map((tf, i) => q.reduce((s, w) => {
      const f = tf.get(w); if (!f) return s;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      return s + idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * docs[i].length / avg));
    }, 0));
    return scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]).map(x => x[1]);
  };
}

// OpenRouter rerank (POST /api/v1/rerank). Returns { order, cost } with order = indices into docs, best first.
export async function rerank(model, query, docs, { topN = 10, timeout = 30000 } = {}) {
  if (process.env.JEV_OFFLINE === '1') throw new Error('JEV_OFFLINE=1');
  const key = apiKey();
  if (!key) throw new Error('no OpenRouter key');
  const body = JSON.stringify({ model, query, documents: docs.map(d => redact(d).slice(0, SEND_CHARS)), top_n: Math.min(topN, docs.length) });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/rerank', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeout) });
    const txt = await r.text();
    if (r.ok) { const j = JSON.parse(txt.trim()); return { order: j.results.map(x => x.index), cost: j.usage?.cost ?? null }; }
    if (attempt >= 2 || (r.status !== 429 && r.status < 500)) throw new Error(`rerank ${r.status}: ${txt.slice(0, 200)}`);
    await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
  }
}

// Rank chunks for a question. local: never send text off the machine (BM25 only).
// Returns { hits: chunk[], via, cost, note? }.
export async function recall(question, chunks, { k = 5, local = false, model = RECALL_MODEL } = {}) {
  const texts = chunks.map(c => c.text);
  const bm = bm25Index(texts);
  if (!local && chunks.length) {
    try {
      const cand = chunks.length > MAX_SEND ? bm(question).slice(0, MAX_SEND) : texts.map((_, i) => i);
      const r = await rerank(model, question, cand.map(i => texts[i]), { topN: k });
      return { hits: r.order.map(j => chunks[cand[j]]), via: model, cost: r.cost };
    } catch (e) {
      return { hits: bm(question).slice(0, k).map(i => chunks[i]), via: 'bm25', cost: 0, note: 'rerank failed, used BM25: ' + String(e.message).slice(0, 160) };
    }
  }
  return { hits: bm(question).slice(0, k).map(i => chunks[i]), via: 'bm25', cost: 0 };
}
