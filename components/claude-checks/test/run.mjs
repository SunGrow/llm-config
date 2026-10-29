// Offline tests for the claude-checks scripts. Usage: node components/claude-checks/test/run.mjs
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMP = dirname(HERE), TOOL = join(COMP, 'tool');
const TMP = mkdtempSync(join(tmpdir(), 'checks-test-'));
process.env.PROJECT_MAP_DIR = join(TMP, 'maps');
delete process.env.CLAUDE_CHECKS;
const imp = (f) => import(pathToFileURL(join(TOOL, f)).href);
const pe = await imp('post-edit.mjs'), dc = await imp('done-check.mjs'), ss = await imp('session-stats.mjs');
const sc = await imp('safe-commit.mjs'), pm = await imp('project-map.mjs');

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) pass++; else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : '')); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const hook = (script, input, env = {}, args = []) => spawnSync(process.execPath, [join(TOOL, script), ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 });
const file = (name, text) => { const p = join(TMP, 'src', name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };

// ---- post-edit
{
  const bs = String.fromCharCode(8);
  ok(pe.checkFile(file('a.mjs', `const re = /${bs}word/;\n`)).some(p => p.includes('0x08')), 'post-edit: backspace character found');
  eq(pe.checkFile(file('b.mjs', 'export const x = 1;\n')), [], 'post-edit: valid module passes');
  ok(pe.checkFile(file('c.mjs', 'export const = ;\n')).some(p => p.startsWith('node --check')), 'post-edit: syntax error reported');
  ok(pe.checkFile(file('d.json', '{"a": 1,}')).some(p => p.startsWith('JSON')), 'post-edit: bad JSON reported');
  eq(pe.checkFile(file('tsconfig.json', '{ // comment\n "a": 1 }')), [], 'post-edit: tsconfig comments allowed');
  ok(pe.checkFile(file('e.txt', 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n')).some(p => p.includes('conflict')), 'post-edit: conflict markers reported');
  eq(pe.checkFile(file('f.txt', 'tab\tand\r\nansi \x1b[0m ok\n')), [], 'post-edit: tab, CR and ESC allowed');
  const bad = join(TMP, 'src', 'c.mjs');
  let r = hook('post-edit.mjs', { tool_name: 'Edit', tool_input: { file_path: bad }, cwd: TMP });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* */ }
  ok(j?.decision === 'block' && j.reason.includes(bad), 'post-edit hook: block with reason', r.stdout + r.stderr);
  eq(hook('post-edit.mjs', { tool_input: { file_path: join(TMP, 'src', 'b.mjs') }, cwd: TMP }).stdout, '', 'post-edit hook: silent on a good file');
  eq(hook('post-edit.mjs', { tool_input: { file_path: bad }, cwd: TMP }, { CLAUDE_CHECKS: '0' }).stdout, '', 'post-edit hook: CLAUDE_CHECKS=0');
  r = hook('post-edit.mjs', 'not json');
  ok(r.status === 0 && r.stdout === '', 'post-edit hook: bad stdin fails open');
}

// ---- done-check
{
  const user = (t) => ({ type: 'user', message: { content: t } });
  const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const code = process.platform === 'win32' ? 'D:/proj/src/a.ts' : '/srv/proj/src/a.ts';
  eq(dc.unverifiedEdits([user('fix it'), tool('Edit', { file_path: code })]), [code], 'done-check: edit without a check');
  eq(dc.unverifiedEdits([user('fix it'), tool('Edit', { file_path: code }), tool('Bash', { command: 'npm test' })]), [], 'done-check: edit then test');
  eq(dc.unverifiedEdits([user('fix it'), tool('Bash', { command: 'npm test' }), tool('Write', { file_path: code })]), [code], 'done-check: test then edit');
  eq(dc.unverifiedEdits([user('docs'), tool('Edit', { file_path: code.replace('a.ts', 'README.md') })]), [], 'done-check: prose edits ignored');
  eq(dc.unverifiedEdits([user('x'), tool('Write', { file_path: join(tmpdir(), 'scratch.mjs') })]), [], 'done-check: temp files ignored');
  eq(dc.unverifiedEdits([user('a'), tool('Edit', { file_path: code }), user('now explain'), tool('Read', { file_path: code })]), [], 'done-check: only the current turn counts');
  eq(dc.unverifiedEdits([user('a'), tool('Edit', { file_path: code }), user('<task-notification>x</task-notification>')]), [code], 'done-check: harness messages do not start a turn');
  eq(dc.unverifiedEdits([user('a'), tool('Edit', { file_path: code }), tool('PowerShell', { command: 'dotnet build' })]), [], 'done-check: PowerShell build counts');
  eq(dc.unverifiedEdits([user('a'), tool('Write', { file_path: code.replace('a.ts', 'agg.py') }), tool('Bash', { command: 'python src/agg.py --n 3' })]), [], 'done-check: running the edited script counts');
  ok(!dc.VERIFY.test('git checkout main') && dc.VERIFY.test('node components/jev/test/run.mjs'), 'done-check: verify pattern');
  const tr = join(TMP, 't.jsonl');
  writeFileSync(tr, [user('fix'), tool('Edit', { file_path: code })].map(x => JSON.stringify(x)).join('\n') + '\n');
  let r = hook('done-check.mjs', { transcript_path: tr, cwd: TMP, stop_hook_active: false });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* */ }
  ok(j?.decision === 'block' && j.reason.includes(code), 'done-check hook: block with files', r.stdout + r.stderr);
  eq(hook('done-check.mjs', { transcript_path: tr, cwd: TMP, stop_hook_active: true }).stdout, '', 'done-check hook: once per stop');
  mkdirSync(join(TMP, 'off', '.claude'), { recursive: true }); writeFileSync(join(TMP, 'off', '.claude', 'checks-off'), '');
  eq(hook('done-check.mjs', { transcript_path: tr, cwd: join(TMP, 'off') }).stdout, '', 'done-check hook: project opt-out');
  eq(hook('done-check.mjs', { transcript_path: join(TMP, 'missing.jsonl'), cwd: TMP }).stdout, '', 'done-check hook: missing transcript fails open');
}

// ---- session-stats
{
  const s = ss.sessionStats([
    { type: 'user', timestamp: '2026-10-29T10:00:00Z', message: { content: 'do the thing' } },
    { type: 'assistant', message: { id: 'm1', model: 'opus', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'assistant', message: { id: 'm1', model: 'opus', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'x' }] } },
    { type: 'assistant', message: { id: 'm2', usage: { output_tokens: 7 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: '<task-notification>x</task-notification>' } },
    { type: 'user', message: { content: 'This session is being continued from a previous conversation ...' } },
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', toolUseID: 't1', stdout: '{"hookSpecificOutput":{"permissionDecision":"ask"}}' }, uuid: 'u1' },
    { type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'PreToolUse', toolUseID: 't1', content: ['Jev gate: high-impact command'] }, uuid: 'u2' },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'grep output quoting "permissionDecision":"ask"' }] } },
    { type: 'user', timestamp: '2026-10-29T12:00:00Z', message: { content: 'next' } },
  ]);
  eq([s.prompts, s.compactions, s.interrupts, s.toolCalls, s.toolErrors, s.repeatedCommands, s.gateAsks], [2, 1, 1, 3, 1, 1, 1], 'session-stats: counts');
  eq([s.tokens.output, s.tokens.cacheRead], [12, 100], 'session-stats: usage counted once per message id');
  eq(s.activeMs, 15 * 60e3, 'session-stats: idle gaps capped at 15 min');
  const r = spawnSync(process.execPath, [join(TOOL, 'session-stats.mjs'), '--days', '1', '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(TMP, 'noclaude') }, timeout: 20000 });
  ok(r.status !== 0 || r.stdout.includes('"total"'), 'session-stats CLI: runs (missing projects dir is an error, not a crash loop)', r.stderr);
}

// ---- safe-commit
{
  ok(sc.ATTRIBUTION.test('Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>') && sc.ATTRIBUTION.test('Generated with Claude Code') && !sc.ATTRIBUTION.test('Fix\n\nCo-Authored-By: Jane Doe <jane@example.com>'), 'safe-commit: attribution detection');
  const home = homedir();
  const diff = ['+++ b/a.txt', '+path ' + home.replace(/\\/g, '/') + '/x', '-old ' + home + '/y', '+key sk-or-' + 'v1-abcdefghijklmnopqrstuvwxyz0123', '+++ b/b.txt', '+fine line'].join('\n');
  const hits = sc.scanDiff(diff, sc.privatePatterns());
  ok(hits.some(h => h.startsWith('a.txt: secret')) && hits.some(h => h.includes('private pattern')) && !hits.some(h => h.startsWith('b.txt')), 'safe-commit: added secrets and home paths flagged', JSON.stringify(hits));
  ok(sc.scanDiff('+++ b/a.txt\n-removed ' + home, sc.privatePatterns()).length === 0, 'safe-commit: removed lines may contain them');
  const r = spawnSync(process.execPath, [join(TOOL, 'safe-commit.mjs'), '-F', 'x'], { encoding: 'utf8', input: '', timeout: 20000 });
  eq(r.status, 3, 'safe-commit: refuses without a terminal');
}

// ---- project-map
{
  const repo = join(TMP, 'proj');
  mkdirSync(join(repo, 'src', 'core'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } }));
  writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n'); writeFileSync(join(repo, 'src', 'core', 'a.ts'), ''); writeFileSync(join(repo, 'src', 'b.ts'), '');
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q'); g('add', '.');
  let m = pm.ensureMap(repo);
  const text = readFileSync(m.path, 'utf8');
  ok(!m.fresh && text.includes('`test`=vitest run') && text.includes('- CLAUDE.md') && text.includes('src/ — 2 files') && text.includes('core/ — 1'), 'project-map: content', text);
  ok(pm.ensureMap(repo).fresh, 'project-map: cached while files unchanged');
  writeFileSync(join(repo, 'src', 'c.ts'), ''); g('add', '.');
  ok(!pm.ensureMap(repo).fresh, 'project-map: rebuilt when tracked files change');
  eq(pm.ensureMap(TMP), null, 'project-map: null outside git');
  const r = hook('project-map.mjs', { cwd: repo, source: 'startup' }, {}, ['--hook']);
  ok(r.status === 0 && r.stdout.includes('Project map') && r.stdout.includes(m.path.replace(/\\/g, '/')), 'project-map hook: names the map', r.stdout + r.stderr);
  eq(hook('project-map.mjs', { cwd: TMP }, {}, ['--hook']).stdout, '', 'project-map hook: silent outside git');
  eq(hook('project-map.mjs', 'bad', {}, ['--hook']).status, 0, 'project-map hook: bad stdin fails open');
}

// ---- manifest
{
  const c = JSON.parse(readFileSync(join(COMP, 'component.json'), 'utf8'));
  ok(c.id === 'claude-checks' && c.default === false, 'manifest: opt-in');
  for (const a of c.actions) ok(spawnSync(process.execPath, ['-e', `require('fs').accessSync(${JSON.stringify(join(COMP, a.from))})`]).status === 0, 'manifest: source exists ' + a.from);
  JSON.parse(readFileSync(join(COMP, 'settings.checks.json.tmpl'), 'utf8'));
}

rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `FAILED ${fail} of ${pass + fail}` : `OK ${pass} checks (node ${process.version} ${process.platform})`);
process.exitCode = fail ? 1 : 0;
