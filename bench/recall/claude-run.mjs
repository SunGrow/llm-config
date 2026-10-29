// End-to-end: headless Claude answers each question from the target transcript, either natively (any tools it
// likes: Grep, Read, Bash) or with the recall CLI offered. A Jev judge compares each answer to the reference.
// Usage: node claude-run.mjs <native|tool> [--model sonnet] [--only q01,q02]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const { decide } = await import(pathToFileURL(join(homedir(), '.agents', 'tools', 'jev', 'lib.mjs')).href);
const [mode = 'native', ...rest] = process.argv.slice(2);
const model = rest.includes('--model') ? rest[rest.indexOf('--model') + 1] : 'sonnet';
const only = rest.includes('--only') ? rest[rest.indexOf('--only') + 1].split(',') : null;
const questions = JSON.parse(readFileSync(join(DATA, 'questions.json'), 'utf8')).filter(q => !only || only.includes(q.id));
// A copy cut before the benchmark began, so no question or answer text from this work can leak in.
const target = join(DATA, 'session-frozen.jsonl').replace(/\\/g, '/');
const recall = join(HERE, '..', '..', 'components', 'jev', 'tool', 'recall.mjs').replace(/\\/g, '/');
const out = join(DATA, 'results', `claude-${mode}-${model}.json`);
mkdirSync(dirname(out), { recursive: true });
const res = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};

const prompt = (q) => [
  `The earlier part of a long working session was compacted, so you no longer remember it. Its full transcript (Claude Code JSONL) is at ${target}.`,
  mode === 'tool'
    ? `To look things up, run: node ${recall} "<question>" --file ${target}  (prints the most relevant turns with their line numbers; rephrase and rerun if needed, read the file around those lines for detail).`
    : 'Look things up in that file with whatever tools you like.',
  'Answer the question below briefly and concretely (numbers, names, reasons). If you cannot find it, say so.',
  '', 'Question: ' + q,
].join('\n');

function runClaude(p) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cp = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--max-turns', '20', '--allowedTools', 'Bash,Read,Grep,Glob'], { cwd: tmpdir(), shell: true, env: { ...process.env, JEV_HOOK: '0' } });
    let so = '', se = '';
    cp.stdout.on('data', d => so += d); cp.stderr.on('data', d => se += d);
    cp.stdin.end(p);
    const kill = setTimeout(() => cp.kill(), 600000);
    cp.on('close', () => {
      clearTimeout(kill);
      let j = {}; try { j = JSON.parse(so); } catch { j = { result: so.slice(-2000), parse_error: se.slice(-500) }; }
      resolve({ answer: j.result ?? '', cost: j.total_cost_usd ?? null, turns: j.num_turns ?? null, ms: Date.now() - t0 });
    });
  });
}

async function judge(q, answer) {
  const r = await decide({ state: { question: q.q, reference_answer: q.answer, candidate_answer: answer.slice(0, 3000) }, questions: {
    correct: { type: 'noul', instructions: 'Does the candidate answer give the same key facts as the reference answer (numbers, names, causes)? Extra detail is fine; missing or contradicting the key point is not.', criteria: { true: 'Key facts match the reference', false: 'Key facts missing, wrong, or "not found"' } },
  } }, { label: 'bench:recall-judge', timeout: 20000 });
  return r.ok ? r.answers.correct?.p ?? null : null;
}

const queue = questions.filter(q => !res[q.id]?.answer);
let next = 0;
async function worker() {
  while (next < queue.length) {
    const q = queue[next++];
    const r = await runClaude(prompt(q.q));
    r.judge = await judge(q, r.answer);
    res[q.id] = { ...r, lang: q.lang };
    writeFileSync(out, JSON.stringify(res, null, 1));
    console.log(q.id, 'judge', r.judge, 'cost', r.cost, 'turns', r.turns, Math.round(r.ms / 1000) + 's');
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const all = Object.values(res).filter(r => r.answer);
const avg = (f) => all.reduce((s, r) => s + (Number(f(r)) || 0), 0) / all.length;
console.log(JSON.stringify({ mode, model, n: all.length, correct: avg(r => r.judge >= 0.5).toFixed(2), meanCost: avg(r => r.cost).toFixed(3), meanTurns: avg(r => r.turns).toFixed(1), meanSec: (avg(r => r.ms) / 1000).toFixed(0) }));
