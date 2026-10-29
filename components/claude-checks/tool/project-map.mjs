#!/usr/bin/env node
// A cached map of a git project (instruction files, build/test entry points, folder layout), rebuilt only when
// HEAD or the tracked file list changes, so a session can read one file instead of re-exploring the tree.
// Usage: node project-map.mjs [dir] [--print]      write (if stale) and print the map path, or its text with --print
//        node project-map.mjs --hook               Claude Code SessionStart hook (stdin JSON with cwd)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { optedOut, readStdinJson, logHookError } from './common.mjs';

const CACHE = process.env.PROJECT_MAP_DIR || join(homedir(), '.agents', 'cache', 'project-maps');
const INSTRUCTIONS = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', 'CONTRIBUTING.md', 'README.md'];
const ENTRY = /(^|\/)(package\.json|[^/]+\.uproject|[^/]+\.uplugin|[^/]+\.sln|CMakeLists\.txt|Makefile|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|build\.gradle(\.kts)?|pom\.xml|[^/]+\.Build\.cs|[^/]+\.Target\.cs|Dockerfile|justfile|Taskfile\.ya?ml|vitest\.config\.\w+|jest\.config\.\w+|electron\.vite\.config\.\w+)$/;

const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 512 << 20, windowsHide: true });

export function buildMap(root, files) {
  const out = [`# Project map: ${basename(root)}`, '', `Root: ${root.replace(/\\/g, '/')}`, `Tracked files: ${files.length}`, ''];
  const instr = files.filter(f => INSTRUCTIONS.includes(basename(f)) && f.split('/').length <= 3 || f.startsWith('.claude/') && /\.(md|json)$/.test(f) && !f.includes('/settings.local'));
  if (instr.length) out.push('## Instruction and doc files', ...instr.slice(0, 30).map(f => `- ${f}`), '');
  const entries = files.filter(f => ENTRY.test(f) && f.split('/').length <= 4 && !f.includes('node_modules/'));
  if (entries.length) {
    out.push('## Build and test entry points');
    for (const f of entries.slice(0, 40)) {
      let line = `- ${f}`;
      if (basename(f) === 'package.json') {
        try { const s = JSON.parse(readFileSync(join(root, f), 'utf8')).scripts || {}; const k = Object.keys(s); if (k.length) line += ': ' + k.slice(0, 12).map(n => `\`${n}\`=${String(s[n]).slice(0, 60)}`).join(', '); } catch { /* unreadable */ }
      }
      out.push(line);
    }
    out.push('');
  }
  // Folder layout two levels deep with file counts and main extensions.
  const tree = new Map();
  for (const f of files) {
    const parts = f.split('/');
    for (let d = 1; d <= Math.min(2, parts.length - 1); d++) {
      const key = parts.slice(0, d).join('/');
      const t = tree.get(key) || { n: 0, ext: {} };
      t.n++; const e = extname(f).toLowerCase() || '(none)'; t.ext[e] = (t.ext[e] || 0) + 1;
      tree.set(key, t);
    }
  }
  const top = [...tree.entries()].filter(([k]) => !k.includes('/')).sort((a, b) => b[1].n - a[1].n);
  const exts = (t) => Object.entries(t.ext).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e, n]) => `${e} ${n}`).join(', ');
  out.push('## Layout (tracked files)');
  for (const [k, t] of top.slice(0, 25)) {
    out.push(`- ${k}/ — ${t.n} files (${exts(t)})`);
    const subs = [...tree.entries()].filter(([s]) => s.startsWith(k + '/')).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    for (const [s, st] of subs) out.push(`  - ${s.slice(k.length + 1)}/ — ${st.n} (${exts(st)})`);
  }
  const rootFiles = files.filter(f => !f.includes('/'));
  if (rootFiles.length) out.push(`- (root files) ${rootFiles.slice(0, 20).join(', ')}`);
  return out.join('\n') + '\n';
}

// Returns { path, fresh } or null outside a git work tree.
export function ensureMap(dir) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim() || 'no-commits';
  const files = git(root, 'ls-files', '-z').stdout.split('\0').filter(Boolean);
  const stamp = createHash('sha256').update(head + '\n' + files.join('\n')).digest('hex').slice(0, 16);
  const path = join(CACHE, basename(root) + '-' + createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 8) + '.md');
  const marker = `<!-- stamp ${stamp} -->`;
  if (existsSync(path) && readFileSync(path, 'utf8').startsWith(marker)) return { path, fresh: true, root };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, marker + '\n' + buildMap(root, files));
  return { path, fresh: false, root };
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const a = process.argv.slice(2);
  if (a.includes('--hook')) {
    try {
      const input = readStdinJson();
      const cwd = input?.cwd || process.cwd();
      if (!optedOut(cwd) && cwd.replace(/[\\/]+$/, '') !== homedir().replace(/[\\/]+$/, '')) {
        const m = ensureMap(cwd);
        if (m) console.log(`Project map (instruction files, build/test entry points, folder layout; regenerated when tracked files change): ${m.path.replace(/\\/g, '/')}. Read it before exploring the project layout.`);
      }
    } catch (e) { logHookError('project-map', e); /* never block the session */ }
  } else {
    const m = ensureMap(a.find(x => !x.startsWith('--')) || process.cwd());
    if (!m) { console.error('not a git work tree'); process.exit(1); }
    console.log(a.includes('--print') ? readFileSync(m.path, 'utf8') : m.path);
  }
}
