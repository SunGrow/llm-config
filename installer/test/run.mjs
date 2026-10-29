#!/usr/bin/env node
// Self-contained tests for installer/install.mjs. Usage: node installer/test/run.mjs
// Builds fixture components and a fake home under installer/test/tmp/ and runs the installer against them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(HERE, '..', 'install.mjs');
const TMP = path.join(HERE, 'tmp', `run-${process.platform}-${process.pid}`);
const PLAT = process.platform;
const OTHER = PLAT === 'win32' ? 'linux' : 'win32';
const fwd = (p) => p.replace(/\\/g, '/');

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`ok - ${name}`); console.log(`ok - ${name}`); }
  catch (e) { failed++; results.push(`not ok - ${name}`); console.log(`not ok - ${name}\n    ${String(e && e.message || e).split('\n').join('\n    ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`); }

function write(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[r + '/'] = 'dir'; walk(path.join(d, e.name), r); }
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}
function diffSnap(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}
function run(root, home, args, env = {}) {
  const r = spawnSync(process.execPath, [INSTALLER, '--root', root, '--home', home, '--no-color', ...args], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ------------------------------------------------------------------ fixtures
fs.rmSync(TMP, { recursive: true, force: true });
const ROOT = path.join(TMP, 'root');
const C = (id, rel) => path.join(ROOT, 'components', id, rel);
const L = (id, rel) => path.join(ROOT, 'local', 'components', id, rel);

write(C('base1', 'component.json'), JSON.stringify({
  id: 'base1', title: 'Base one', description: 'Fixture base', group: 'base', default: true,
  postInstall: 'base1 post-install note',
  actions: [
    { type: 'copy', from: 'files/', to: '{AGENTS_HOME}/base1' },
    { type: 'copy', from: 'single.txt.tmpl', to: '{AGENTS_HOME}/single/' },
    { type: 'block', from: 'block.md', to: '{CLAUDE_HOME}/CLAUDE.md' },
    { type: 'block', from: 'block.toml.tmpl', to: '{CODEX_HOME}/config.toml' },
    { type: 'json-merge', from: 'settings.json.tmpl', to: '{CLAUDE_HOME}/settings.json' },
    { type: 'json-merge', from: 'new.json', to: '{GEMINI_HOME}/settings.json' },
    { type: 'chmod', to: '{AGENTS_HOME}/base1/run.sh', mode: '755', platforms: ['linux', 'darwin'] },
    { type: 'copy', from: 'never.txt', to: '{AGENTS_HOME}/never.txt', platforms: [OTHER] },
    { type: 'copy', from: 'when.txt', to: '{AGENTS_HOME}/when.txt', when: 'tool1' },
    { type: 'copy', from: 'when.txt', to: '{AGENTS_HOME}/whenboth.txt', when: ['tool1', 'extra1'] },
  ],
}, null, 2));
write(C('base1', 'files/a.md'), 'A from component\n');
write(C('base1', 'files/b.md.tmpl'), 'home={HOME}\nnode={NODE}\nos={OS}\nagents={AGENTS_HOME}\nunknown={NOT_A_VAR}\n');
write(C('base1', 'files/sub/c.txt'), 'C\n');
write(C('base1', 'files/run.sh'), '#!/bin/sh\necho hi\n');
write(C('base1', 'files/node_modules/skip.txt'), 'should be skipped\n');
write(C('base1', 'single.txt.tmpl'), 'claude={CLAUDE_HOME}\n');
write(C('base1', 'block.md'), '## Base1 block\nline two\n');
write(C('base1', 'block.toml.tmpl'), '[llm]\nhome = "{HOME}"\n');
write(C('base1', 'settings.json.tmpl'), JSON.stringify({
  model: 'from-component',
  env: { LLM_HOME: '{HOME}' },
  permissions: { allow: ['Read', 'Bash(git status)'] },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'user.sh' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: '{NODE} {AGENTS_HOME}/gate.mjs' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }],
  },
}, null, 2));
write(C('base1', 'new.json'), JSON.stringify({ general: { a: 1 } }));
write(C('base1', 'never.txt'), 'never\n');
write(C('base1', 'when.txt'), 'when\n');

write(C('tool1', 'component.json'), JSON.stringify({
  id: 'tool1', title: 'Tool one', description: 'Fixture tool', group: 'tools', requires: ['base1'],
  default: 'detect', detect: { paths: ['{HOME}/.tool1marker'], commands: ['definitely-not-a-command-xyz'] },
  actions: [{ type: 'block', from: 'tool.md', to: '{CLAUDE_HOME}/CLAUDE.md' }],
}, null, 2));
write(C('tool1', 'tool.md'), '## Tool1 block\n');

write(C('extra1', 'component.json'), JSON.stringify({
  id: 'extra1', title: 'Extra one', group: 'extras', default: true, platforms: [OTHER],
  actions: [{ type: 'copy', from: 'x.txt', to: '{AGENTS_HOME}/extra1.txt' }],
}, null, 2));
write(C('extra1', 'x.txt'), 'x\n');

write(C('needsbin', 'component.json'), JSON.stringify({
  id: 'needsbin', title: 'Needs a binary', group: 'extras', default: true, requiresBinaries: ['definitely-not-a-binary-xyz'],
  actions: [{ type: 'copy', from: 'x.txt', to: '{AGENTS_HOME}/needsbin.txt' }],
}, null, 2));
write(C('needsbin', 'x.txt'), 'x\n');

write(C('broken', 'component.json'), JSON.stringify({
  id: 'broken', title: 'Broken', group: 'extras', default: false,
  actions: [
    { type: 'copy', from: 'missing.txt', to: '{AGENTS_HOME}/missing.txt' },
    { type: 'copy', from: 'ok.txt', to: '{AGENTS_HOME}/broken-ok.txt' },
    { type: 'copy', from: 'ok.txt', to: '/etc/evil.txt' },
  ],
}, null, 2));
write(C('broken', 'ok.txt'), 'ok\n');

// local overlay: extends tool1 and adds a local-only component
write(L('tool1', 'component.json'), JSON.stringify({
  id: 'tool1', actions: [
    { type: 'copy', from: 'local.txt', to: '{AGENTS_HOME}/local.txt' },
    { type: 'block', from: 'local.md', to: '{CLAUDE_HOME}/CLAUDE.md' },
  ],
}, null, 2));
write(L('tool1', 'local.txt'), 'local overlay\n');
write(L('tool1', 'local.md'), 'private local block\n');
write(L('mine', 'component.json'), JSON.stringify({
  id: 'mine', title: 'Mine', group: 'extras', default: false,
  actions: [{ type: 'copy', from: 'm.txt', to: '{HOME}/mine.txt' }],
}, null, 2));
write(L('mine', 'm.txt'), 'mine\n');

// ------------------------------------------------------------------ fake home with user content
const HOME = path.join(TMP, 'home');
const CLAUDE_MD = '# My notes\nkeep this\n';
const SETTINGS = JSON.stringify({
  model: 'user-model',
  permissions: { allow: ['Read'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user.sh' }] }] },
}, null, 2) + '\n';
const TOML = '[a]\nb = 1'; // no trailing newline on purpose
write(path.join(HOME, '.claude', 'CLAUDE.md'), CLAUDE_MD);
write(path.join(HOME, '.claude', 'settings.json'), SETTINGS);
write(path.join(HOME, '.codex', 'config.toml'), TOML);
write(path.join(HOME, '.agents', 'base1', 'a.md'), 'user original a\n');
write(path.join(HOME, '.tool1marker'), '');
const H = (rel) => path.join(HOME, rel);
const HOMEF = fwd(path.resolve(HOME));
const initial = snapshot(HOME);

// ------------------------------------------------------------------ tests
test('--list shows groups, local marks and detection', () => {
  const r = run(ROOT, HOME, ['--list']);
  eq(r.code, 0, r.out);
  assert(/Base/.test(r.out) && /Tools/.test(r.out) && /Extras/.test(r.out), r.out);
  assert(/\+local/.test(r.out), 'tool1 should be marked +local');
  assert(/mine.*local/.test(r.out), 'mine should be marked local');
  assert(/tool1.*detected/.test(r.out), 'tool1 should be detected via marker path');
});

test('non-terminal without --yes refuses', () => {
  const r = run(ROOT, HOME, []);
  eq(r.code, 2, r.out);
});

test('unknown component is a usage error', () => {
  const r = run(ROOT, HOME, ['--yes', '--components', 'nope']);
  eq(r.code, 2, r.out);
});

test('dry run writes nothing and prints diffs', () => {
  const r = run(ROOT, HOME, ['--dry-run', '--yes']);
  eq(r.code, 0, r.out);
  eq(diffSnap(initial, snapshot(HOME)).join(','), '', 'home changed during dry run');
  assert(r.out.includes('--- a/~/.claude/CLAUDE.md') && r.out.includes('+++ b/~/.claude/CLAUDE.md'), 'missing unified diff header');
  assert(/@@ -\d+,\d+ \+\d+,\d+ @@/.test(r.out), 'missing hunk header');
  assert(r.out.includes('+<!-- llm-config:begin base1 -->'), 'missing block in diff');
  assert(r.out.includes('Nothing was written'), r.out);
});

let first;
test('install defaults (--yes): exit 0', () => {
  first = run(ROOT, HOME, ['--yes']);
  eq(first.code, 0, first.out);
  assert(first.out.includes('base1 post-install note'), 'postInstall missing');
  assert(first.out.includes('Open a new session'), 'new-session hint missing');
  assert(/Backups: ~\/\.llm-config\/backups\//.test(first.out), 'backup path missing');
});

test('copy dir + .tmpl expansion + skip node_modules', () => {
  eq(read(H('.agents/base1/a.md')), 'A from component\n');
  assert(!exists(H('.agents/base1/b.md.tmpl')), '.tmpl suffix not dropped');
  const b = read(H('.agents/base1/b.md'));
  assert(b.includes(`home=${HOMEF}\n`), b);
  assert(b.includes(`node=${fwd(process.execPath)}\n`), b);
  assert(b.includes(`os=${PLAT}\n`), b);
  assert(b.includes(`agents=${HOMEF}/.agents\n`), b);
  assert(b.includes('unknown={NOT_A_VAR}'), 'unknown variables must be left alone');
  assert(!b.includes('\\'), 'backslash in expanded paths');
  eq(read(H('.agents/base1/sub/c.txt')), 'C\n');
  assert(!exists(H('.agents/base1/node_modules')), 'node_modules should not be copied');
  eq(read(H('.agents/single/single.txt')), `claude=${HOMEF}/.claude\n`);
});

test('backup of overwritten file under ~/.llm-config/backups/<ts>/', () => {
  const bdir = H('.llm-config/backups');
  const stamps = fs.readdirSync(bdir);
  eq(stamps.length, 1, 'expected one backup folder');
  eq(read(path.join(bdir, stamps[0], '.agents/base1/a.md')), 'user original a\n');
  eq(read(path.join(bdir, stamps[0], '.claude/CLAUDE.md')), CLAUDE_MD);
});

test('blocks inserted, surrounding text preserved, hash markers for .toml', () => {
  const md = read(H('.claude/CLAUDE.md'));
  assert(md.startsWith(CLAUDE_MD), 'user text changed');
  assert(md.includes('<!-- llm-config:begin base1 -->\n## Base1 block\nline two\n<!-- llm-config:end base1 -->'), md);
  assert(md.includes('<!-- llm-config:begin tool1 -->'), 'tool1 block missing');
  assert(md.includes('<!-- llm-config:begin tool1-local -->\nprivate local block\n<!-- llm-config:end tool1-local -->'), 'local overlay block missing');
  assert(md.indexOf('begin base1') < md.indexOf('begin tool1 '), 'required component block should come first');
  const toml = read(H('.codex/config.toml'));
  assert(toml.startsWith('[a]\nb = 1\n'), toml);
  assert(toml.includes(`# llm-config:begin base1\n[llm]\nhome = "${HOMEF}"\n# llm-config:end base1\n`), toml);
});

test('json-merge: user values kept, arrays of hook objects appended once', () => {
  const s = JSON.parse(read(H('.claude/settings.json')));
  eq(s.model, 'user-model', 'existing scalar must not be overridden');
  eq(JSON.stringify(s.permissions.allow), JSON.stringify(['Read', 'Bash(git status)']));
  eq(s.hooks.PreToolUse.length, 2, 'duplicate hook object should not be appended');
  eq(s.hooks.PreToolUse[1].hooks[0].command, `${fwd(process.execPath)} ${HOMEF}/.agents/gate.mjs`);
  eq(s.hooks.Stop.length, 1);
  eq(s.env.LLM_HOME, HOMEF);
  eq(JSON.stringify(JSON.parse(read(H('.gemini/settings.json')))), '{"general":{"a":1}}');
});

test('platforms / when / requiresBinaries filtering and local overlay', () => {
  assert(!exists(H('.agents/never.txt')), 'platform-filtered action ran');
  assert(exists(H('.agents/when.txt')), 'when: tool1 should run (tool1 detected)');
  assert(!exists(H('.agents/whenboth.txt')), 'when: [tool1, extra1] should be skipped');
  assert(!exists(H('.agents/extra1.txt')), 'component for other platform installed');
  assert(!exists(H('.agents/needsbin.txt')), 'component with missing binary installed');
  assert(/needsbin: skipped, missing definitely-not-a-binary-xyz/.test(first.out), 'missing binary warning');
  eq(read(H('.agents/local.txt')), 'local overlay\n');
  assert(!exists(H('mine.txt')), 'non-default local component installed');
  const m = JSON.parse(read(H('.llm-config/manifest.json')));
  eq(Object.keys(m.components).sort().join(','), 'base1,tool1');
});

test('chmod on POSIX', () => {
  if (PLAT === 'win32') return;
  const p = H('.agents/base1/run.sh');
  const probe = path.join(TMP, 'chmod-probe');
  write(probe, ''); fs.chmodSync(probe, 0o600);
  if ((fs.statSync(probe).mode & 0o777) !== 0o600) return; // filesystem ignores modes (e.g. /mnt drvfs)
  eq((fs.statSync(p).mode & 0o777).toString(8), '755');
});

test('second run is idempotent (no changes, no new backup, manifest identical)', () => {
  const before = snapshot(HOME);
  const r = run(ROOT, HOME, ['--yes']);
  eq(r.code, 0, r.out);
  assert(r.out.includes('Nothing to change'), r.out);
  eq(diffSnap(before, snapshot(HOME)).join(','), '', 'second run changed files');
});

test('block replace keeps surrounding text and a single block', () => {
  write(C('base1', 'block.md'), '## Base1 block v2\n');
  fs.appendFileSync(H('.claude/CLAUDE.md'), 'user tail line\n');
  const r = run(ROOT, HOME, ['--yes']);
  eq(r.code, 0, r.out);
  const md = read(H('.claude/CLAUDE.md'));
  assert(md.startsWith(CLAUDE_MD), 'head changed');
  assert(md.endsWith('user tail line\n'), 'tail changed');
  eq(md.split('llm-config:begin base1 ').length - 1, 1, 'block duplicated');
  assert(md.includes('## Base1 block v2\n<!-- llm-config:end base1 -->'), md);
  assert(!md.includes('line two'), 'old block content still present');
  fs.writeFileSync(H('.claude/CLAUDE.md'), md.replace('user tail line\n', ''));
});

test('stale action removed when it disappears from component.json', () => {
  const def = JSON.parse(read(C('base1', 'component.json')));
  def.actions.push({ type: 'copy', from: 'when.txt', to: '{AGENTS_HOME}/temp.txt' });
  write(C('base1', 'component.json'), JSON.stringify(def));
  eq(run(ROOT, HOME, ['--yes']).code, 0);
  assert(exists(H('.agents/temp.txt')), 'temp not installed');
  def.actions.pop();
  write(C('base1', 'component.json'), JSON.stringify(def));
  const r = run(ROOT, HOME, ['--yes']);
  eq(r.code, 0, r.out);
  assert(!exists(H('.agents/temp.txt')), 'stale file not removed');
});

test('partial uninstall removes only that component', () => {
  const r = run(ROOT, HOME, ['--yes', '--uninstall', 'tool1']);
  eq(r.code, 0, r.out);
  const md = read(H('.claude/CLAUDE.md'));
  assert(!md.includes('begin tool1'), 'tool1 blocks still present');
  assert(md.includes('begin base1'), 'base1 block removed');
  assert(!exists(H('.agents/local.txt')), 'local overlay file not removed');
  assert(!exists(H('.agents/when.txt')), 'base1 action conditional on tool1 not removed');
  const m = JSON.parse(read(H('.llm-config/manifest.json')));
  eq(Object.keys(m.components).join(','), 'base1');
  eq(run(ROOT, HOME, ['--yes', '--components', 'tool1']).code, 0, 'reinstall tool1');
  assert(exists(H('.agents/when.txt')), 'when.txt not restored after reinstalling tool1');
});

test('dry-run uninstall writes nothing', () => {
  const before = snapshot(HOME);
  const r = run(ROOT, HOME, ['--yes', '--dry-run', '--uninstall']);
  eq(r.code, 0, r.out);
  eq(diffSnap(before, snapshot(HOME)).join(','), '');
});

test('full uninstall restores originals exactly and keeps user-modified files', () => {
  fs.appendFileSync(H('.agents/base1/sub/c.txt'), 'user edit\n');
  const r = run(ROOT, HOME, ['--yes', '--uninstall']);
  eq(r.code, 0, r.out);
  eq(read(H('.claude/CLAUDE.md')), CLAUDE_MD, 'CLAUDE.md not restored exactly');
  eq(read(H('.claude/settings.json')), SETTINGS, 'settings.json not restored exactly');
  eq(read(H('.codex/config.toml')), TOML, 'config.toml not restored exactly');
  eq(read(H('.agents/base1/a.md')), 'user original a\n', 'original a.md not restored from backup');
  assert(!exists(H('.agents/base1/b.md')), 'installed file not deleted');
  assert(!exists(H('.gemini/settings.json')), 'json file created by install not deleted');
  assert(!exists(H('.gemini')), '.gemini created by install not removed');
  assert(!exists(H('.agents/single')), '.agents/single created by install not removed');
  eq(read(H('.agents/base1/sub/c.txt')), 'C\nuser edit\n', 'modified file must be kept');
  assert(/kept ~\/\.agents\/base1\/sub\/c\.txt: modified since install/.test(r.out), 'missing kept warning');
  const m = JSON.parse(read(H('.llm-config/manifest.json')));
  eq(Object.keys(m.components).length, 0);
});

test('one failing action reports, others still apply, exit 1, nothing outside allowed roots', () => {
  const home2 = path.join(TMP, 'home2');
  fs.mkdirSync(home2, { recursive: true });
  const r = run(ROOT, home2, ['--yes', '--components', 'broken']);
  eq(r.code, 1, r.out);
  assert(/source not found: missing\.txt/.test(r.out), r.out);
  assert(/outside the allowed directories|must start with a variable/.test(r.out), r.out);
  eq(read(path.join(home2, '.agents', 'broken-ok.txt')), 'ok\n');
});

test('--home ignores CLAUDE_CONFIG_DIR from the environment', () => {
  const home3 = path.join(TMP, 'home3');
  fs.mkdirSync(home3, { recursive: true });
  const r = run(ROOT, home3, ['--yes', '--components', 'base1'], { CLAUDE_CONFIG_DIR: path.join(TMP, 'elsewhere') });
  eq(r.code, 0, r.out);
  assert(exists(path.join(home3, '.claude', 'CLAUDE.md')), 'CLAUDE.md not under --home');
  assert(!exists(path.join(TMP, 'elsewhere')), 'env var leaked through --home');
});

test('CRLF files keep CRLF line endings for blocks', () => {
  const home4 = path.join(TMP, 'home4');
  write(path.join(home4, '.claude', 'CLAUDE.md'), 'one\r\ntwo\r\n');
  eq(run(ROOT, home4, ['--yes', '--components', 'base1']).code, 0);
  const md = read(path.join(home4, '.claude', 'CLAUDE.md'));
  assert(!/[^\r]\n/.test(md), 'LF without CR found');
  eq(run(ROOT, home4, ['--yes', '--uninstall']).code, 0);
  eq(read(path.join(home4, '.claude', 'CLAUDE.md')), 'one\r\ntwo\r\n');
});

// ------------------------------------------------------------------ include / unless / onlyIfExists / check / json / budgets
const ROOT2 = path.join(TMP, 'root2');
const C2 = (id, rel) => path.join(ROOT2, 'components', id, rel);
write(C2('shared', 'files/CORE.md'), '# Core\nrule {OS}\n\n');
write(C2('shared', 'component.json'), JSON.stringify({ id: 'shared', group: 'base', default: true, actions: [] }));
write(C2('toola', 'files/A.block.md.tmpl'), 'header\n{{include:../shared/files/CORE.md}}\nfooter\n');
write(C2('toola', 'files/big.md'), 'x'.repeat(17 * 1024) + '\n');
write(C2('toola', 'files/patch.json'), JSON.stringify({ attribution: { commit: false } }));
write(C2('toola', 'component.json'), JSON.stringify({
  id: 'toola', group: 'tools', default: true, requires: ['shared'], actions: [
    { type: 'block', from: 'files/A.block.md.tmpl', to: '{CLAUDE_HOME}/CLAUDE.md' },
    { type: 'copy', from: 'files/patch.json', to: '{HOME}/.toola/only-without-b.json', unless: 'toolb' },
    { type: 'json-merge', from: 'files/patch.json', to: '{CURSOR_CLI_HOME}/cli-config.json', onlyIfExists: true },
    { type: 'copy', from: 'files/big.md', to: '{CODEX_HOME}/AGENTS.md' },
  ],
}));
write(C2('toolb', 'component.json'), JSON.stringify({ id: 'toolb', group: 'tools', default: false, actions: [] }));
write(C2('badinc', 'files/x.md.tmpl'), '{{include:../../../../outside.md}}\n');
write(C2('badinc', 'component.json'), JSON.stringify({ id: 'badinc', group: 'extras', actions: [{ type: 'copy', from: 'files/x.md.tmpl', to: '{HOME}/x.md' }] }));
const home5 = path.join(TMP, 'home5');

test('include expands shared text with variables; no literal directive left', () => {
  eq(run(ROOT2, home5, ['--yes', '--components', 'toola']).code, 0);
  const md = read(path.join(home5, '.claude', 'CLAUDE.md'));
  assert(md.includes(`header\n# Core\nrule ${PLAT}\nfooter`), md);
  assert(!md.includes('{{include'), 'directive left in output');
});
test('unless skips when the listed component is selected, runs otherwise', () => {
  assert(exists(path.join(home5, '.toola', 'only-without-b.json')), 'should exist without toolb');
  const h = path.join(TMP, 'home6');
  eq(run(ROOT2, h, ['--yes', '--components', 'toola,toolb']).code, 0);
  assert(!exists(path.join(h, '.toola', 'only-without-b.json')), 'should be skipped with toolb');
});
test('omits: a selected overlay stops another component copying to a path; the earlier copy is removed', () => {
  const R = path.join(TMP, 'root-omits'), h = path.join(TMP, 'home-omits');
  const comp = (dir, id, def) => write(path.join(R, dir, id, 'component.json'), JSON.stringify({ id, title: id, group: 'base', default: true, ...def }, null, 2));
  comp('components', 'pub', { actions: [{ type: 'copy', from: 'skills/', to: '{CLAUDE_HOME}/skills/' }] });
  write(path.join(R, 'components', 'pub', 'skills', 'keep', 'SKILL.md'), 'keep\n');
  write(path.join(R, 'components', 'pub', 'skills', 'drop', 'SKILL.md'), 'drop\n');
  eq(run(R, h, ['--yes']).code, 0);
  assert(exists(path.join(h, '.claude', 'skills', 'drop', 'SKILL.md')), 'public skill should install without the overlay');
  comp('local/components', 'mine', { requires: ['pub'], omits: ['{CLAUDE_HOME}/skills/drop/'], actions: [] });
  const r = run(R, h, ['--yes']);
  eq(r.code, 0, r.out);
  assert(!exists(path.join(h, '.claude', 'skills', 'drop', 'SKILL.md')), 'omitted skill should be removed');
  eq(read(path.join(h, '.claude', 'skills', 'keep', 'SKILL.md')), 'keep\n');
  eq(run(R, h, ['--yes', '--update']).code, 0);
  assert(!exists(path.join(h, '.claude', 'skills', 'drop', 'SKILL.md')), 'omitted skill should stay removed');
});
test('json-merge onlyIfExists does not create the file, merges when present', () => {
  assert(!exists(path.join(home5, '.cursor', 'cli-config.json')), 'created a file that did not exist');
  write(path.join(home5, '.cursor', 'cli-config.json'), JSON.stringify({ version: 1 }, null, 2));
  eq(run(ROOT2, home5, ['--yes', '--components', 'toola']).code, 0);
  const j = JSON.parse(read(path.join(home5, '.cursor', 'cli-config.json')));
  eq(j.version, 1); eq(j.attribution.commit, false);
});
test('--check exits 0 without drift and 3 with drift; --json prints parseable plan', () => {
  eq(run(ROOT2, home5, ['--check', '--components', 'toola']).code, 0);
  fs.appendFileSync(path.join(home5, '.claude', 'CLAUDE.md'), '');
  write(path.join(home5, '.toola', 'only-without-b.json'), '{"changed":true}');
  const r = run(ROOT2, home5, ['--check', '--json', '--components', 'toola']);
  eq(r.code, 3, r.out);
  const plan = JSON.parse(r.out.slice(r.out.indexOf('{\n')));
  eq(plan.drift, true);
  assert(plan.changes.some((c) => c.path.endsWith('.toola/only-without-b.json')), 'drifted file not listed');
});
test('size budget warns for a Codex AGENTS.md over 16 KiB', () => {
  const r = run(ROOT2, path.join(TMP, 'home7'), ['--dry-run', '--components', 'toola']);
  assert(/AGENTS\.md will be \d+ bytes/.test(r.out), r.out);
});
test('include outside the repository is refused', () => {
  const r = run(ROOT2, path.join(TMP, 'home8'), ['--yes', '--components', 'badinc']);
  eq(r.code, 1, r.out);
  assert(/outside the repository/.test(r.out), r.out);
});

// ------------------------------------------------------------------ json-merge after a template change
test('json-merge: a changed template replaces its old entries, keeps user entries, uninstalls cleanly', () => {
  const root = path.join(TMP, 'root4'), home = path.join(TMP, 'hj1');
  const J = (rel) => path.join(root, 'components', 'jm', rel);
  write(J('component.json'), JSON.stringify({ id: 'jm', title: 'JSON merge', group: 'extras',
    actions: [{ type: 'json-merge', from: 'files/frag.json', to: '{HOME}/.jm/settings.json' }] }));
  write(J('files/frag.json'), JSON.stringify({ hooks: [{ cmd: 'old' }], level: 'v1' }));
  write(path.join(home, '.jm', 'settings.json'), JSON.stringify({ mine: 1 }, null, 2));
  eq(run(root, home, ['--yes', '--components', 'jm']).code, 0);
  const s1 = JSON.parse(read(path.join(home, '.jm', 'settings.json')));
  s1.hooks.push({ cmd: 'user' });
  write(path.join(home, '.jm', 'settings.json'), JSON.stringify(s1, null, 2));
  write(J('files/frag.json'), JSON.stringify({ hooks: [{ cmd: 'new' }], level: 'v2' }));
  const r = run(root, home, ['--yes', '--components', 'jm']);
  eq(r.code, 0, r.out);
  const s2 = JSON.parse(read(path.join(home, '.jm', 'settings.json')));
  eq(JSON.stringify(s2), JSON.stringify({ mine: 1, hooks: [{ cmd: 'user' }, { cmd: 'new' }], level: 'v2' }), 'after template change');
  assert(/Nothing to change/.test(run(root, home, ['--yes', '--components', 'jm']).out), 'second run not idempotent');
  eq(run(root, home, ['--uninstall', '--yes']).code, 0);
  eq(JSON.stringify(JSON.parse(read(path.join(home, '.jm', 'settings.json')))), JSON.stringify({ mine: 1, hooks: [{ cmd: 'user' }] }), 'after uninstall');
});

// ------------------------------------------------------------------ API key prompt
const ROOT3 = path.join(TMP, 'root3');
const K = (id, rel) => path.join(ROOT3, 'components', id, rel);
write(K('keyed', 'component.json'), JSON.stringify({
  id: 'keyed', title: 'Keyed tool', group: 'extras',
  apiKey: { name: 'Test API key', env: 'LLMC_TEST_KEY', configFile: 'keyed/key', prefix: 'tk-' },
  actions: [{ type: 'copy', from: 'files/a.txt', to: '{HOME}/.keyed/a.txt' }],
}));
write(K('keyed', 'files/a.txt'), 'a\n');
write(K('keyuser', 'component.json'), JSON.stringify({
  id: 'keyuser', title: 'Needs keyed', group: 'extras', requires: ['keyed'],
  actions: [{ type: 'copy', from: 'files/b.txt', to: '{HOME}/.keyuser/b.txt' }],
}));
write(K('keyuser', 'files/b.txt'), 'b\n');
const runTTY = (home, args, input) => {
  const r = spawnSync(process.execPath, [INSTALLER, '--root', ROOT3, '--home', home, '--no-color', ...args], {
    encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1', LLM_CONFIG_TTY: '1' },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
test('missing API key with --yes: installs and warns how to add it', () => {
  const home = path.join(TMP, 'hk1');
  const r = run(ROOT3, home, ['--yes', '--components', 'keyed']);
  eq(r.code, 0, r.out);
  assert(/stays inactive until you set LLMC_TEST_KEY/.test(r.out), r.out);
  assert(exists(path.join(home, '.keyed', 'a.txt')), 'component not installed');
  assert(!exists(path.join(home, '.config', 'keyed', 'key')), 'key file must not be created');
});
test('missing API key, choice 3 skips the component and what requires it', () => {
  const home = path.join(TMP, 'hk2');
  const r = runTTY(home, ['--components', 'keyed,keyuser'], '3\n');
  assert(/needs your Test API key/.test(r.out) && /1\) Paste it now/.test(r.out), r.out);
  assert(/not installed \(no Test API key\): keyed, keyuser/.test(r.out), r.out);
  assert(!exists(path.join(home, '.keyed')) && !exists(path.join(home, '.keyuser')), 'skipped components were installed');
});
test('missing API key, paste without a real terminal is refused and asks again', () => {
  const r = runTTY(path.join(TMP, 'hk3'), ['--components', 'keyed'], '1\n3\n');
  assert(/Hidden input needs a real terminal/.test(r.out), r.out);
});
test('API key file present: no prompt; dry run without a key only warns', () => {
  const home = path.join(TMP, 'hk4');
  write(path.join(home, '.config', 'keyed', 'key'), 'tk-present');
  const r = run(ROOT3, home, ['--yes', '--components', 'keyed']);
  eq(r.code, 0, r.out);
  assert(!/Test API key/.test(r.out), r.out);
  const d = run(ROOT3, path.join(TMP, 'hk5'), ['--dry-run', '--components', 'keyed']);
  assert(/no Test API key found .*a real install asks/.test(d.out), d.out);
});

// Text that agents load must read as rules; the evidence behind a rule belongs in code comments, READMEs,
// bench/ notes or commit messages. Flags the usual traces of findings pasted into instructions.
test('agent-facing text states rules, not findings', () => {
  const repo = path.join(HERE, '..', '..');
  const SMELLS = [/\bbench\//, /\b\d+(\.\d+)? ?%/, /\b\d+ of \d+\b/, /\b(measured|observed) (on|in)\b/i,
    /\bon (real|recent) (sessions|prompts|replies|briefs)\b/i, /\b(on|in) \d{1,2}[-.]\d{1,2}(\.\d{1,2})?\b/, /\b20\d\d-\d\d-\d\d\b/];
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'test', 'tool'].includes(e.name)) walk(p); continue; }
    if (/\.(md|tmpl|toml|mdc)$/.test(e.name) && !/^(HOOKS|README)\.md$/.test(e.name)) files.push(p);
  } };
  walk(path.join(repo, 'components'));
  const presets = path.join(repo, 'components', 'jev', 'tool', 'presets.json');
  if (fs.existsSync(presets)) files.push(presets);
  const hits = [];
  for (const f of files) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    const s = SMELLS.find(re => re.test(l));
    if (s) hits.push(`${path.relative(repo, f)}:${i + 1} ${s} :: ${l.trim().slice(0, 100)}`);
  });
  assert(files.length > 20, 'found too few agent-facing files: ' + files.length);
  assert(!hits.length, 'findings-style text in agent-facing files:\n      ' + hits.join('\n      '));
});

console.log(`\n${passed} passed, ${failed} failed (${PLAT}, node ${process.versions.node})`);
if (!failed && !process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
