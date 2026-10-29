#!/usr/bin/env node
// Recall earlier turns of a Claude Code session (e.g. after compaction) by question.
// Usage: node recall.mjs "<question>" --file <transcript.jsonl> [--file ...] [--k 5] [--local]
//   --project   search every transcript in the --file's folder (the project's sessions), not just that file
//   --local     BM25 only, nothing leaves the machine (also forced by JEV_HOOK=0 or a .claude/jev-off / .agents/jev-off file in cwd)
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chunkTranscript, recall } from './recall-core.mjs';
import { optedOut, redact } from './lib.mjs';

const args = process.argv.slice(2);
const files = [];
let k = 5, local = false, project = false, q = '';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--file') files.push(args[++i]);
  else if (a === '--k') k = Math.max(1, Number(args[++i]) || 5);
  else if (a === '--local') local = true;
  else if (a === '--project') project = true;
  else q += (q ? ' ' : '') + a;
}
if (!q.trim() || !files.length) {
  console.error('usage: recall.mjs "<question>" --file <transcript.jsonl> [--project] [--k 5] [--local]');
  process.exit(2);
}
let paths = files;
if (project) paths = [...new Set(files.flatMap(f => readdirSync(dirname(f)).filter(n => n.endsWith('.jsonl')).map(n => join(dirname(f), n))))];
const chunks = paths.flatMap(f => { try { return chunkTranscript(f).chunks; } catch (e) { console.error(`skip ${f}: ${e.message}`); return []; } });
const r = await recall(q, chunks, { k, local: local || optedOut(process.cwd()) });
if (r.note) console.error(r.note);
console.log(`# ${chunks.length} turns from ${paths.length} transcript(s), ranked via ${r.via}. Each hit names file and line range; read around those lines for the full turn.`);
for (const c of r.hits) console.log(`\n## ${c.file} lines ${c.start}-${c.end}\n${redact(c.text).slice(0, 1500)}`);
