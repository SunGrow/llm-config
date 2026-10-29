// Build data/corpus.json: the target session plus distractor sessions (most recent main-session transcripts).
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { chunkTranscript } from './chunk.mjs';

const TARGET = process.argv[2];
const N = Number(process.argv[3] || 10);
const root = join(homedir(), '.claude', 'projects');
const files = [];
for (const p of readdirSync(root)) for (const f of readdirSync(join(root, p))) if (f.endsWith('.jsonl')) { const fp = join(root, p, f); files.push([fp, statSync(fp).mtimeMs, statSync(fp).size]); }
const others = files.filter(([fp, , size]) => !fp.endsWith(TARGET.split(/[\/]/).pop()) && size > 200e3 && size < 40e6).sort((a, b) => b[1] - a[1]).slice(0, N).map(x => x[0]);
const t = chunkTranscript(TARGET);
const chunks = [...t.chunks];
for (const f of others) chunks.push(...chunkTranscript(f).chunks);
writeFileSync('data/corpus.json', JSON.stringify({ target: TARGET, compactions: t.compactions, sessions: [TARGET, ...others], chunks }, null, 1));
console.log('corpus chunks', chunks.length, 'target', t.chunks.length, 'sessions', others.length + 1);
