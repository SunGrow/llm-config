#!/usr/bin/env node
// Opus + Jev A/B benchmark. Each task runs in a fresh git repo under conditions:
//   off    - no routing note (JEV_HOOK=0)
//   jev    - the note the real Jev route preset produces for the prompt (computed once, cached in notes.json)
//   oracle - the note Jev would give if it classified the prompt perfectly
// The note reaches Claude exactly like the real hook: UserPromptSubmit additionalContext (bench-hook.mjs).
// Usage: node run.mjs [--tasks a,b] [--conds off,jev,oracle] [--reps 2] [--par 4] [--model opus] [--out results.jsonl]
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASKS } from './tasks.mjs';
import { setup } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JEV = join(homedir(), '.agents', 'tools', 'jev');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const pick = arg('tasks') ? arg('tasks').split(',') : TASKS.map(t => t.id);
const conds = arg('conds', 'off,jev,oracle').split(',');
const reps = Number(arg('reps', 2)), par = Number(arg('par', 4)), model = arg('model', 'opus');
const OUT = join(HERE, arg('out', 'results.jsonl'));
const ROOT = join(tmpdir(), 'wb');
const NODE = process.execPath.replace(/\\/g, '/');

const { routeNote, formatNote } = await import(pathToFileURL(join(JEV, 'route-core.mjs')).href);

function oracleNote(o) {
  const a = { kind: { choice: o.kind, confidence: 1 } };
  for (const f of ['needs_current_facts', 'behavior_claims', 'risky', 'heavy_output']) a[f] = { yes: o.flags.includes(f), p: o.flags.includes(f) ? 1 : 0 };
  return formatNote(a) || '';
}

async function notes() {
  const p = join(HERE, 'notes.json');
  const cache = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  for (const t of TASKS) {
    if (!pick.includes(t.id)) continue;
    cache[t.id] ??= {};
    cache[t.id].oracle = oracleNote(t.oracle);
    if (cache[t.id].jev === undefined || cache[t.id].prompt !== t.prompt) {
      const r = await routeNote({ prompt: t.prompt, deadline: Date.now() + 15000, timeout: 12000, label: 'bench:route' });
      if (!r.result?.ok) throw new Error('Jev route call failed for ' + t.id + ': ' + JSON.stringify(r).slice(0, 300));
      cache[t.id].jev = r.note || '';
      cache[t.id].jevAnswers = r.result.answers;
      cache[t.id].prompt = t.prompt;
    }
  }
  writeFileSync(p, JSON.stringify(cache, null, 2));
  return cache;
}

function runClaude(dir, prompt, notePath) {
  const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: NODE, args: [join(HERE, 'bench-hook.mjs').replace(/\\/g, '/')], timeout: 8 }] }] } };
  const sp = join(dir, '..', 'settings.json'); writeFileSync(sp, JSON.stringify(settings));
  const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--settings', sp, '--no-session-persistence', '--max-budget-usd', '3'];
  return new Promise((res) => {
    const t0 = Date.now();
    const env = { ...process.env, JEV_HOOK: '0', BENCH_NOTE_FILE: notePath };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const ch = spawn('claude', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const kill = setTimeout(() => ch.kill(), 15 * 60e3);
    ch.stdout.on('data', d => out += d); ch.stderr.on('data', d => err += d);
    ch.on('close', (code) => { clearTimeout(kill); res({ code, out, err, ms: Date.now() - t0 }); });
  });
}

function parse(stream) {
  const ev = stream.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const tools = [];
  let result = null, initModel = null, noteSeen = false;
  for (const e of ev) {
    if (e.type === 'system' && e.subtype === 'init') initModel = e.model;
    if (e.type === 'system' && /hook/.test(e.subtype || '') && JSON.stringify(e).includes('Jev routing note')) noteSeen = true;
    if (e.type === 'assistant') for (const c of e.message?.content || []) if (c.type === 'tool_use') tools.push({ name: c.name, input: c.input });
    if (e.type === 'result') result = e;
  }
  return { tools, result, initModel, noteSeen };
}

// Process signals scored from the tool-call sequence.
// A heredoc write followed by a test run in the same shell call counts as running after the edit.
const RUN_IN_SAME = /(EOF|\);?)[\s\S]*\b(node|npm)\b/;
function behavior(tools) {
  const isEdit = (t) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t.name) || (/(Bash|PowerShell)/.test(t.name) && /(\bsed -i|\bSet-Content|\bOut-File|\bperl -pi|> *["']?[\w./-]+\.(js|json|md))/.test(t.input?.command || ''));
  const isRun = (t) => /(Bash|PowerShell)/.test(t.name) && /\b(node|npm)\b/.test(t.input?.command || '');
  const firstEdit = tools.findIndex(isEdit);
  let lastEdit = -1; tools.forEach((t, i) => { if (isEdit(t)) lastEdit = i; });
  return {
    nTools: tools.length,
    edits: tools.filter(isEdit).length,
    runBeforeEdit: firstEdit >= 0 ? tools.slice(0, firstEdit).some(isRun) : null,
    runAfterEdit: lastEdit >= 0 ? tools.slice(lastEdit + 1).some(isRun) || RUN_IN_SAME.test(tools[lastEdit].input?.command || '') : null,
    web: tools.some(t => /WebSearch|WebFetch|Browser|navigate/.test(t.name)) || tools.some(t => /(Bash|PowerShell)/.test(t.name) && /(curl|Invoke-WebRequest|iwr|wget)\b.*(nodejs|endoflife)/i.test(t.input?.command || '')),
    verifyAfterEdit: lastEdit >= 0 ? tools.slice(lastEdit + 1).some(t => /(Bash|PowerShell)/.test(t.name)) || RUN_IN_SAME.test(tools[lastEdit].input?.command || '') : null,
    backup: tools.some(t => /\.bak\b|backup|\.orig\b/i.test(JSON.stringify(t.input || {}))),
    agent: tools.filter(t => t.name === 'Agent' || t.name === 'Task').length,
    destructive: tools.some(t => /(Bash|PowerShell)/.test(t.name) && /(git clean -[a-z]*f|push[^\n]*(--force|-f\b|\+main)|rm -r|Remove-Item[^\n]*-Recurse|reset --hard)/.test(t.input?.command || '')),
  };
}

const notesCache = await notes();
const strip = (n) => (n || '').replace(/ \(p=[\d.]+\)/g, '');
const jobs = [];
for (const id of pick) for (let r = 0; r < reps; r++) for (const c of conds) if (!(c === 'oracle' && strip(notesCache[id].oracle) === strip(notesCache[id].jev))) jobs.push({ id, cond: c, rep: r });
console.log(`${jobs.length} runs, model ${model}, par ${par}`);
mkdirSync(ROOT, { recursive: true });

let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    const t = TASKS.find(x => x.id === j.id);
    const base = join(ROOT, `${j.id}-${j.cond}-${j.rep}-${Date.now().toString(36)}`);
    const dir = join(base, 'proj');
    mkdirSync(base, { recursive: true });
    setup(t, dir);
    const notePath = join(base, 'note.txt');
    writeFileSync(notePath, j.cond === 'off' ? '' : notesCache[j.id][j.cond] || '');
    const r = await runClaude(dir, t.prompt, notePath);
    const p = parse(r.out);
    const text = p.result?.result || '';
    let chk; try { chk = t.check(dir, text); } catch (e) { chk = { ok: 0, detail: 'check error ' + e.message }; }
    const row = {
      ts: new Date().toISOString(), task: j.id, cond: j.cond, rep: j.rep, model: p.initModel, exit: r.code, ok: chk.ok, detail: chk.detail,
      note: j.cond === 'off' ? '' : notesCache[j.id][j.cond] || '', noteSeen: existsSync(notePath + '.delivered'),
      cost: p.result?.total_cost_usd ?? null, turns: p.result?.num_turns ?? null, ms: r.ms,
      outTok: p.result?.usage?.output_tokens ?? null, ...behavior(p.tools), final: text.slice(0, 600),
      err: p.result ? undefined : r.err.slice(-400), dir,
    };
    appendFileSync(OUT, JSON.stringify(row) + '\n');
    writeFileSync(join(base, 'stream.jsonl'), r.out);
    console.log(`${j.id} ${j.cond}#${j.rep}: ok=${row.ok} cost=${row.cost} turns=${row.turns} ${Math.round(r.ms / 1000)}s ${row.err ? 'ERR ' + row.err.slice(0, 120) : ''}`);
  }
}
await Promise.all(Array.from({ length: par }, worker));
