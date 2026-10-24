// Tool-neutral command gate: before git commit/push and destructive commands, run Jev's diff_risk and report
// whether the user should confirm. A short list of always-dangerous commands ("hard") needs confirmation without
// waiting for Jev. Adapters translate the result: Claude Code asks natively; Codex and opencode cannot ask from a
// pre-tool hook, so they block with a message (see codex-gate.mjs, opencode/jev.js.tmpl).
// Never throws: any failure returns { decision: null } (fail open).
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { runPreset, redact, optedOut, LOG_DIR } from './lib.mjs';

// Picked on 24 real commits (max severity 2.6, destructive 0.27, secrets 0.04)
// vs 5 dangerous commands (severity >= 2.76, destructive >= 0.63 or secrets 0.94).
export const ASK = { secrets_or_auth: 0.8, destructive: 0.6, severity: 2.75 };
const DIFF_CHARS = 20000;

// Explicit confirmation marker for tools without a native "ask" (Codex, opencode): the agent appends it only
// after the user confirmed in chat. A shell comment, so the command itself is unchanged in bash, zsh and PowerShell.
export const CONFIRM_MARKER = '# jev-confirmed';
export const hasConfirmMarker = (command) => /(^|\s)#\s*jev-confirmed\b/.test(String(command || ''));

const mkGit = (deadline) => (cwd, args) => {
  const t = Math.min(3000, deadline - 4000 - Date.now()); // keep >= 4 s for Jev
  if (t < 200) return '';
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: t, maxBuffer: 32 << 20, windowsHide: true }); }
  catch { return ''; }
};
const cut = (s, n) => redact(s).slice(0, n); // redact before cutting

// Heredoc bodies (<<'EOF' ... EOF) are data such as a Python script or a commit message, not commands.
export function stripHeredocs(command) {
  const lines = command.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    for (const m of lines[i].matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== m[2]) i++;
      i++; // the delimiter line
    }
  }
  return out.join('\n');
}

// Split into simple commands on && || ; | and newlines, then into words (quotes respected).
export function segments(command) {
  command = stripHeredocs(command);
  const out = []; let cur = [], word = '', q = null, has = false;
  const push = () => { if (has) cur.push(word); word = ''; has = false; };
  const end = () => { push(); if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) { if (c === q) q = null; else word += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') { end(); continue; }
    if (/\s/.test(c)) { push(); continue; }
    word += c; has = true;
  }
  end();
  return out;
}

// git [global options] <sub> [args]  ->  { dir, sub, args }
function parseGit(words, cwd) {
  let i = 1, dir = cwd;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-C') { dir = resolve(dir, words[i + 1] || '.'); i += 2; }
    else if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') i += 2;
    else i += 1;
  }
  return { dir, sub: words[i] || '', args: words.slice(i + 1) };
}

const isInside = (p, root) => { const r = relative(resolve(root), resolve(p)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const shortFlag = (args, ch) => args.some(a => /^-[A-Za-z]+$/.test(a) && a.includes(ch));
const RM = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const PROTECTED_BRANCH = /^\+?(?:refs\/heads\/)?(main|master|trunk|release.*|prod.*)$/i;
const stripComment = (words) => { const i = words.findIndex(w => w.startsWith('#')); return i < 0 ? words : words.slice(0, i); };

// `git` is used only to resolve the current branch of a no-refspec force-push; pass a stub in tests.
export function classify(command, cwd, git = mkGit(Date.now() + 10000)) {
  const found = { commits: [], pushes: [], destructive: [], hard: [], adds: false };
  let dir = cwd;
  for (const raw of segments(command)) {
    let w = stripComment(raw);
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1); // VAR=x prefix
    const head = (w[0] || '').toLowerCase();
    if ((head === 'cd' || head === 'set-location' || head === 'pushd' || head === 'sl') && w[1]) { dir = resolve(dir, w[w.length - 1]); continue; }
    if (RM.has(head) && !(w[1] || '').startsWith('=')) { // `rd = x` is an assignment in a script, not rd
      const rec = w.slice(1).some(a => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a) || /^--?recurse$|^--recursive$/i.test(a) || /^\/s$/i.test(a));
      if (rec || head === 'rd' || head === 'rmdir') {
        const text = w.join(' ');
        // Every target inside the temp folder (scratch dirs, test homes): not worth a confirmation.
        // On 16-24.10, 17 of 25 rm asks were such paths. Variables, globs and `*` stay gated.
        const targets = w.slice(1).filter(a => !a.startsWith('-') && !/^\/s$|^\/q$/i.test(a));
        if (targets.length && targets.every(a => !/[$*?%~]/.test(a) && isInside(resolve(dir, a), tmpdir()))) continue;
        found.destructive.push(text);
        // Always ask for: this folder's own .git (a nested scaffold's .git goes to Jev), a drive or filesystem
        // root, home, or `*` outside the temp folder.
        const inTemp = isInside(dir, tmpdir());
        if (rec && w.slice(1).some(a => /^(\.[\\/])?\.git[\\/]?$|^[~\/\\]$|^~[\\/]$|^[A-Za-z]:[\\/]?$|^\$HOME$/.test(a) || (a === '*' && !inTemp))) found.hard.push(text);
      }
      continue;
    }
    if (head !== 'git') continue;
    const { dir: gdir, sub, args } = parseGit(w, dir);
    const text = w.join(' ');
    if (sub === 'add') found.adds = true;
    else if (sub === 'commit') found.commits.push({ dir: gdir, all: args.includes('--all') || shortFlag(args, 'a') });
    else if (sub === 'push') {
      const force = args.some(a => /^--force(-with-lease)?(=|$)|^--mirror$|^--delete$/.test(a)) || shortFlag(args, 'f') || shortFlag(args, 'd');
      const refs = args.filter(a => !a.startsWith('-'));
      const plus = refs.slice(1).some(r => r.startsWith('+'));
      found.pushes.push({ dir: gdir, args });
      if (force || plus) {
        found.destructive.push(text);
        // No refspec: the current branch is what gets pushed.
        const targets = refs.length > 1 ? refs.slice(1).map(r => r.split(':').pop()) : [git(gdir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()];
        if (targets.some(r => PROTECTED_BRANCH.test(r))) found.hard.push(text);
      }
    } else if (sub === 'reset' && args.includes('--hard')) { found.destructive.push(text); found.hard.push(text); }
    else if (sub === 'clean' && (args.includes('--force') || shortFlag(args, 'f'))) { found.destructive.push(text); found.hard.push(text); }
    else if (sub === 'branch' && (args.some(a => /^-[A-Za-z]*D/.test(a)) || (args.includes('--delete') && args.includes('--force')))) found.destructive.push(text);
    else if (sub === 'checkout' && (args.includes('--') || args.includes('.') || args.includes('--force') || shortFlag(args, 'f'))) found.destructive.push(text);
    else if (sub === 'restore' && (!args.includes('--staged') || args.includes('--worktree') || shortFlag(args, 'W'))) found.destructive.push(text);
    else if (sub === 'stash' && (args[0] === 'drop' || args[0] === 'clear')) { found.destructive.push(text); if (args[0] === 'clear') found.hard.push(text); }
    else if (sub === 'worktree' && args[0] === 'remove' && (args.includes('--force') || shortFlag(args, 'f'))) found.destructive.push(text);
    else if (sub === 'filter-branch' || sub === 'filter-repo' || (sub === 'update-ref' && args.includes('-d'))) { found.destructive.push(text); found.hard.push(text); }
  }
  return found;
}

// Two hook registrations can match one command (e.g. `git add . && rm -r x`); run the gate once per tool call.
// Both registrations fire within seconds, so a marker only counts for ONCE_WINDOW_MS and only for the same
// command: some models reuse call ids across sessions (Kimi: "functions.bash:0"), which must not skip the gate.
const ONCE_WINDOW_MS = 120e3;
export function firstRunFor(id, command = '') {
  if (!id) return true;
  try {
    const dir = join(LOG_DIR, 'gate-once');
    mkdirSync(dir, { recursive: true });
    try { for (const f of readdirSync(dir)) { const p = join(dir, f); if (Date.now() - statSync(p).mtimeMs > ONCE_WINDOW_MS) unlinkSync(p); } } catch { /* ignore */ }
    const name = String(id).replace(/[^\w-]/g, '_').slice(0, 100) + '_' + createHash('sha256').update(String(command)).digest('hex').slice(0, 12);
    writeFileSync(join(dir, name), '', { flag: 'wx' });
    return true;
  } catch (e) { return e?.code !== 'EEXIST'; }
}

const SECRET_FILE = /(^|[\\/\s])(\.env[\w.-]*|[\w.-]*(secret|credential|passw|token|apikey|api_key|private[_-]?key|auth)[\w.-]*|id_(rsa|ed25519)[\w.-]*|[\w.-]+\.(pem|key|p12|pfx|keystore))(\s|\||$)/im;
export function secretEvidence(state) {
  const diff = String(state.diff || '');
  if (/\[REDACTED/.test(diff) || (diff && redact(diff) !== diff)) return true; // state.diff is already redacted by cut()
  return SECRET_FILE.test([state.diff_stat, state.untracked_files, state.unpushed_stat].filter(Boolean).join('\n'));
}

export const hardReason = (text) => `Jev gate: high-impact command (${text.slice(0, 120)}). Confirm only if this is intended.`;

// Returns { decision: 'ask'|null, level: 'hard'|'risk'|null, reason, found? }.
// 'ask' means "the user should confirm before this runs"; each adapter maps it to its tool's mechanism.
// hardOnly: skip the Jev call (deterministic list only, no network).
export async function gateDecision({ command, cwd, toolUseId, deadline = Date.now() + 10000, hardOnly = false, label } = {}) {
  const none = { decision: null, level: null, reason: null };
  try {
    command = String(command || '');
    cwd = cwd || process.cwd();
    if (!command || optedOut(cwd)) return none;
    const git = mkGit(deadline);
    const f = classify(command, cwd, git);
    if (!f.commits.length && !f.pushes.length && !f.destructive.length) return none;
    if (!firstRunFor(toolUseId, command)) return none;

    // Deterministic floor: these need confirmation even if Jev is unsure or unreachable.
    if (f.hard.length) return { decision: 'ask', level: 'hard', reason: hardReason(f.hard[0]), found: f };
    if (hardOnly) return { ...none, found: f };

    const state = { command };
    if (f.commits.length) {
      // The hook runs before the command, so `git add ... && git commit` or `commit -a` is not staged yet:
      // then show everything tracked that differs from HEAD, plus untracked names an `add` may pick up.
      const c = f.commits[0];
      const wide = c.all || f.adds;
      const range = wide ? ['HEAD'] : ['--cached'];
      state.commit_scope = wide ? 'approximate: all tracked changes vs HEAD (files are added in the same command)' : 'staged changes';
      state.diff_stat = cut(git(c.dir, ['diff', '--stat', ...range]), 4000);
      state.diff = cut(git(c.dir, ['diff', ...range]), DIFF_CHARS);
      if (f.adds) state.untracked_files = cut(git(c.dir, ['ls-files', '--others', '--exclude-standard']), 2000);
    } else if (f.pushes.length) {
      const p = f.pushes[0];
      const hasUpstream = git(p.dir, ['rev-parse', '--abbrev-ref', '@{u}']).trim();
      const base = hasUpstream ? '@{u}' : (git(p.dir, ['rev-parse', '--verify', '--quiet', 'origin/HEAD']).trim() ? 'origin/HEAD' : '');
      state.push_base = base || 'unknown (no upstream, no origin/HEAD); showing the last 20 commits';
      state.unpushed_commits = cut(git(p.dir, base ? ['log', '--oneline', '-50', `${base}..HEAD`] : ['log', '--oneline', '-20']), 4000);
      if (base) state.unpushed_stat = cut(git(p.dir, ['diff', '--stat', `${base}..HEAD`]), 4000);
    }

    const opts = { timeout: 8000, retries: 0, deadline };
    if (label) opts.label = label;
    const r = await runPreset('diff_risk', state, opts);
    if (!r.ok) return { ...none, found: f };
    const a = r.answers, hits = [];
    // Jev's secrets flag alone was a false positive on 5 of 8 commit asks (16-24.10): also require a secret-like
    // value in the diff (the redaction patterns fire) or a secret-like file name in the change.
    if (a.secrets_or_auth?.p >= ASK.secrets_or_auth && secretEvidence(state)) hits.push(`touches secrets/auth (p=${a.secrets_or_auth.p})`);
    if (a.destructive?.p >= ASK.destructive) hits.push(`destructive (p=${a.destructive.p})`);
    if (a.severity?.score >= ASK.severity) hits.push(`risk severity ${a.severity.score}/3`);
    if (!hits.length) return { ...none, found: f };
    return { decision: 'ask', level: 'risk', reason: `Jev diff_risk: ${hits.join(', ')}. Advisory classifier; confirm only if this is intended.`, found: f };
  } catch { return none; }
}

// Prefixes that codex/jev-guard.rules makes Codex prompt for (keep both in sync; test/run.mjs checks it).
// Codex rules match exact leading tokens, so e.g. `git -C x reset --hard` or `git push origin main -f` are not covered.
export const CODEX_RULE_PREFIXES = [
  ['git', 'reset', '--hard'],
  ...['-f', '-fd', '-df', '-fx', '-xf', '-fdx', '-fxd', '-dfx', '-xfd', '-xdf', '-dxf', '-ff', '-ffd', '-ffdx', '--force'].map(f => ['git', 'clean', f]),
  ...['--force', '-f', '--force-with-lease', '--mirror'].map(f => ['git', 'push', f]),
  ['git', 'stash', 'clear'],
  ['git', 'filter-branch'],
  ['git', 'filter-repo'],
  ...['-rf', '-fr', '-r', '-R', '-Rf', '-fR', '--recursive'].map(f => ['rm', f]),
];

// True when Codex execpolicy would already prompt for the hard command: one plain command (no chain, redirection,
// substitution, variables, globs or comments) whose leading tokens match a rule. `codex execpolicy check` matches
// argv literally; that Codex also splits linear `bash -lc` chains at run time is documented but not checked here,
// so chains count as not covered and the hook blocks them. Assumption: on Windows Codex runs commands through
// PowerShell, which these rules are not known to cover, so nothing counts as covered there.
export function coveredByCodexRules(command, hardTexts, platform = process.platform) {
  if (platform === 'win32') return false;
  const plain = String(command).trim();
  if (/[<>$`*(){};|&#\n]/.test(plain) || segments(plain).length !== 1) return false;
  return hardTexts.every(t => {
    const w = t.split(' ');
    return CODEX_RULE_PREFIXES.some(p => p.every((x, i) => w[i] === x));
  });
}

// tool_input.command is a string for shell tools; accept an argv array too (["bash","-lc","script"]).
export function shellCommandText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const i = c.findIndex(a => /^-(l?c|Command)$/i.test(a));
    return i >= 0 && c[i + 1] != null ? String(c[i + 1]) : c.join(' ');
  }
  return '';
}
