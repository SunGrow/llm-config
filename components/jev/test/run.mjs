#!/usr/bin/env node
// Offline tests for the Jev component: redaction, command classification, route/gate cores, key lookup,
// log rotation, and the Claude Code / Codex / opencode adapters. No network unless --live.
//   node components/jev/test/run.mjs          # offline (JEV_OFFLINE=1)
//   node components/jev/test/run.mjs --live   # plus a few real Jev calls labelled eval:port-*
// Needs `npm install` in tool/ only for --live (the SDK is imported lazily).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const LIVE = process.argv.includes('--live');
const HERE = dirname(fileURLToPath(import.meta.url));
const COMP = dirname(HERE);
const TOOL = join(COMP, 'tool');
const TMP = mkdtempSync(join(tmpdir(), 'jev-test-'));
process.env.JEV_LOG_DIR = join(TMP, 'logs');
process.env.JEV_OFFLINE = '1'; // offline sections never call out; the live section lifts it
delete process.env.JEV_HOOK;
delete process.env.JEV_TEST_ANSWERS;

const lib = await import(pathToFileURL(join(TOOL, 'lib.mjs')).href);
const route = await import(pathToFileURL(join(TOOL, 'route-core.mjs')).href);
const gate = await import(pathToFileURL(join(TOOL, 'gate-core.mjs')).href);

let pass = 0, fail = 0;
const sections = {};
let section = '';
const group = (name) => { section = name; sections[name] = { pass: 0, fail: 0 }; };
function ok(cond, name, detail = '') {
  if (cond) { pass++; sections[section].pass++; }
  else { fail++; sections[section].fail++; console.log(`FAIL [${section}] ${name}${detail ? ' :: ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ---------------------------------------------------------------- redaction
group('redaction');
{
  const cases = [
    ['sk-or-v1-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', '[REDACTED_KEY]'],
    ['token ghp_' + 'A'.repeat(36), '[REDACTED_TOKEN]'],
    ['AKIA' + 'ABCDEFGHIJKLMNOP', '[REDACTED_AWS]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[REDACTED_JWT]'],
    ['postgres://user:hunter2pass@db.example.com/x', 'postgres://user:[REDACTED]@'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', '[REDACTED]'],
    ['API_KEY=supersecretvalue123', 'API_KEY=[REDACTED]'],
    ['{"password": "p4ssw0rd!"}', '"password": "[REDACTED]'],
    ['"{\\"client_secret\\":\\"abcdef123456\\"}"', '[REDACTED]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[REDACTED_PEM]'],
    ['xoxb-' + '1234567890-abcdefghij', '[REDACTED_TOKEN]'],
    ['blob ' + 'a1'.repeat(30), '[REDACTED_BLOB]'],
    ['line1\\nsk-' + 'x'.repeat(20) + '1', '[REDACTED_KEY]'], // after a JSON escape
  ];
  for (const [input, want] of cases) ok(lib.redact(input).includes(want), 'redacts ' + want, lib.redact(input).slice(0, 80));
  const benign = 'git commit -m "fix: tokenizer handles skip lists" && npm test';
  eq(lib.redact(benign), benign, 'leaves benign text alone');
  ok(!lib.redact('sk-or-v1-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6').includes('a1b2c3d4'), 'no key fragment survives');
}

// ---------------------------------------------------------------- classification
group('classify');
{
  const T = tmpdir();
  const git = (_dir, args) => (args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? 'main\n' : '');
  const gitFeature = (_dir, args) => (args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? 'feature/x\n' : '');
  const proj = join(T, '..', 'jev-proj'); // outside the temp folder (unless tmp is /), used as cwd
  const c = (cmd, cwd = proj, g = git) => gate.classify(cmd, cwd, g);
  const kind = (f) => ({ hard: f.hard.length > 0, destr: f.destructive.length > 0, commit: f.commits.length > 0, push: f.pushes.length > 0 });
  const cases = [
    ['git status', { hard: false, destr: false, commit: false, push: false }],
    ['git commit -m "x"', { hard: false, destr: false, commit: true, push: false }],
    ['git add . && git commit -am "x"', { hard: false, destr: false, commit: true, push: false }],
    ['git -C sub commit -m x', { hard: false, destr: false, commit: true, push: false }],
    ['git push', { hard: false, destr: false, commit: false, push: true }],
    ['git push --force', { hard: true, destr: true, commit: false, push: true }],              // current branch main
    ['git push --force origin feature/x', { hard: false, destr: true, commit: false, push: true }],
    ['git push origin +main', { hard: true, destr: true, commit: false, push: true }],
    ['git push -f origin HEAD:release/1.2', { hard: true, destr: true, commit: false, push: true }],
    ['git push --force-with-lease', { hard: false, destr: true, commit: false, push: true }, gitFeature],
    ['git reset --hard HEAD~1', { hard: true, destr: true, commit: false, push: false }],
    ['git reset --soft HEAD~1', { hard: false, destr: false, commit: false, push: false }],
    ['git clean -fdx', { hard: true, destr: true, commit: false, push: false }],
    ['git clean -n', { hard: false, destr: false, commit: false, push: false }],
    ['git branch -D old', { hard: false, destr: true, commit: false, push: false }],
    ['git checkout -- src/a.ts', { hard: false, destr: true, commit: false, push: false }],
    ['git checkout -b new', { hard: false, destr: false, commit: false, push: false }],
    ['git restore --staged a.ts', { hard: false, destr: false, commit: false, push: false }],
    ['git restore a.ts', { hard: false, destr: true, commit: false, push: false }],
    ['git stash drop', { hard: false, destr: true, commit: false, push: false }],
    ['git stash clear', { hard: true, destr: true, commit: false, push: false }],
    ['git filter-branch --tree-filter x HEAD', { hard: true, destr: true, commit: false, push: false }],
    ['git update-ref -d refs/heads/x', { hard: true, destr: true, commit: false, push: false }],
    ['rm -rf .git', { hard: true, destr: true, commit: false, push: false }],
    ['rm -rf sub/.git', { hard: false, destr: true, commit: false, push: false }],          // nested scaffold .git -> Jev
    ['rm -rf ~', { hard: true, destr: true, commit: false, push: false }],
    ['rm -rf /', { hard: true, destr: true, commit: false, push: false }],
    ['rm -rf node_modules', { hard: false, destr: true, commit: false, push: false }],
    ['rm file.txt', { hard: false, destr: false, commit: false, push: false }],
    ['rm -r *', { hard: true, destr: true, commit: false, push: false }],                   // * outside temp
    [`cd ${JSON.stringify(T)} && rm -r *`, { hard: false, destr: true, commit: false, push: false }], // * inside temp
    ['Remove-Item -Recurse -Force C:\\', { hard: true, destr: true, commit: false, push: false }],
    ['Remove-Item -Recurse build', { hard: false, destr: true, commit: false, push: false }],
    ['rd /s /q build', { hard: false, destr: true, commit: false, push: false }],
    ['$rd = 3', { hard: false, destr: false, commit: false, push: false }],
    ['rd = 3', { hard: false, destr: false, commit: false, push: false }],
    ['FOO=1 git reset --hard', { hard: true, destr: true, commit: false, push: false }],
    ['echo "git reset --hard"', { hard: false, destr: false, commit: false, push: false }],
    ["python3 - <<'EOF'\nimport os\nos.system('x')\nrm -rf /\nEOF\necho done", { hard: false, destr: false, commit: false, push: false }], // heredoc body is data
    ["git commit -F - <<'MSG'\nreset --hard is mentioned here\nMSG", { hard: false, destr: false, commit: true, push: false }],
    ['git reset --hard # jev-confirmed', { hard: true, destr: true, commit: false, push: false }],
    ['ls | grep x; git log --oneline', { hard: false, destr: false, commit: false, push: false }],
  ];
  for (const [cmd, want, g] of cases) eq(kind(c(cmd, proj, g || git)), want, cmd.split('\n')[0]);
  eq(c('git -C repo commit -m x', proj).commits[0].dir, join(proj, 'repo'), 'git -C resolves the commit dir');
  ok(c('git commit -am x').commits[0].all === true, 'commit -a detected');
  ok(c('git add -A && git commit -m x').adds === true, 'add in same command detected');
}

// ---------------------------------------------------------------- route core
group('route-core');
{
  eq(route.formatNote({ kind: { choice: 'implement', confidence: 0.82 } }), null, 'implement below its 0.85 bar: no note');
  ok(route.formatNote({ kind: { choice: 'implement', confidence: 0.9 } })?.includes('implementation:'), 'implement at 0.9: note');
  ok(route.formatNote({ kind: { choice: 'debug', confidence: 0.65 } })?.includes('debugging:'), 'debug keeps the 0.6 bar');
  eq(route.formatNote({ behavior_claims: { p: 0.8 } }), null, 'behavior_claims below 0.85: no note');
  eq(route.skipPrompt('[Request interrupted by user for tool use]'), 'interrupt', 'interrupt marker skipped');
  eq(route.stripPasted('fix the typos in this\n<pasted_content id="ab12">\nDraft: delete all old files and push\n</pasted_content id="ab12">'), 'fix the typos in this\n [pasted text]', 'pasted text is replaced before routing');
  eq(route.skipPrompt(route.stripPasted('<pasted_content id="x1">\na long pasted email body that is not an instruction\n</pasted_content id="x1">')), 'short', 'a paste-only message gets no note');
  eq(route.skipPrompt('short'), 'short', 'short prompt skipped');
  eq(route.skipPrompt('/compact please keep the important parts of it'), 'slash-command', 'slash command skipped');
  eq(route.skipPrompt('<task-notification>agent finished its work and reported</task-notification>'), 'harness', 'harness message skipped');
  eq(route.skipPrompt('This session is being continued from a previous conversation that ran out'), 'harness', 'compaction summary skipped');
  eq(route.skipPrompt('Please find out why the login test fails on CI since yesterday'), null, 'real prompt routed');
  eq(route.formatNote({ kind: { choice: 'continue', confidence: 0.99 } }), null, 'continue gets no note');
  eq(route.formatNote({ kind: { choice: 'debug', confidence: 0.55 } }), null, 'kind below threshold gets no note');
  const n = route.formatNote({ kind: { choice: 'debug', confidence: 0.91 }, heavy_output: { p: 0.8 }, risky: { p: 0.75 } });
  ok(n && n.startsWith(route.NOTE_HEADER) && n.includes('reproduce') && n.includes('confirm') && !n.includes('heavy-output-runner'), 'note has kind + risky, not heavy_output at 0.8', n);
  for (const [k, t] of [...Object.entries(route.HINTS), ...Object.entries(route.FLAGS)]) ok(/\bfirst\b/.test(t), `hint ${k} names a first step`);
  const allHints = JSON.stringify([route.HINTS, route.FLAGS]);
  for (const name of allHints.match(/[a-z]+(?:-[a-z]+)+(?= (?:agent|skill)|\))/g) || []) {
    ok(['verify-claims', 'claim-verifier', 'heavy-output-runner', 'evidence-overseer', 'project-explorer', 'step-runner'].includes(name), 'hint references only shipped agents/skills: ' + name);
  }
  // opt-out marker files
  const p1 = join(TMP, 'optout-agents'); mkdirSync(join(p1, '.agents'), { recursive: true }); writeFileSync(join(p1, '.agents', 'jev-off'), '');
  const p2 = join(TMP, 'optout-claude'); mkdirSync(join(p2, '.claude'), { recursive: true }); writeFileSync(join(p2, '.claude', 'jev-off'), '');
  ok(lib.optedOut(p1) && lib.optedOut(p2) && !lib.optedOut(TMP), '.agents/jev-off and .claude/jev-off opt out');
  eq((await route.routeNote({ prompt: 'Please find out why the login test fails on CI since yesterday', cwd: p1 })).skipped, 'opted-out', 'routeNote honours opt-out');
  process.env.JEV_TEST_ANSWERS = JSON.stringify({ kind: { choice: 'research', confidence: 0.8 } });
  const r = await route.routeNote({ prompt: 'What changed in the newest release of the build tool?', cwd: TMP });
  ok(r.note && r.note.includes('primary source'), 'routeNote builds a note from answers', JSON.stringify(r));
  delete process.env.JEV_TEST_ANSWERS;
  eq((await route.routeNote({ prompt: 'What changed in the newest release of the build tool?', cwd: TMP })).note, null, 'offline/no answer -> no note');
  // headless detection
  ok(route.isClaudeHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }) && route.isClaudeHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), 'sdk-* is headless');
  ok(!route.isClaudeHeadless({ CLAUDE_CODE_ENTRYPOINT: 'cli' }) && !route.isClaudeHeadless({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }) && !route.isClaudeHeadless({}), 'interactive entrypoints are not headless');
  ok(!route.isClaudeHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', JEV_ROUTE_HEADLESS: '1' }), 'JEV_ROUTE_HEADLESS=1 overrides');
  // transcripts
  const claudeT = join(TMP, 'claude.jsonl');
  writeFileSync(claudeT, [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Earlier reply' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'Shall I apply the fix? key sk-' + 'q'.repeat(24) }] } }),
  ].join('\n') + '\n');
  const prev = route.lastAssistantText(claudeT);
  ok(prev.startsWith('Shall I apply the fix?') && prev.includes('[REDACTED_KEY]'), 'Claude transcript: last assistant text, redacted', prev);
  const codexLines = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex answer here' }] } }),
  ].join('\n') + '\n';
  const codexT = join(TMP, 'rollout.jsonl'); writeFileSync(codexT, codexLines);
  eq(route.lastAssistantText(codexT), 'Codex answer here', 'Codex rollout: last assistant text');
  if (typeof zlib.zstdCompressSync === 'function') {
    const z = join(TMP, 'rollout.jsonl.zst'); writeFileSync(z, zlib.zstdCompressSync(Buffer.from(codexLines)));
    eq(route.lastAssistantText(z), 'Codex answer here', 'Codex rollout .zst');
  } else ok(route.lastAssistantText(join(TMP, 'none.jsonl.zst')) === '', 'no zstd in this Node: .zst yields empty');
  eq(route.lastAssistantText(join(TMP, 'missing.jsonl')), '', 'missing transcript -> empty');
}

// ---------------------------------------------------------------- gate core
group('gate-core');
{
  const repo = join(TMP, 'repo');
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  // No commit in the fixture (a global commit-signing setup would block it): staged changes in a fresh repo suffice.
  g('init', '-q'); writeFileSync(join(repo, 'a.txt'), 'two\n'); g('add', '.');

  const hard = await gate.gateDecision({ command: 'git reset --hard', cwd: repo });
  ok(hard.decision === 'ask' && hard.level === 'hard' && hard.reason.includes('high-impact'), 'hard list asks without Jev', JSON.stringify(hard));
  eq((await gate.gateDecision({ command: 'git status', cwd: repo })).decision, null, 'benign command: no decision');
  eq((await gate.gateDecision({ command: 'git commit -m x', cwd: repo })).decision, null, 'commit offline: fail open');
  eq((await gate.gateDecision({ command: 'git commit -m x', cwd: repo, hardOnly: true })).decision, null, 'hardOnly skips Jev');
  process.env.JEV_TEST_ANSWERS = JSON.stringify({ secrets_or_auth: { p: 0.9 }, destructive: { p: 0.1 }, severity: { score: 1 } });
  eq((await gate.gateDecision({ command: 'git commit -m x', cwd: repo })).decision, null, 'secrets flag without secret-like content: no ask');
  writeFileSync(join(repo, 'conf.txt'), 'api_key = ' + 'abcd1234efgh5678ijkl\n'); g('add', 'conf.txt');
  const risk = await gate.gateDecision({ command: 'git commit -m x', cwd: repo });
  ok(risk.decision === 'ask' && risk.level === 'risk' && risk.reason.includes('secrets/auth'), 'risk over threshold asks (secret-like value staged)', JSON.stringify(risk));
  g('rm', '-q', '--cached', 'conf.txt');
  ok(gate.secretEvidence({ diff_stat: ' .env.local | 2 +' }) && gate.secretEvidence({ untracked_files: 'keys/server.pem' }) && !gate.secretEvidence({ diff_stat: ' src/main.js | 3 +' }), 'secret-like file names count as evidence');
  { const t = join(tmpdir(), 'jev-scratch-x');
    eq(gate.classify(`rm -rf ${t}`, repo).destructive.length, 0, 'rm -r inside the temp folder is not gated');
    eq(gate.classify('rm -rf $TMP/x', repo).destructive.length, 1, 'rm -r with a variable target stays gated');
    eq(gate.classify(`rm -rf ${t} ${process.platform === 'win32' ? 'D:/data' : '/srv/data'}`, repo).destructive.length, 1, 'rm -r with any target outside temp stays gated'); }
  process.env.JEV_TEST_ANSWERS = JSON.stringify({ secrets_or_auth: { p: 0.79 }, destructive: { p: 0.59 }, severity: { score: 2.74 } });
  eq((await gate.gateDecision({ command: 'git commit -m x', cwd: repo })).decision, null, 'just below thresholds: no ask');
  delete process.env.JEV_TEST_ANSWERS;
  const id = 'toolu_' + Date.now();
  ok((await gate.gateDecision({ command: 'git reset --hard', cwd: repo, toolUseId: id })).decision === 'ask', 'first run for a tool call');
  eq((await gate.gateDecision({ command: 'git reset --hard', cwd: repo, toolUseId: id })).decision, null, 'second hook for the same tool call is silent');
  ok((await gate.gateDecision({ command: 'git reset --hard HEAD~1', cwd: repo, toolUseId: id })).decision === 'ask', 'reused call id with another command still gates');
  { const { utimesSync, readdirSync: rd } = await import('node:fs'); const d = join(process.env.JEV_LOG_DIR, 'gate-once'); const old = new Date(Date.now() - 600e3); for (const f of rd(d)) utimesSync(join(d, f), old, old); }
  ok((await gate.gateDecision({ command: 'git reset --hard', cwd: repo, toolUseId: id })).decision === 'ask', 'reused call id after the window still gates (Kimi reuses ids across sessions)');
  process.env.JEV_HOOK = '0';
  eq((await gate.gateDecision({ command: 'git reset --hard', cwd: repo })).decision, null, 'JEV_HOOK=0 disables the gate');
  delete process.env.JEV_HOOK;
  ok(gate.hasConfirmMarker('git reset --hard # jev-confirmed') && !gate.hasConfirmMarker('git reset --hard'), 'confirm marker detection');
  eq(gate.shellCommandText(['bash', '-lc', 'git status']), 'git status', 'argv bash -lc unwrapped');
  eq(gate.shellCommandText(['pwsh', '-Command', 'git status']), 'git status', 'argv pwsh -Command unwrapped');
  eq(gate.shellCommandText('git status'), 'git status', 'string command kept');
}

// ---------------------------------------------------------------- codex rules
group('codex-rules');
{
  const rules = readFileSync(join(COMP, 'codex', 'jev-guard.rules'), 'utf8');
  const parsed = [];
  for (const m of rules.matchAll(/pattern\s*=\s*(\[.*\]),\s*$/gm)) {
    const pat = JSON.parse(m[1]);
    const expand = (i) => (i === pat.length ? [[]] : (Array.isArray(pat[i]) ? pat[i] : [pat[i]]).flatMap(x => expand(i + 1).map(r => [x, ...r])));
    parsed.push(...expand(0));
  }
  const key = (a) => a.join(' ');
  eq(parsed.map(key).sort(), gate.CODEX_RULE_PREFIXES.map(key).sort(), 'rules file and CODEX_RULE_PREFIXES agree');
  const f = (cmd) => gate.classify(cmd, TMP, () => 'main').hard;
  ok(gate.coveredByCodexRules('git reset --hard', f('git reset --hard'), 'linux'), 'plain git reset --hard covered on linux');
  ok(!gate.coveredByCodexRules('git -C x reset --hard', f('git -C x reset --hard'), 'linux'), 'git -C form not covered');
  ok(!gate.coveredByCodexRules('git push origin main --force', f('git push origin main --force'), 'linux'), 'flag after refspec not covered');
  ok(!gate.coveredByCodexRules('cd x && git reset --hard', f('cd x && git reset --hard'), 'linux'), 'chain not covered');
  ok(!gate.coveredByCodexRules('git reset --hard', f('git reset --hard'), 'win32'), 'nothing covered on win32');
  const codex = spawnSync('codex --version', { encoding: 'utf8', shell: true });
  if (codex.status === 0) {
    const check = (...cmd) => JSON.parse(spawnSync('codex', ['execpolicy', 'check', '--rules', join(COMP, 'codex', 'jev-guard.rules'), '--', ...cmd], { encoding: 'utf8' }).stdout || '{}').decision;
    eq(check('git', 'reset', '--hard'), 'prompt', 'codex execpolicy: reset --hard prompts');
    eq(check('git', 'push', '-f', 'origin', 'main'), 'prompt', 'codex execpolicy: push -f prompts');
    eq(check('rm', '-f', 'x'), undefined, 'codex execpolicy: rm -f does not match');
  } else console.log('  (codex not installed: skipped execpolicy checks)');
  const hooks = JSON.parse(readFileSync(join(COMP, 'codex', 'hooks.json.tmpl'), 'utf8'));
  ok(hooks.hooks.UserPromptSubmit[0].hooks[0].command.includes('codex-route.mjs') && hooks.hooks.PreToolUse[0].matcher === 'Bash', 'hooks.json shape');
  // Codex runs hook commands with `pwsh -NoProfile -Command` on Windows, where a leading quoted path is a string, not a call.
  ok([hooks.hooks.UserPromptSubmit[0].hooks[0], hooks.hooks.PreToolUse[0].hooks[0]].every((h) => /^& '\{NODE\}' '\{JEV_HOME\}\/codex-(route|gate)\.mjs'$/.test(h.commandWindows || '')), 'hooks.json: PowerShell-safe commandWindows');
}

// ---------------------------------------------------------------- key + log
group('lib');
{
  const xdg = join(TMP, 'xdg'); mkdirSync(join(xdg, 'jev'), { recursive: true });
  const keyFile = join(xdg, 'jev', 'key');
  writeFileSync(keyFile, '  test-key-not-real\n');
  if (process.platform !== 'win32') chmodSync(keyFile, 0o644);
  const probe = `import { apiKey } from ${JSON.stringify(pathToFileURL(join(TOOL, 'lib.mjs')).href)}; const k = apiKey(); console.log(k === 'test-key-not-real' ? 'FILE' : k ? 'OTHER' : 'NONE');`;
  const env = { ...process.env, XDG_CONFIG_HOME: xdg }; delete env.OPENROUTER_API_KEY;
  const r1 = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { env, encoding: 'utf8' });
  eq(r1.stdout.trim(), 'FILE', 'key file used when env is unset (trimmed)');
  if (process.platform !== 'win32') ok(/readable by group\/others/.test(r1.stderr), 'POSIX warns on group/world-readable key file', r1.stderr);
  if (process.platform !== 'win32') {
    chmodSync(keyFile, 0o600);
    const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { env, encoding: 'utf8' });
    ok(!r2.stderr.includes('readable'), 'no warning at 600');
  }
  const r3 = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...env, OPENROUTER_API_KEY: 'from-env' }, encoding: 'utf8' });
  eq(r3.stdout.trim(), 'OTHER', 'env var wins over key file');
  ok(lib.keyFilePath().replace(/\\/g, '/').endsWith('/jev/key'), 'keyFilePath ends with jev/key');
  // rotation
  mkdirSync(process.env.JEV_LOG_DIR, { recursive: true });
  const logFile = join(process.env.JEV_LOG_DIR, 'decisions.jsonl');
  writeFileSync(logFile, 'x'.repeat(5 * 1024 * 1024 + 10));
  lib.log({ label: 'eval:port-rotation-test' });
  ok(statSync(join(process.env.JEV_LOG_DIR, 'decisions.1.jsonl')).size > 5 * 1024 * 1024 && statSync(logFile).size < 1000, 'log rotates past 5 MB');
  lib.log({ label: 'eval:port-rotation-test' });
  ok(statSync(logFile).size < 1000 && existsSync(join(process.env.JEV_LOG_DIR, 'decisions.1.jsonl')), 'small log is appended, not rotated');
}

// ---------------------------------------------------------------- adapters (child processes)
group('adapters');
{
  const run = (script, input, extra = {}) => {
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const r = spawnSync(process.execPath, [join(TOOL, script)], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 20000 });
    return { out: r.stdout, err: r.stderr, code: r.status };
  };
  const answers = JSON.stringify({ kind: { choice: 'debug', confidence: 0.9 }, behavior_claims: { p: 0.8 } });
  const prompt = 'The build fails on CI with a linker error since the last merge, why?';
  // Claude route hook
  let r = run('route-hook.mjs', { prompt, cwd: TMP, transcript_path: join(TMP, 'claude.jsonl') }, { JEV_TEST_ANSWERS: answers });
  let j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok(j?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit' && j.hookSpecificOutput.additionalContext.startsWith(route.NOTE_HEADER), 'claude route: additionalContext JSON', r.out + r.err);
  ok(Object.keys(j || {}).join() === 'hookSpecificOutput' && Object.keys(j.hookSpecificOutput).join() === 'hookEventName,additionalContext', 'claude route: same output keys as before');
  eq(run('route-hook.mjs', { prompt, cwd: TMP, agent_id: 'a1' }, { JEV_TEST_ANSWERS: answers }).out, '', 'claude route: subagent prompt skipped');
  eq(run('route-hook.mjs', { prompt, cwd: TMP }, { JEV_TEST_ANSWERS: answers, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }).out, '', 'claude route: headless skipped');
  ok(run('route-hook.mjs', { prompt, cwd: TMP }, { JEV_TEST_ANSWERS: answers, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', JEV_ROUTE_HEADLESS: '1' }).out.includes('additionalContext'), 'claude route: JEV_ROUTE_HEADLESS=1 routes headless');
  eq(run('route-hook.mjs', { prompt, cwd: TMP }, { JEV_TEST_ANSWERS: answers, JEV_HOOK: '0' }).out, '', 'claude route: JEV_HOOK=0');
  eq(run('route-hook.mjs', 'not json').out, '', 'claude route: bad stdin fails open');
  // Claude gate hook
  r = run('gate-hook.mjs', { tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd: TMP, tool_use_id: 'c1-' + Date.now() });
  j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok(j?.hookSpecificOutput?.permissionDecision === 'ask' && j.hookSpecificOutput.hookEventName === 'PreToolUse' && /do not retry/.test(j.hookSpecificOutput.additionalContext), 'claude gate: ask JSON', r.out + r.err);
  eq(Object.keys(j?.hookSpecificOutput || {}), ['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'additionalContext'], 'claude gate: same output keys as before');
  eq(run('gate-hook.mjs', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: TMP }).out, '', 'claude gate: benign silent');
  r = run('gate-hook.mjs', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: join(TMP, 'repo') }, { JEV_TEST_ANSWERS: JSON.stringify({ destructive: { p: 0.9 } }) });
  ok(r.out.includes('"ask"') && r.out.includes('destructive (p=0.9)'), 'claude gate: Jev risk asks', r.out);
  // Codex route hook
  r = run('codex-route.mjs', { hook_event_name: 'UserPromptSubmit', prompt, cwd: TMP, transcript_path: join(TMP, 'rollout.jsonl'), session_id: 's', turn_id: 't' }, { JEV_TEST_ANSWERS: answers });
  ok(r.out.startsWith(route.NOTE_HEADER) && !r.out.trim().startsWith('{') && r.out.length < 2500, 'codex route: plain-text developer context', r.out + r.err);
  eq(run('codex-route.mjs', { prompt: 'ok thanks', cwd: TMP }, { JEV_TEST_ANSWERS: answers }).out, '', 'codex route: short prompt silent');
  // Codex gate hook
  const cg = (command, extra) => run('codex-gate.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: TMP, tool_use_id: 'x' + Math.random() }, extra);
  r = cg('git -C . reset --hard');
  j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok(j?.hookSpecificOutput?.permissionDecision === 'deny' && j.hookSpecificOutput.permissionDecisionReason.includes('# jev-confirmed'), 'codex gate: uncovered hard form denied with marker hint', r.out + r.err);
  ok(!JSON.stringify(j || {}).includes('"ask"'), 'codex gate: never emits ask');
  r = cg('git reset --hard');
  if (process.platform === 'win32') ok(r.out.includes('"deny"'), 'codex gate (win32): plain hard command denied (rules not assumed to cover PowerShell)');
  else eq(r.out, '', 'codex gate (posix): plain hard command left to the execpolicy rule');
  eq(cg('git -C . reset --hard # jev-confirmed').out, '', 'codex gate: confirm marker passes');
  eq(cg('git commit -m x', { JEV_TEST_ANSWERS: JSON.stringify({ destructive: { p: 0.9 } }) }).out, '', 'codex gate: Jev risk off by default');
  ok(cg('git commit -m x', { JEV_TEST_ANSWERS: JSON.stringify({ destructive: { p: 0.9 } }), JEV_CODEX_RISK: '1' }).out.includes('"deny"'), 'codex gate: JEV_CODEX_RISK=1 denies on risk');
  r = run('codex-gate.mjs', { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'cd . && git reset --hard'] }, cwd: TMP });
  ok(r.out.includes('"deny"'), 'codex gate: argv command form handled');
}

// ---------------------------------------------------------------- opencode plugin
group('opencode');
{
  const dir = join(TMP, 'opencode', 'plugins'); mkdirSync(dir, { recursive: true });
  const tmpl = readFileSync(join(COMP, 'opencode', 'jev.js.tmpl'), 'utf8');
  ok(!/\{(HOME|AGENTS_HOME|CLAUDE_HOME|CODEX_HOME|OPENCODE_HOME|GEMINI_HOME|OS)\}/.test(tmpl), 'template uses only {JEV_HOME} and {NODE}');
  const file = join(dir, 'jev.js');
  writeFileSync(file, tmpl.replace(/\{JEV_HOME\}/g, TOOL.replace(/\\/g, '/')).replace(/\{NODE\}/g, process.execPath.replace(/\\/g, '/')));
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
  eq(Object.keys(mod), ['JevPlugin'], 'plugin module exports only the plugin function');
  const hooks = await mod.JevPlugin({ directory: join(TMP, 'repo'), worktree: join(TMP, 'repo'), project: {}, client: {}, $: null });
  for (const k of ['chat.message', 'experimental.chat.system.transform', 'experimental.text.complete', 'tool.execute.before']) ok(typeof hooks[k] === 'function', 'hook ' + k);
  process.env.JEV_TEST_ANSWERS = JSON.stringify({ kind: { choice: 'review', confidence: 0.85 } });
  await hooks['experimental.text.complete']({ sessionID: 's1', messageID: 'm0', partID: 'p0' }, { text: 'Previous answer' });
  await hooks['chat.message']({ sessionID: 's1' }, { message: {}, parts: [{ type: 'text', text: 'Please review the changes in src/auth before I merge them today' }, { type: 'text', text: 'ignored', synthetic: true }] });
  delete process.env.JEV_TEST_ANSWERS;
  const sys = { system: ['header', 'rest'] };
  await hooks['experimental.chat.system.transform']({ sessionID: 's1', model: {} }, sys);
  ok(sys.system.length === 3 && sys.system[2].startsWith(route.NOTE_HEADER) && sys.system[2].includes('review'), 'routing note appended to system', JSON.stringify(sys));
  const other = { system: ['header'] };
  await hooks['experimental.chat.system.transform']({ sessionID: 's2', model: {} }, other);
  eq(other.system.length, 1, 'other session untouched');
  await hooks['chat.message']({ sessionID: 's1' }, { message: {}, parts: [{ type: 'text', text: 'ok' }] });
  const sys2 = { system: ['h'] };
  await hooks['experimental.chat.system.transform']({ sessionID: 's1', model: {} }, sys2);
  eq(sys2.system.length, 1, 'note cleared on the next user message');
  const before = async (tool, args) => { try { await hooks['tool.execute.before']({ tool, sessionID: 's1', callID: 'c' + Math.random() }, { args }); return null; } catch (e) { return e.message; } };
  const msg = await before('bash', { command: 'git reset --hard', description: 'x' });
  ok(msg && msg.includes('high-impact') && msg.includes('# jev-confirmed'), 'hard command throws with marker hint', String(msg));
  eq(await before('bash', { command: 'git reset --hard # jev-confirmed' }), null, 'marker passes');
  eq(await before('bash', { command: 'ls' }), null, 'benign passes');
  eq(await before('read', { filePath: 'x' }), null, 'non-bash tool ignored');
  process.env.JEV_TEST_ANSWERS = JSON.stringify({ severity: { score: 2.9 } });
  const riskMsg = await before('bash', { command: 'git commit -m x', workdir: '.' });
  delete process.env.JEV_TEST_ANSWERS;
  ok(riskMsg && riskMsg.includes('risk severity 2.9/3'), 'Jev risk throws', String(riskMsg));
  eq(await before('bash', { command: 'git commit -m x' }), null, 'commit offline passes (fail open)');
  process.env.JEV_HOME = join(TMP, 'nowhere');
  const empty = await mod.JevPlugin({ directory: TMP });
  delete process.env.JEV_HOME;
  eq(Object.keys(empty).length, 0, 'missing tool folder: no hooks (fail open)');

  // Under Bun lib.decide() hands the call to decide-cli.mjs in Node; check the child side here.
  const cli = (input, env = {}) => {
    const r = spawnSync(process.execPath, [join(TOOL, 'decide-cli.mjs')], { input, encoding: 'utf8', env: { ...process.env, ...env } });
    try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout, err: r.stderr }; }
  };
  const fake = { kind: { choice: 'explain', confidence: 1 } };
  const viaCli = cli(JSON.stringify({ args: { state: 'x', questions: {} }, opts: { label: 'test', timeout: 1000, retries: 0, deadline: null } }), { JEV_TEST_ANSWERS: JSON.stringify(fake), JEV_IN_CHILD: '1' });
  ok(viaCli.ok === true && viaCli.answers?.kind?.choice === 'explain', 'decide-cli returns decide() result as JSON', JSON.stringify(viaCli));
  const badCli = cli('not json', { JEV_IN_CHILD: '1' });
  ok(badCli.ok === false && /decide-cli/.test(badCli.error?.message), 'decide-cli: bad input gives an error result, not a crash', JSON.stringify(badCli));
}

// ---------------------------------------------------------------- manifests
group('manifest');
{
  const c = JSON.parse(readFileSync(join(COMP, 'component.json'), 'utf8'));
  ok(c.id === 'jev' && c.group === 'extras' && c.default === false && c.requiresBinaries.includes('node'), 'component.json header');
  for (const a of c.actions) if (a.from) ok(existsSync(join(COMP, a.from)), 'action source exists: ' + a.from);
  for (const f of ['claude/settings.hooks.json.tmpl', 'claude/settings.hooks.win32.json.tmpl', 'codex/hooks.json.tmpl']) JSON.parse(readFileSync(join(COMP, f), 'utf8'));
  ok(true, 'json fragments parse');
  const all = [JSON.stringify(c), ...readdirSync(TOOL).filter(f => /\.(mjs|json)$/.test(f)).map(f => readFileSync(join(TOOL, f), 'utf8'))].join('\n');
  ok(!/co-authored-by|generated with|noreply@anthropic/i.test(all), 'no AI attribution');
}

// ---------------------------------------------------------------- live
if (LIVE) {
  group('live');
  delete process.env.JEV_OFFLINE;
  if (!lib.apiKey()) { console.log('  --live: no API key found; skipped'); }
  else {
    const prompts = [
      ['Why does the login test fail on CI since yesterday? It passes locally.', 'debug'],
      ['What are the newest features in the latest release of Node.js?', null],
    ];
    for (const [i, [p]] of prompts.entries()) {
      const r = await route.routeNote({ prompt: p, cwd: TMP, label: `eval:port-route-${i}`, deadline: Date.now() + 15000, timeout: 12000 });
      ok(r.result?.ok === true, 'live route call ok: ' + p.slice(0, 40), JSON.stringify(r.result?.error || {}));
      console.log(`  live route ${i}: model=${r.result?.model} ms=${r.result?.ms} kind=${JSON.stringify(r.result?.answers?.kind?.choice)}@${r.result?.answers?.kind?.confidence} note=${r.note ? r.note.split('\n').length - 1 + ' line(s)' : 'none'}`);
    }
    const g = await gate.gateDecision({ command: 'git commit -m "update readme"', cwd: join(TMP, 'repo'), label: 'eval:port-gate', deadline: Date.now() + 15000 });
    console.log(`  live gate: decision=${g.decision} level=${g.level}`);
    ok(g.decision === null, 'live gate: harmless commit not flagged');
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`node ${process.version} ${process.platform}: ` + Object.entries(sections).map(([k, v]) => `${k} ${v.pass}/${v.pass + v.fail}`).join(', '));
console.log(fail ? `FAILED ${fail} of ${pass + fail}` : `OK ${pass} checks`);
process.exitCode = fail ? 1 : 0;
