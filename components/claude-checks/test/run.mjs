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
process.env.AGENTS_HOOK_ERRORS = join(TMP, 'hook-errors.log');
process.env.AGENTS_HOOK_HEALTH_SEEN = join(TMP, 'hook-health.seen');
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
  eq(['y', 'y\\', 'Y', '\r', ' ', 'д', 'n', 'N', 'т', '\x1b', '\x03', '\x04'].map(sc.isYes), [true, true, true, true, true, true, false, false, false, false, false, false], 'safe-commit: any key confirms except n, Esc, Ctrl-C, Ctrl-D');
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

// ---- shell-guard
{
  const sg = await imp('shell-guard.mjs');
  for (const c of ['sleep 240; cat log', 'make & sleep 90; tail out', 'until grep -q done log; do sleep 5; done', 'for i in $(seq 1 30); do [ -f x ] && break; sleep 2; done',
    '$d=(Get-Date).AddSeconds(300); while ((Get-Date) -lt $d) { Start-Sleep 5 }', 'do { Start-Sleep -Seconds 5 } until (Test-Path x)', 'Start-Sleep -Seconds 60'])
    ok(sg.isPollWait(c), 'shell-guard: flags ' + c);
  for (const c of ['npm test', 'sleep 2; ls', 'Start-Sleep 10', 'for k in a b c; do tmux send-keys $k; sleep 1; done', "python - <<'EOF'\nwhile True:\n    time.sleep(5)\nEOF\necho ok", 'grep -n "sleep 300" notes.md'])
    ok(!sg.isPollWait(c), 'shell-guard: passes ' + c);
  const env = { CLAUDE_CHECKS_STATE: join(TMP, 'once-sg') };
  const cmd = 'until [ -f done ]; do sleep 5; done ' + Date.now();
  const r1 = hook('shell-guard.mjs', { tool_name: 'Bash', cwd: TMP, tool_input: { command: cmd } }, env);
  ok(JSON.parse(r1.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny', 'shell-guard hook: denies first time', r1.stdout + r1.stderr);
  eq(hook('shell-guard.mjs', { tool_name: 'Bash', cwd: TMP, tool_input: { command: cmd } }, env).stdout, '', 'shell-guard hook: same command passes on re-issue');
  eq(hook('shell-guard.mjs', { tool_name: 'Bash', cwd: TMP, tool_input: { command: cmd + ' x', run_in_background: true } }, env).stdout, '', 'shell-guard hook: background passes');
  eq(hook('shell-guard.mjs', 'bad', env).status, 0, 'shell-guard hook: bad stdin fails open');
}

// ---- fanout-nudge
{
  const fn = await imp('fanout-nudge.mjs');
  const user = (t) => ({ type: 'user', uuid: 'u-' + t, message: { content: t } });
  const call = (i, name = 'Bash') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + i, name, input: {} }] } });
  const calls = (n, from = 0) => Array.from({ length: n }, (_, i) => call(from + i));
  eq(fn.turnState([user('old'), ...calls(50), user('new'), ...calls(3, 100)]), { calls: 3, delegated: false, promptId: 'u-new' }, 'fanout: counts the current turn only');
  eq(fn.turnState([user('p'), ...calls(5), call(9, 'Agent')]).delegated, true, 'fanout: an Agent call counts as delegated');
  const tr = join(TMP, 'fan.jsonl');
  writeFileSync(tr, [user('go'), ...calls(fn.NUDGE_AT)].map(e => JSON.stringify(e)).join('\n') + '\n');
  const env = { CLAUDE_CHECKS_STATE: join(TMP, 'once-fan') };
  const inp = { transcript_path: tr, session_id: 's' + Date.now(), cwd: TMP, tool_name: 'Bash' };
  const r1 = hook('post-tool.mjs', inp, env);
  ok(JSON.parse(r1.stdout || '{}').hookSpecificOutput?.additionalContext === fn.NOTE, 'fanout hook: nudges at the threshold', r1.stdout + r1.stderr);
  eq(hook('post-tool.mjs', inp, env).stdout, '', 'fanout hook: once per turn');
  eq(hook('post-tool.mjs', { ...inp, session_id: 'x' + Date.now(), agent_id: 'a1' }, env).stdout, '', 'fanout hook: silent inside a subagent');
}

// ---- context notes (inside post-tool)
{
  const cn = await imp('context-note.mjs');
  const env = { CLAUDE_CHECKS_COUNTERS: join(TMP, 'img'), CLAUDE_CHECKS_STATE: join(TMP, 'once-cn') };
  const sid = 'cn' + Date.now();
  const img = { tool_name: 'mcp__Claude_Browser__computer', session_id: sid, cwd: TMP, tool_response: [{ type: 'image', source: {} }] };
  const outs = [1, 2, 3].map(() => hook('post-tool.mjs', img, env).stdout);
  ok(outs[0] === '' && outs[1] === '' && outs[2].includes('3 image/screenshot results'), 'context note: every third image', JSON.stringify(outs));
  eq(hook('post-tool.mjs', { tool_name: 'Bash', session_id: sid, cwd: TMP, tool_response: { stdout: 'small' } }, env).stdout, '', 'context note: small result silent');
  eq(hook('post-tool.mjs', { ...img, agent_id: 'a' }, env).stdout, '', 'context note: silent in subagents');
}

// ---- spill (inside post-tool)
{
  const sp = await imp('spill.mjs');
  const env = { CLAUDE_CHECKS_SPILL_DIR: join(TMP, 'spill'), CLAUDE_CHECKS_STATE: join(TMP, 'once-sp') };
  const sid = 'sp' + Date.now();
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ` + 'x'.repeat(10)).join('\n');
  const post = (input) => JSON.parse(hook('post-tool.mjs', { session_id: sid, cwd: TMP, tool_use_id: 'toolu_' + Math.random().toString(36).slice(2), ...input }, env).stdout || '{}').hookSpecificOutput || {};
  let o = post({ tool_name: 'Bash', tool_response: { stdout: big, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } });
  const u = o.updatedToolOutput, path = u?.stdout?.match(/Full output \(\d+ characters\): (\S+)/)?.[1];
  ok(u && u.stdout.length < 4000 && u.stdout.startsWith('line 0 ') && u.stdout.endsWith(big.slice(-50)), 'spill: Bash stdout keeps head and tail only', JSON.stringify(o).slice(0, 300));
  eq(Object.keys(u || {}).sort(), ['interrupted', 'isImage', 'noOutputExpected', 'stderr', 'stdout'], 'spill: Bash result keeps its shape');
  ok(path && readFileSync(path, 'utf8').includes('line 1999 '), 'spill: full output saved to the named file', path);
  ok(!o.additionalContext, 'spill: no size note once spilled');
  eq(post({ tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(sp.SPILL_AT - 10), stderr: '' } }).updatedToolOutput, undefined, 'spill: under the threshold untouched');
  o = post({ tool_name: 'mcp__blueprint-extractor__extract_blueprint', tool_response: [{ type: 'text', text: big }, { type: 'image', source: { data: 'abc' } }] });
  ok(Array.isArray(o.updatedToolOutput) && o.updatedToolOutput[0].text.length < 4000 && o.updatedToolOutput[1].source.data === 'abc', 'spill: MCP text shrinks, images untouched', JSON.stringify(o).slice(0, 200));
  o = post({ tool_name: 'Glob', tool_response: { filenames: Array.from({ length: 900 }, (_, i) => `D:/proj/src/some/deep/folder/file${i}.ts`), numFiles: 900, truncated: false } });
  ok(o.updatedToolOutput?.filenames.length === 51 && /850 more entries/.test(o.updatedToolOutput.filenames[50]) && o.updatedToolOutput.numFiles === 900, 'spill: long file lists keep the first entries', JSON.stringify(o).slice(0, 200));
  eq(post({ tool_name: 'Agent', tool_response: { content: [{ type: 'text', text: big }] } }).updatedToolOutput, undefined, 'spill: subagent reports untouched');
  eq(post({ tool_name: 'mcp__visualize__read_me', tool_response: [{ type: 'text', text: big }] }).updatedToolOutput, undefined, 'spill: instruction pages untouched');
  const content = Array.from({ length: 4000 }, (_, i) => `${i + 1}\tconst value${i} = ${i};`).join('\n');
  o = post({ tool_name: 'Read', tool_response: { type: 'text', file: { filePath: 'D:/x.ts', content, numLines: 4000, startLine: 1, totalLines: 4000 } } });
  const rc = o.updatedToolOutput?.file?.content || '';
  const m = rc.match(/lines 1-(\d+) of 4000 shown\. Continue with Read offset=(\d+)/);
  ok(rc.length < sp.READ_AT + 400 && m && Number(m[2]) === Number(m[1]) + 1 && rc.includes(`${m[1]}\tconst value${m[1] - 1} =`), 'spill: Read keeps a contiguous head and names the next offset', rc.slice(-200));
  eq(post({ tool_name: 'Read', tool_response: { type: 'text', file: { filePath: 'D:/y.ts', content: 'short', numLines: 1, startLine: 1, totalLines: 1 } } }).updatedToolOutput, undefined, 'spill: short Read untouched');
  const mid = content.slice(0, sp.READ_AT_SUB + 5000);
  eq(post({ tool_name: 'Read', tool_response: { type: 'text', file: { filePath: 'D:/z.ts', content: mid, numLines: 1, startLine: 1, totalLines: 4000 } } }).updatedToolOutput, undefined, 'spill: main-thread Read under its cap untouched');
  const sr = post({ tool_name: 'Read', agent_id: 'sub1', tool_response: { type: 'text', file: { filePath: 'D:/z.ts', content: mid, numLines: 1, startLine: 1, totalLines: 4000 } } }).updatedToolOutput?.file?.content || '';
  ok(sr.length < sp.READ_AT_SUB + 400 && sr.includes(`cut at ${sp.READ_AT_SUB} characters`), 'spill: subagent Read gets the lower cap', sr.slice(-160));
  eq(post({ tool_name: 'Read', agent_id: 'sub1', tool_input: { file_path: 'D:/z.ts', limit: 4000 }, tool_response: { type: 'text', file: { filePath: 'D:/z.ts', content: mid, numLines: 1, startLine: 1, totalLines: 4000 } } }).updatedToolOutput, undefined, 'spill: subagent Read with an explicit range keeps the main-thread cap');
  eq(post({ tool_name: 'Read', agent_id: 'sub1', tool_response: { type: 'image', file: { base64: 'x'.repeat(200000), type: 'image/png' } } }).updatedToolOutput, undefined, 'spill: subagent image Read untouched');
}

// ---- read-guard
{
  const env = { CLAUDE_CHECKS_READS: join(TMP, 'reads'), CLAUDE_CHECKS_STATE: join(TMP, 'once-rg') };
  const f = file('rg.txt', 'one\n'), sid = 'rg' + Date.now();
  const read = (extra = {}, ti = {}) => JSON.parse(hook('read-guard.mjs', { tool_name: 'Read', session_id: sid, cwd: TMP, tool_input: { file_path: f, ...ti }, ...extra }, env).stdout || '{}').hookSpecificOutput?.permissionDecision || 'allow';
  eq(read(), 'allow', 'read-guard: first read allowed');
  eq(read(), 'deny', 'read-guard: unchanged re-read refused');
  eq(read(), 'allow', 'read-guard: re-issued read goes through');
  eq(read({}, { offset: 10, limit: 5 }), 'allow', 'read-guard: another range is a new read');
  eq(read({ agent_id: 'sub1' }), 'allow', 'read-guard: a subagent has its own reads');
  const g = file('rg2.txt', 'a\n');
  const read2 = () => JSON.parse(hook('read-guard.mjs', { tool_name: 'Read', session_id: sid, cwd: TMP, tool_input: { file_path: g } }, env).stdout || '{}').hookSpecificOutput?.permissionDecision || 'allow';
  eq(read2(), 'allow', 'read-guard: second file first read');
  writeFileSync(g, 'a changed file\n');
  eq(read2(), 'allow', 'read-guard: changed file allowed');
  const g3 = file('rg3.txt', 'b\n');
  const read3 = () => JSON.parse(hook('read-guard.mjs', { tool_name: 'Read', session_id: sid, cwd: TMP, tool_input: { file_path: g3 } }, env).stdout || '{}').hookSpecificOutput?.permissionDecision || 'allow';
  read3();
  eq(hook('read-guard.mjs', { session_id: sid, cwd: TMP, source: 'compact' }, env, ['--reset']).status, 0, 'read-guard: reset runs');
  eq(read3(), 'allow', 'read-guard: after compaction the same read is allowed');
  eq(hook('read-guard.mjs', 'bad', env).status, 0, 'read-guard: bad stdin fails open');
}

// ---- hook-health
{
  const hh = await imp('hook-health.mjs'), cm = await imp('common.mjs');
  const cfg = join(TMP, 'cfg'), proj = join(TMP, 'hhproj');
  mkdirSync(cfg, { recursive: true }); mkdirSync(join(proj, '.claude'), { recursive: true });
  const real = join(TOOL, 'post-edit.mjs').replace(/\\/g, '/'), gone = join(TMP, 'gone', 'x.mjs').replace(/\\/g, '/');
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ hooks: {
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: process.execPath, args: [real] }, { type: 'command', command: process.execPath, args: [gone] }] }],
    Stop: [{ hooks: [{ type: 'command', command: `node "${gone}" --x` }, { type: 'command', command: 'pwsh -File $HOME/a.ps1' }] }],
  } }));
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: join(TMP, 'nope.exe'), args: [] }] }] } }));
  const env = { CLAUDE_CONFIG_DIR: cfg };
  const prevCfg = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = cfg;
  const miss = hh.missingFiles(hh.settingsFiles(proj));
  eq(miss.map(m => m.event).sort(), ['PostToolUse', 'SessionStart', 'Stop'], 'hook-health: finds missing scripts and programs, skips $vars and existing files');
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  cm.logHookError('fanout-nudge', new Error('boom one')); cm.logHookError('fanout-nudge', new Error('boom two'));
  const errs = hh.recentErrors('').filter(e => e.hook === 'fanout-nudge');
  ok(errs.length === 1 && errs[0].count === 2 && errs[0].err.includes('boom two'), 'hook-health: errors counted per hook', JSON.stringify(errs));
  eq(hh.recentErrors('9999'), [], 'hook-health: only errors after the last report');
  const r1 = hook('hook-health.mjs', { cwd: proj, source: 'startup' }, env, ['--hook']);
  ok(r1.stdout.includes('Hook health') && r1.stdout.includes('x.mjs') && r1.stdout.includes('boom two'), 'hook-health hook: reports problems', r1.stdout + r1.stderr);
  eq(hook('hook-health.mjs', { cwd: proj, source: 'startup' }, env, ['--hook']).stdout, '', 'hook-health hook: same problems not repeated');
  eq(hook('hook-health.mjs', { cwd: TMP, source: 'startup' }, { CLAUDE_CONFIG_DIR: join(TMP, 'empty-cfg') }, ['--hook']).stdout, '', 'hook-health hook: silent when healthy');
  eq(hook('hook-health.mjs', 'bad', env, ['--hook']).status, 0, 'hook-health hook: bad stdin fails open');
}

// ---- Lua syntax (needs luac or nvim)
if (spawnSync('nvim', ['--version']).status === 0 || spawnSync('luac', ['-v']).status === 0) {
  eq(pe.checkFile(file('ok.lua', 'local x = 1\nreturn x\n')), [], 'lua: valid file passes');
  ok(pe.checkFile(file('bad.lua', 'local x = \n')).some(p => p.startsWith('Lua syntax')), 'lua: syntax error reported');
} else console.log('skip lua: no nvim or luac');

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
