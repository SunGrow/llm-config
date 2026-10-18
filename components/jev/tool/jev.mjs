#!/usr/bin/env node
// Jev (TypeSafe) decision CLI, routed through OpenRouter (shared by the Claude Code, Codex and opencode adapters).
//
//   node jev.mjs ask    < request.json        # {state, questions, model?} -> answers JSON
//   node jev.mjs preset <name> < state.txt    # built-in question set from presets.json
//   node jev.mjs presets                      # list preset names
//   node jev.mjs models                       # list Jev models in OpenRouter's public catalog
//
// Output is always one JSON object on stdout; exit 1 when ok is false.
// Every call is appended to logs/decisions.jsonl (state hash and length only, never the text; rotates at 5 MB).
import { readFileSync } from 'node:fs';
import { decide, runPreset, presets } from './lib.mjs';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// Set exitCode instead of process.exit(): exiting with open fetch handles trips a libuv assertion on Windows.
function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = obj.ok ? 0 : 1;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'ask') {
  let req;
  try { req = JSON.parse(readStdin()); } catch (e) { req = null; out({ ok: false, error: { message: 'stdin is not JSON: ' + e.message } }); }
  if (req && (!req.state || !req.questions)) out({ ok: false, error: { message: 'request needs "state" and "questions"' } });
  else if (req) out(await decide(req, { label: req.label || 'ask' }));
} else if (cmd === 'preset') {
  const state = readStdin();
  if (!state.trim()) out({ ok: false, error: { message: 'empty state on stdin' } });
  else out(await runPreset(arg, state));
} else if (cmd === 'presets') {
  out({ ok: true, presets: Object.fromEntries(Object.entries(presets()).map(([k, v]) => [k, v.description])) });
} else if (cmd === 'models') {
  try {
    const j = await (await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) })).json();
    out({ ok: true, note: 'public catalog only; versioned ids such as typesafe/jev-1.14 can be callable without being listed', models: j.data.filter(m => /typesafe|jev/i.test(m.id)).map(m => m.id) });
  } catch (e) { out({ ok: false, error: { message: String(e?.message || e).slice(0, 300) } }); }
} else {
  out({ ok: false, error: { message: 'usage: jev.mjs ask|preset <name>|presets|models' } });
}
