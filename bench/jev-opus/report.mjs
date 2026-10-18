#!/usr/bin/env node
// Summarise results.jsonl: per task x condition success rate, cost, turns, time and process signals.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = join(HERE, process.argv[2] || 'results.jsonl');
const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const rate = (a) => { const v = a.filter(x => x !== null && x !== undefined); return v.length ? `${v.filter(Boolean).length}/${v.length}` : '-'; };
const by = {};
for (const r of rows) (by[r.task] ??= {})[r.cond] ??= [], by[r.task][r.cond].push(r);

const head = ['task', 'cond', 'n', 'ok', 'cost $', 'turns', 'sec', 'outTok', 'runBeforeEdit', 'verifyAfterEdit', 'web', 'agents', 'backup', 'destructive'];
const lines = [head.join(' | '), head.map(() => '---').join(' | ')];
for (const [task, cs] of Object.entries(by)) for (const cond of ['off', 'jev', 'oracle']) {
  const g = cs[cond]; if (!g) continue;
  lines.push([task, cond, g.length, rate(g.map(r => r.ok === 1)), mean(g.map(r => r.cost)).toFixed(3), mean(g.map(r => r.turns)).toFixed(1),
    Math.round(mean(g.map(r => r.ms)) / 1000), Math.round(mean(g.map(r => r.outTok))), rate(g.map(r => r.runBeforeEdit)), rate(g.map(r => r.verifyAfterEdit)),
    rate(g.map(r => r.web)), mean(g.map(r => r.agent)).toFixed(1), rate(g.map(r => r.backup)), rate(g.map(r => r.destructive))].join(' | '));
}
console.log(lines.join('\n'));

console.log('\nTotals by condition (all tasks):');
for (const cond of ['off', 'jev', 'oracle']) {
  const g = rows.filter(r => r.cond === cond); if (!g.length) continue;
  console.log(`${cond}: n=${g.length} ok=${rate(g.map(r => r.ok === 1))} cost=$${mean(g.map(r => r.cost)).toFixed(3)} turns=${mean(g.map(r => r.turns)).toFixed(1)} sec=${Math.round(mean(g.map(r => r.ms)) / 1000)} noteDelivered=${rate(g.filter(r => r.note).map(r => r.noteSeen))}`);
}
// Paired view: the same tasks under off and jev only.
const paired = Object.keys(by).filter(t => by[t].off && by[t].jev);
const sum = (c, f) => paired.reduce((s, t) => s + by[t][c].filter(f).length, 0);
console.log(`\nPaired (${paired.length} tasks): ok off ${sum('off', r => r.ok === 1)} vs jev ${sum('jev', r => r.ok === 1)}`);
const errs = rows.filter(r => r.err || r.exit !== 0);
if (errs.length) console.log(`\n${errs.length} run(s) with errors:`, errs.map(r => `${r.task}/${r.cond}#${r.rep}: exit ${r.exit} ${String(r.err || '').slice(0, 100)}`));
