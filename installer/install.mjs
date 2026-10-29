#!/usr/bin/env node
// llm-config installer. Node >= 18, no dependencies. Spec: ../CONTRACT.md
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MANIFEST_VERSION = 1;
const IS_WIN = process.platform === 'win32';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GROUP_ORDER = ['base', 'tools', 'extras'];
const GROUP_LABEL = { base: 'Base', tools: 'Tools', extras: 'Extras' };
const ACTION_TYPES = new Set(['copy', 'block', 'json-merge', 'npm-install', 'chmod']);
const WRITE_ROOT_VARS = ['HOME', 'AGENTS_HOME', 'CLAUDE_HOME', 'CODEX_HOME', 'OPENCODE_HOME', 'GEMINI_HOME', 'JEV_HOME',
  'COPILOT_HOME', 'CURSOR_HOME', 'CURSOR_CLI_HOME', 'KILO_HOME', 'GOOSE_HOME', 'KIRO_HOME'];
const VAR_RE = new RegExp(`\{(${[...WRITE_ROOT_VARS, 'NODE', 'OS'].join('|')})\}`, 'g');
const INCLUDE_RE = /^[ \t]*\{\{include:([^}\r\n]+)\}\}[ \t]*$/gm;
const SKIP_NAMES = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);
const HASH_EXT = new Set(['.toml', '.rules', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.ps1', '.py', '.conf', '.env', '.ini', '.cfg']);
const SLASH_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsonc']);

class UsageError extends Error {}

// ---------------------------------------------------------------- colours
let useColor = false;
const sgr = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = sgr('1'), dim = sgr('2'), red = sgr('31'), green = sgr('32'), yellow = sgr('33');
const blue = sgr('34'), magenta = sgr('35'), cyan = sgr('36');
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const vlen = (s) => String(s).replace(ANSI_RE, '').length;
function truncAnsi(s, w) {
  if (vlen(s) <= w) return s;
  let out = '', n = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (n >= w - 1) return out + '~' + (useColor ? '\x1b[0m' : '');
    out += s[i]; n++; i++;
  }
  return out;
}

// ---------------------------------------------------------------- small utils
const fwd = (p) => String(p).replace(/\\/g, '/');
const absPath = (p) => fwd(path.resolve(p));
const keyOf = (p) => (IS_WIN ? absPath(p).toLowerCase() : absPath(p));
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const statOrNull = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readOrNull = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bufEq = (a, b) => (a === null || b === null ? a === b : a.equals(b));
const isTmpl = (p) => p.endsWith('.tmpl');
const stripTmpl = (p) => (isTmpl(p) ? p.slice(0, -5) : p);
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
function deq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deq(x, b[i]));
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deq(a[k], b[k]));
  }
  return false;
}
function stripJsonComments(s) {
  let out = '', i = 0, inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += s[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
function parseJsonLoose(text) {
  const t = stripBom(text);
  try { return JSON.parse(t); } catch { return JSON.parse(stripJsonComments(t)); }
}
function detectIndent(text) {
  const m = /^([ \t]+)["\]}]/m.exec(text);
  return m ? m[1] : 2;
}
function which(cmd) {
  if (cmd === 'node') return process.execPath;
  const exts = IS_WIN ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const raw of (process.env.PATH || '').split(path.delimiter)) {
    const d = raw.replace(/^"|"$/g, '');
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, cmd + ext);
      const st = statOrNull(p);
      if (!st || !st.isFile()) continue;
      if (!IS_WIN) { try { fs.accessSync(p, fs.constants.X_OK); } catch { continue; } }
      return p;
    }
  }
  return null;
}
function walkFiles(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_NAMES.has(ent.name)) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walkFiles(dir, r));
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- variables
function resolveVars(homeOpt) {
  const redirected = !!homeOpt;
  const env = (k) => (redirected ? undefined : (process.env[k] && process.env[k].trim() ? process.env[k] : undefined));
  const HOME = absPath(homeOpt || os.homedir());
  const AGENTS_HOME = `${HOME}/.agents`;
  const xdg = env('XDG_CONFIG_HOME');
  return {
    HOME,
    AGENTS_HOME,
    CLAUDE_HOME: absPath(env('CLAUDE_CONFIG_DIR') || `${HOME}/.claude`),
    CODEX_HOME: absPath(env('CODEX_HOME') || `${HOME}/.codex`),
    OPENCODE_HOME: absPath(env('OPENCODE_CONFIG_DIR') || (xdg ? `${xdg}/opencode` : `${HOME}/.config/opencode`)),
    GEMINI_HOME: `${HOME}/.gemini`,
    JEV_HOME: `${AGENTS_HOME}/tools/jev`,
    COPILOT_HOME: absPath(env('COPILOT_HOME') || `${HOME}/.copilot`),
    CURSOR_HOME: `${HOME}/.cursor`,
    CURSOR_CLI_HOME: absPath(env('CURSOR_CONFIG_DIR') || (process.platform === 'linux' && xdg ? `${xdg}/cursor` : `${HOME}/.cursor`)),
    KILO_HOME: absPath(xdg ? `${xdg}/kilo` : `${HOME}/.config/kilo`),
    GOOSE_HOME: absPath(IS_WIN ? `${redirected ? `${HOME}/AppData/Roaming` : (env('APPDATA') || `${HOME}/AppData/Roaming`)}/Block/goose/config`
      : (xdg ? `${xdg}/goose` : `${HOME}/.config/goose`)),
    KIRO_HOME: (() => { const k = env('KIRO_HOME'); const a = k && path.isAbsolute(k) ? absPath(k) : null; return a && !isInside(HOME, a) ? a : `${HOME}/.kiro`; })(),
    NODE: fwd(process.execPath),
    OS: process.platform,
  };
}
const expand = (s, vars) => String(s).replace(VAR_RE, (_, k) => vars[k]);
// .tmpl sources: {{include:<path>}} on its own line pulls in another repo file (relative to the component folder,
// no nesting), then variables are expanded. One source of truth for text shared by several adapters.
function expandTmpl(text, a, ctx) {
  const withIncludes = text.replace(INCLUDE_RE, (_, rel) => {
    const p = absPath(path.join(a._src, rel.trim()));
    if (!isInside(p, ctx.root)) throw new Error(`include "${rel}" is outside the repository`);
    const st = statOrNull(p);
    if (!st || !st.isFile()) throw new Error(`include not found: ${rel}`);
    return stripBom(fs.readFileSync(p, 'utf8')).replace(/\s+$/, '');
  });
  return expand(withIncludes, ctx.vars);
}
function expandDeep(v, vars) {
  if (typeof v === 'string') return expand(v, vars);
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, vars));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [expand(k, vars), expandDeep(x, vars)]));
  return v;
}

// ---------------------------------------------------------------- args
const HELP = `llm-config installer

Usage: install.sh [options]        (or: node installer/install.mjs [options])

  --components a,b   install exactly these components (plus what they require)
  --all              install every component available on this platform
  --update           re-apply every installed component from this checkout (no picker)
  --yes, -y          no prompts (uses defaults unless --components/--all)
  --dry-run, -n      show planned changes and diffs, write nothing
  --check            like --dry-run without diffs; exit 3 if anything would change (drift check for CI);
                     without --components/--all it checks the installed components
  --json             with --dry-run/--check: print the plan as JSON on stdout instead of tables
  --uninstall [a,b]  remove the given components (default: everything installed)
  --list             list components and their status
  --home DIR         use DIR as the home directory (for tests; ignores CLAUDE_CONFIG_DIR etc.)
  --root DIR         repo root containing components/ and local/components/ (default: this repo)
  --no-color         disable colours (NO_COLOR is respected too)
  --verbose, -v      more detail (per-file rows, full diffs, npm output)
  --help, -h         this text

Interactive picker: up/down (or j/k) move, space toggles, a toggles all, enter confirms, q quits.
State: ~/.llm-config/manifest.json, backups in ~/.llm-config/backups/<timestamp>/.`;

const splitList = (s) => String(s).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
function parseArgs(argv) {
  const o = { components: null, all: false, yes: false, dryRun: false, check: false, json: false, update: false, uninstall: false, uninstallIds: null, list: false, home: null, root: null, color: null, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], val = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => {
      if (val !== null) return val;
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--components': case '-c': o.components = [...(o.components || []), ...splitList(next())]; break;
      case '--all': o.all = true; break;
      case '--update': case '-u': o.update = true; break;
      case '--yes': case '-y': o.yes = true; break;
      case '--dry-run': case '-n': o.dryRun = true; break;
      case '--check': o.check = true; o.dryRun = true; break;
      case '--json': o.json = true; break;
      case '--uninstall':
        o.uninstall = true;
        if (val !== null) o.uninstallIds = splitList(val);
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) o.uninstallIds = splitList(argv[++i]);
        break;
      case '--list': o.list = true; break;
      case '--home': o.home = next(); break;
      case '--root': o.root = next(); break;
      case '--no-color': case '--no-colour': o.color = false; break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new UsageError(`unknown argument "${argv[i]}"`);
    }
  }
  if ([o.all, !!o.components, o.update].filter(Boolean).length > 1) throw new UsageError('use only one of --all, --components, --update');
  if (o.update && o.uninstall) throw new UsageError('use either --update or --uninstall');
  // a drift check with no explicit selection compares what is installed
  if (o.check && !o.all && !o.components && !o.uninstall) o.update = true;
  return o;
}

// ---------------------------------------------------------------- components
function loadComponents(root) {
  const comps = new Map();
  const errors = [];
  for (const [dir, isLocal] of [[`${root}/components`, false], [`${root}/local/components`, true]]) {
    const st = statOrNull(dir);
    if (!st || !st.isDirectory()) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const cdir = `${dir}/${name}`;
      const file = `${cdir}/component.json`;
      if (!statOrNull(file)) continue;
      let def;
      try { def = parseJsonLoose(fs.readFileSync(file, 'utf8')); } catch (e) { errors.push(`${file}: ${e.message}`); continue; }
      if (!isObj(def)) { errors.push(`${file}: not a JSON object`); continue; }
      const id = def.id || name;
      if (def.actions !== undefined && !Array.isArray(def.actions)) { errors.push(`${file}: "actions" must be an array`); continue; }
      const actions = (def.actions || []).map((a, i) => ({ ...a, _src: cdir, _local: isLocal, _n: i + 1 }));
      const existing = comps.get(id);
      if (existing && isLocal) {
        for (const k of ['title', 'description', 'group', 'default', 'detect', 'platforms']) if (def[k] !== undefined) existing[k] = def[k];
        if (def.requires) existing.requires = [...new Set([...existing.requires, ...def.requires])];
        if (def.requiresBinaries) existing.requiresBinaries = [...new Set([...existing.requiresBinaries, ...def.requiresBinaries])];
        if (def.postInstall) existing.postInstall = [existing.postInstall, def.postInstall].filter(Boolean).join('\n');
        existing.actions.push(...actions);
        existing.localOverlay = true;
        continue;
      }
      if (existing) { errors.push(`${file}: duplicate component id "${id}"`); continue; }
      comps.set(id, {
        id,
        title: def.title || id,
        description: def.description || '',
        group: def.group || 'extras',
        requires: Array.isArray(def.requires) ? def.requires : [],
        default: def.default ?? false,
        detect: def.detect || null,
        platforms: Array.isArray(def.platforms) ? def.platforms : null,
        requiresBinaries: Array.isArray(def.requiresBinaries) ? def.requiresBinaries : [],
        replaces: Array.isArray(def.replaces) ? def.replaces : [],
        omits: Array.isArray(def.omits) ? def.omits.filter((s) => typeof s === 'string' && s) : [],
        postInstall: def.postInstall || '',
        apiKey: isObj(def.apiKey) && def.apiKey.env && def.apiKey.configFile ? def.apiKey : null,
        actions,
        local: isLocal,
        localOverlay: false,
      });
    }
  }
  return { comps, errors };
}
function groupRank(g) { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; }
function sortedComps(comps) {
  return [...comps.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
}
function closure(ids, comps) {
  const out = new Set();
  const visit = (id) => { if (out.has(id)) return; out.add(id); const c = comps.get(id); if (c) c.requires.forEach(visit); };
  [...ids].forEach(visit);
  return out;
}
function topoOrder(ids, comps) {
  const set = new Set(ids);
  const base = [...set].sort((a, b) => {
    const ca = comps.get(a), cb = comps.get(b);
    return groupRank(ca?.group) - groupRank(cb?.group) || a.localeCompare(b);
  });
  const out = [], seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || !set.has(id)) return;
    seen.add(id);
    (comps.get(id)?.requires || []).forEach(visit);
    out.push(id);
  };
  base.forEach(visit);
  return out;
}
function compInfo(comps, vars, manifest) {
  const info = new Map();
  for (const c of comps.values()) {
    let detected = null;
    if (c.detect && (c.detect.commands?.length || c.detect.paths?.length)) {
      detected = (c.detect.commands || []).some((cmd) => which(cmd)) ||
        (c.detect.paths || []).some((p) => !!statOrNull(absPath(expand(p, vars))));
    }
    info.set(c.id, {
      supported: !c.platforms || c.platforms.includes(process.platform),
      detected,
      missingBins: c.requiresBinaries.filter((b) => !which(b)),
      installed: !!manifest.components[c.id],
    });
  }
  return info;
}
function defaultSelection(comps, info) {
  const sel = new Set();
  for (const c of comps.values()) {
    const inf = info.get(c.id);
    if (!inf.supported) continue;
    if (c.default === true || (c.default === 'detect' && inf.detected === true) || inf.installed) sel.add(c.id);
  }
  return sel;
}

// ---------------------------------------------------------------- virtual fs
class VFS {
  constructor() { this.m = new Map(); }
  get(p) { const e = this.m.get(keyOf(p)); return e ? e.data : readOrNull(p); }
  set(p, data, owner, mode) { this.m.set(keyOf(p), { path: absPath(p), data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), owner, mode }); }
  del(p, owner) { this.m.set(keyOf(p), { path: absPath(p), data: null, owner }); }
  changed(p) { const e = this.m.get(keyOf(p)); return !!e && !bufEq(readOrNull(p), e.data); }
  changes() {
    const out = [];
    for (const e of this.m.values()) {
      const before = readOrNull(e.path);
      if (bufEq(before, e.data)) continue;
      out.push({ path: e.path, before, after: e.data, owner: e.owner, mode: e.mode, kind: before === null ? 'create' : e.data === null ? 'delete' : 'modify' });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}

// ---------------------------------------------------------------- context
function makeCtx(opts, vars, root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    opts, vars, root,
    vfs: new VFS(),
    execs: [],
    rows: [],
    warnings: [],
    failed: false,
    stateDir: `${vars.HOME}/.llm-config`,
    pendingKeys: [],
    backupDir: `${vars.HOME}/.llm-config/backups/${stamp}`,
    backedUp: new Set(),
    createdDirs: new Set(),
    oldRecords: new Map(),
    whenSet: new Set(),
  };
}
const tildeOf = (ctx) => (p) => {
  const a = absPath(p);
  return isInside(a, ctx.vars.HOME) ? '~' + (a.length > ctx.vars.HOME.length ? '/' + fwd(path.relative(ctx.vars.HOME, a)) : '') : a;
};
function backupPathFor(ctx, p) {
  const a = absPath(p);
  const rel = isInside(a, ctx.vars.HOME) ? fwd(path.relative(ctx.vars.HOME, a)) : '_external/' + a.replace(/^([A-Za-z]):/, '$1').replace(/^\/+/, '');
  return `${ctx.backupDir}/${rel}`;
}
function targetPath(raw, ctx, field = 'to') {
  if (typeof raw !== 'string' || !raw) throw new Error(`missing "${field}"`);
  const expanded = expand(raw, ctx.vars);
  if (!path.isAbsolute(expanded)) throw new Error(`"${field}": "${raw}" must start with a variable such as {HOME}`);
  return ensureAllowed(absPath(expanded), ctx, raw);
}
function ensureAllowed(p, ctx, raw = p) {
  const roots = WRITE_ROOT_VARS.map((v) => ctx.vars[v]);
  if (!roots.some((r) => isInside(p, r))) throw new Error(`"${raw}" resolves outside the allowed directories`);
  if (isInside(p, ctx.stateDir)) throw new Error(`"${raw}" points into ~/.llm-config, which is reserved`);
  return p;
}
function sourcePath(a, ctx, field = 'from') {
  if (typeof a[field] !== 'string' || !a[field]) throw new Error(`missing "${field}"`);
  const p = absPath(path.join(a._src, a[field]));
  if (!isInside(p, ctx.root)) throw new Error(`source "${a[field]}" is outside the repository`);
  const st = statOrNull(p);
  if (!st) throw new Error(`source not found: ${a[field]}`);
  return { p, st };
}

// ---------------------------------------------------------------- block helpers
function commentStyle(p) {
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base);
  if (ext === '.json') throw new Error('blocks cannot be placed in .json files; use json-merge');
  if (HASH_EXT.has(ext) || (base.startsWith('.') && ext === '')) return 'hash';
  if (SLASH_EXT.has(ext)) return 'slash';
  return 'html';
}
function markers(style, id) {
  if (style === 'hash') return [`# llm-config:begin ${id}`, `# llm-config:end ${id}`];
  if (style === 'slash') return [`// llm-config:begin ${id}`, `// llm-config:end ${id}`];
  return [`<!-- llm-config:begin ${id} -->`, `<!-- llm-config:end ${id} -->`];
}
function findMarkerLine(text, m, from) {
  let i = from;
  while ((i = text.indexOf(m, i)) >= 0) {
    const end = i + m.length;
    const okStart = i === 0 || text[i - 1] === '\n';
    const okEnd = end === text.length || text[end] === '\n' || (text[end] === '\r' && text[end + 1] === '\n');
    if (okStart && okEnd) return i;
    i = end;
  }
  return -1;
}
function findBlock(text, style, id) {
  const [b, e] = markers(style, id);
  const s = findMarkerLine(text, b, 0);
  if (s < 0) return null;
  const ei = findMarkerLine(text, e, s + b.length);
  if (ei < 0) throw new Error(`block "${id}" has a begin marker but no end marker; fix the file by hand`);
  return { start: s, end: ei + e.length };
}
function upsertBlock(before, body, style, id, old) {
  const eol = before !== null && before.includes('\r\n') ? '\r\n' : '\n';
  const [b, e] = markers(style, id);
  const content = body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const block = [b, ...(content ? content.split('\n') : []), e].join(eol);
  if (before === null) return { text: block + eol, created: true, sep: false, addedEol: false };
  const r = findBlock(before, style, id);
  if (r) return { text: before.slice(0, r.start) + block + before.slice(r.end), created: old?.created ?? false, sep: old?.sep ?? false, addedEol: old?.addedEol ?? false };
  let t = before, addedEol = false, sep = false;
  if (t.length && !t.endsWith('\n')) { t += eol; addedEol = true; }
  if (t.trim().length && !t.endsWith(eol + eol)) { t += eol; sep = true; }
  return { text: t + block + eol, created: old?.created ?? false, sep, addedEol };
}
function removeBlock(text, rec) {
  const r = findBlock(text, rec.style, rec.id);
  if (!r) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let pre = text.slice(0, r.start), post = text.slice(r.end);
  if (post.startsWith('\r\n')) post = post.slice(2); else if (post.startsWith('\n')) post = post.slice(1);
  if (rec.sep && pre.endsWith(eol + eol) && (post === '' || post.startsWith(eol))) pre = pre.slice(0, -eol.length);
  if (post === '' && rec.addedEol && pre.endsWith(eol)) pre = pre.slice(0, -eol.length);
  return pre + post;
}

// ---------------------------------------------------------------- json helpers
function mergeInto(t, s, p, ops, override, notes) {
  for (const [k, v] of Object.entries(s)) {
    const kp = [...p, k];
    if (!Object.hasOwn(t, k)) {
      if (isObj(v)) { t[k] = {}; ops.push({ op: 'mkobj', path: kp }); mergeInto(t[k], v, kp, ops, override, notes); }
      else if (Array.isArray(v)) {
        t[k] = []; ops.push({ op: 'mkarr', path: kp });
        for (const item of v) if (!t[k].some((x) => deq(x, item))) { t[k].push(clone(item)); ops.push({ op: 'push', path: kp, value: clone(item) }); }
      } else { t[k] = clone(v); ops.push({ op: 'set', path: kp, value: clone(v) }); }
      continue;
    }
    const cur = t[k];
    if (isObj(v) && isObj(cur)) mergeInto(cur, v, kp, ops, override, notes);
    else if (Array.isArray(v) && Array.isArray(cur)) {
      for (const item of v) if (!cur.some((x) => deq(x, item))) { cur.push(clone(item)); ops.push({ op: 'push', path: kp, value: clone(item) }); }
    } else if (deq(cur, v)) { /* already equal */ }
    else if (override) { ops.push({ op: 'replace', path: kp, prev: clone(cur), value: clone(v) }); t[k] = clone(v); }
    else notes.push(`kept existing value at ${kp.join('.')}`);
  }
}
function getPath(o, p) { let cur = o; for (const k of p) { if (!isObj(cur) || !Object.hasOwn(cur, k)) return undefined; cur = cur[k]; } return cur; }
function reverseOps(t, ops, warn) {
  for (const op of [...ops].reverse()) {
    const parent = getPath(t, op.path.slice(0, -1));
    const k = op.path[op.path.length - 1];
    if (!isObj(parent) || !Object.hasOwn(parent, k)) continue;
    const where = op.path.join('.');
    switch (op.op) {
      case 'set': if (deq(parent[k], op.value)) delete parent[k]; else warn(`kept ${where} (changed since install)`); break;
      case 'replace': if (deq(parent[k], op.value)) parent[k] = op.prev; else warn(`kept ${where} (changed since install)`); break;
      case 'push': if (Array.isArray(parent[k])) { const i = parent[k].findIndex((x) => deq(x, op.value)); if (i >= 0) parent[k].splice(i, 1); } break;
      case 'mkobj': if (isObj(parent[k]) && Object.keys(parent[k]).length === 0) delete parent[k]; break;
      case 'mkarr': if (Array.isArray(parent[k]) && parent[k].length === 0) delete parent[k]; break;
    }
  }
}
function dedupeOps(ops) { const out = []; for (const o of ops) if (!out.some((x) => deq(x, o))) out.push(o); return out; }
function readJsonTarget(buf, p) {
  const text = stripBom(buf.toString('utf8'));
  if (!text.trim()) return { obj: {}, text, indent: 2, eol: '\n' };
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error(`${p} is not plain JSON (${e.message}); refusing to rewrite it`); }
  if (!isObj(obj)) throw new Error(`${p} does not contain a JSON object`);
  return { obj, text, indent: detectIndent(text), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}
const jsonOut = (obj, indent, eol) => JSON.stringify(obj, null, indent).replace(/\n/g, eol) + eol;

// ---------------------------------------------------------------- planners
function row(ctx, comp, type, target, status, note) { ctx.rows.push({ comp, type, target, status, note }); }

const PLANNERS = {
  copy(a, comp, ctx) {
    const { p: src, st } = sourcePath(a, ctx);
    if (typeof a.to !== 'string' || !a.to) throw new Error('missing "to"');
    const pairs = [];
    if (st.isDirectory()) {
      const dir = targetPath(a.to.replace(/\/+$/, '') || a.to, ctx);
      for (const rel of walkFiles(src)) pairs.push({ src: `${src}/${rel}`, dest: ensureAllowed(absPath(`${dir}/${stripTmpl(rel)}`), ctx) });
    } else {
      const dest = a.to.endsWith('/') ? targetPath(a.to + stripTmpl(path.basename(src)), ctx) : targetPath(a.to, ctx);
      pairs.push({ src, dest });
    }
    const shadowedBy = new Set();
    const owned = pairs.filter(({ dest }) => {
      const om = (ctx.omits || []).find((x) => x.by !== comp.id && (x.dir ? isInside(dest, x.path) : keyOf(dest) === keyOf(x.path)));
      if (om) { shadowedBy.add(`${om.by} (omits)`); return false; }
      const o = ctx.shadow?.get(`copy:${keyOf(dest)}`);
      if (o && o !== comp.id) { shadowedBy.add(o); return false; }
      return true;
    });
    if (!owned.length) return { records: [], status: 'skip', note: `shadowed by ${[...shadowedBy].join(', ')}`, target: tildeOf(ctx)(pairs[0]?.dest || a.to) };
    const prepared = owned.map(({ src: s, dest }) => {
      let data = fs.readFileSync(s);
      if (isTmpl(s)) data = Buffer.from(expandTmpl(data.toString('utf8'), a, ctx), 'utf8');
      const mode = IS_WIN ? undefined : fs.statSync(s).mode & 0o777;
      return { dest, data, mode };
    });
    const counts = { create: 0, update: 0, unchanged: 0 };
    const records = [];
    const t = tildeOf(ctx);
    for (const f of prepared) {
      const key = `copy:${keyOf(f.dest)}`;
      const old = ctx.oldRecords.get(key);
      const before = ctx.vfs.get(f.dest);
      const rec = { key, kind: 'copy', path: f.dest, hash: sha(f.data) };
      let status;
      if (before && before.equals(f.data)) {
        status = 'unchanged';
        rec.preexisting = old ? !!old.preexisting : true;
        if (old?.backup) rec.backup = old.backup;
      } else if (before) {
        status = 'update';
        const ours = old && !old.preexisting && sha(before) === old.hash;
        if (old && !ours && !old.preexisting) ctx.warnings.push(`${t(f.dest)} was modified since install; overwriting it (old version backed up)`);
        if (ours) { if (old.backup) rec.backup = old.backup; } else rec.backup = backupPathFor(ctx, f.dest);
        ctx.vfs.set(f.dest, f.data, comp.id, f.mode);
      } else {
        status = 'create';
        if (old?.backup) rec.backup = old.backup;
        ctx.vfs.set(f.dest, f.data, comp.id, f.mode);
      }
      counts[status]++;
      if (!rec.preexisting) delete rec.preexisting;
      records.push(rec);
      if (ctx.opts.verbose && prepared.length > 1) row(ctx, comp.id, '  file', t(f.dest), status);
    }
    let status = counts.create && !counts.update && !counts.unchanged ? 'create' : counts.create || counts.update ? 'update' : 'unchanged';
    let note = prepared.length > 1 ? `${prepared.length} files: ` + Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') : '';
    if (shadowedBy.size) note += `${note ? '; ' : ''}${pairs.length - owned.length} shadowed by ${[...shadowedBy].join(', ')}`;
    return { records, status, note, target: prepared.length > 1 ? t(path.dirname(prepared[0].dest)) + '/' : t(prepared[0]?.dest || a.to) };
  },

  block(a, comp, ctx, used) {
    const { p: src, st } = sourcePath(a, ctx);
    if (!st.isFile()) throw new Error('block "from" must be a file');
    let body = fs.readFileSync(src, 'utf8');
    if (isTmpl(src)) body = expandTmpl(body, a, ctx);
    const dest = targetPath(a.to, ctx);
    const style = commentStyle(dest);
    let id = a.id || (a._local && !comp.local ? `${comp.id}-local` : comp.id);
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`invalid block id "${id}"`);
    let uniq = id, n = 2;
    while (used.has(`${keyOf(dest)}#${uniq}`)) uniq = `${id}-${n++}`;
    used.add(`${keyOf(dest)}#${uniq}`);
    id = uniq;
    const key = `block:${keyOf(dest)}#${id}`;
    const old = ctx.oldRecords.get(key);
    const beforeBuf = ctx.vfs.get(dest);
    const before = beforeBuf ? beforeBuf.toString('utf8') : null;
    const res = upsertBlock(before, body, style, id, old);
    const rec = { key, kind: 'block', path: dest, id, style };
    if (res.created) rec.created = true;
    if (res.sep) rec.sep = true;
    if (res.addedEol) rec.addedEol = true;
    let status = 'unchanged';
    if (before !== res.text) { ctx.vfs.set(dest, res.text, comp.id); status = before === null ? 'create' : 'update'; }
    return { records: [rec], status, note: `block ${id}`, target: tildeOf(ctx)(dest) };
  },

  'json-merge'(a, comp, ctx) {
    const { p: src, st } = sourcePath(a, ctx);
    if (!st.isFile()) throw new Error('json-merge "from" must be a file');
    let patch;
    try { patch = parseJsonLoose(fs.readFileSync(src, 'utf8')); } catch (e) { throw new Error(`cannot parse ${a.from}: ${e.message}`); }
    if (!isObj(patch)) throw new Error(`${a.from} must contain a JSON object`);
    if (isTmpl(src)) patch = expandDeep(patch, ctx.vars);
    const dest = targetPath(a.to, ctx);
    const beforeBuf = ctx.vfs.get(dest);
    // onlyIfExists: settings files with required fields the tool writes itself (e.g. Cursor cli-config.json).
    if (!beforeBuf && a.onlyIfExists === true) return { records: [], status: 'skip', note: 'target does not exist', target: tildeOf(ctx)(dest) };
    const tgt = beforeBuf ? readJsonTarget(beforeBuf, tildeOf(ctx)(dest)) : { obj: {}, indent: 2, eol: '\n' };
    const key = `json:${keyOf(dest)}|${a._local ? 'local:' : ''}${fwd(a.from)}`;
    const old = ctx.oldRecords.get(key);
    // Re-plan from a base without what this action added last time, so a changed template replaces its old
    // entries (array items, scalars) instead of piling up next to them. User edits are kept by reverseOps.
    let base = clone(tgt.obj);
    if (old?.ops?.length) reverseOps(base, old.ops, (w) => ctx.opts.verbose && ctx.warnings.push(`${comp.id}: ${tildeOf(ctx)(dest)}: ${w}`));
    let ops = [], notes = [];
    mergeInto(base, patch, [], ops, a.override === true, notes);
    // Same entries as last time: merge into the file as it is, so positions stay put. Rebuilding would move
    // this action's array items to the end and fight another action that merges into the same file.
    // Compare the entries only (pushed items, set values): which containers had to be created depends on
    // what other actions merged into the same file before this one.
    const entries = (list) => dedupeOps(list.filter((o) => o.op === 'push' || o.op === 'set' || o.op === 'replace'));
    const sameSet = (x, y) => x.length === y.length && x.every((o) => y.some((p) => deq(o, p)));
    if (old?.ops?.length && sameSet(entries(ops), entries(old.ops))) {
      base = clone(tgt.obj); const more = []; notes = [];
      mergeInto(base, patch, [], more, a.override === true, notes);
      ops = [...old.ops, ...more];
    }
    const rec = { key, kind: 'json', path: dest, ops: dedupeOps(ops) };
    if (old ? old.created : !beforeBuf) rec.created = true;
    let status = 'unchanged';
    const changed = !beforeBuf || !deq(base, tgt.obj);
    if (changed) { ctx.vfs.set(dest, jsonOut(base, tgt.indent, tgt.eol), comp.id); status = beforeBuf ? 'update' : 'create'; }
    if (ctx.opts.verbose) notes.forEach((n) => ctx.warnings.push(`${comp.id}: ${tildeOf(ctx)(dest)}: ${n}`));
    return { records: [rec], status, note: changed && ops.length ? `${ops.length} addition(s)` : '', target: tildeOf(ctx)(dest) };
  },

  'npm-install'(a, comp, ctx) {
    const dir = targetPath(a.dir, ctx, 'dir');
    const t = tildeOf(ctx);
    const pkgBuf = ctx.vfs.get(`${dir}/package.json`);
    if (!pkgBuf) return { records: [], status: 'skip', note: 'no package.json', target: t(dir) };
    let pkg;
    try { pkg = JSON.parse(stripBom(pkgBuf.toString('utf8'))); } catch (e) { throw new Error(`bad package.json in ${t(dir)}: ${e.message}`); }
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) });
    if (!deps.length) return { records: [], status: 'skip', note: 'no dependencies', target: t(dir) };
    const key = `npm:${keyOf(dir)}`;
    const old = ctx.oldRecords.get(key);
    const nm = `${dir}/node_modules`;
    const nmExists = !!statOrNull(nm);
    const rec = { key, kind: 'npm', dir };
    if (old ? old.createdNodeModules : !nmExists) rec.createdNodeModules = true;
    const changed = ctx.vfs.changed(`${dir}/package.json`) || ctx.vfs.changed(`${dir}/package-lock.json`);
    if (nmExists && !changed) return { records: [rec], status: 'unchanged', note: '', target: t(dir) };
    if (!which('npm')) throw new Error('npm not found on PATH');
    ctx.execs.push({ kind: 'npm', dir, owner: comp.id, label: `npm install in ${t(dir)}` });
    return { records: [rec], status: 'run', note: 'npm install', target: t(dir) };
  },

  chmod(a, comp, ctx) {
    const t = tildeOf(ctx);
    if (IS_WIN) return { records: [], status: 'skip', note: 'not on Windows', target: a.to };
    const p = targetPath(a.to, ctx);
    const mode = typeof a.mode === 'number' ? a.mode : parseInt(String(a.mode ?? ''), 8);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error(`invalid mode "${a.mode}"`);
    if (!ctx.vfs.get(p)) throw new Error(`${t(p)} does not exist`);
    const key = `chmod:${keyOf(p)}`;
    const old = ctx.oldRecords.get(key);
    const st = statOrNull(p);
    const rec = { key, kind: 'chmod', path: p, mode };
    if (old && old.mode === mode && old.observed !== undefined) rec.observed = old.observed;
    const cur = st ? st.mode & 0o7777 : null;
    if (st && !ctx.vfs.changed(p) && (cur === mode || (rec.observed !== undefined && rec.observed === cur))) {
      return { records: [rec], status: 'unchanged', note: mode.toString(8), target: t(p) };
    }
    ctx.execs.push({ kind: 'chmod', path: p, mode, rec, owner: comp.id, label: `chmod ${mode.toString(8)} ${t(p)}` });
    return { records: [rec], status: 'run', note: `chmod ${mode.toString(8)}`, target: t(p) };
  },
};

function planComponent(comp, ctx) {
  const records = [];
  let hadError = false;
  const used = new Set();
  for (const a of comp.actions) {
    const type = a.type || '?';
    const label = `${type}${a._local ? ' (local)' : ''}`;
    const tgt = a.to || a.dir || '';
    try {
      if (!ACTION_TYPES.has(type)) throw new Error(`unknown action type "${type}"`);
      if (a.platforms && !(Array.isArray(a.platforms) && a.platforms.includes(process.platform))) { row(ctx, comp.id, label, tgt, 'skip', `platform ${process.platform}`); continue; }
      const whenIds = a.when == null ? [] : [].concat(a.when);
      const missing = whenIds.filter((w) => !ctx.whenSet.has(w));
      if (missing.length) { row(ctx, comp.id, label, tgt, 'skip', `needs ${missing.join(', ')}`); continue; }
      const blockers = (a.unless == null ? [] : [].concat(a.unless)).filter((u) => ctx.whenSet.has(u));
      if (blockers.length) { row(ctx, comp.id, label, tgt, 'skip', `not with ${blockers.join(', ')}`); continue; }
      const out = PLANNERS[type](a, comp, ctx, used);
      for (const r of out.records) { if (whenIds.length) r.when = whenIds; records.push(r); }
      row(ctx, comp.id, label, out.target, out.status, out.note);
    } catch (e) {
      hadError = true;
      ctx.failed = true;
      row(ctx, comp.id, label, tgt, 'error', e.message);
    }
  }
  return { records, hadError };
}

function planReverse(rec, ctx, owner, reason) {
  const t = tildeOf(ctx);
  const label = `${reason}`;
  try {
    switch (rec.kind) {
      case 'copy': {
        const cur = ctx.vfs.get(rec.path);
        if (!cur) return row(ctx, owner, label, t(rec.path), 'unchanged', 'already gone');
        if (rec.preexisting) return row(ctx, owner, label, t(rec.path), 'kept', 'existed before install');
        if (sha(cur) !== rec.hash) { ctx.warnings.push(`kept ${t(rec.path)}: modified since install`); return row(ctx, owner, label, t(rec.path), 'kept', 'modified by you'); }
        const orig = rec.backup ? readOrNull(rec.backup) : null;
        if (orig) { ctx.vfs.set(rec.path, orig, owner); return row(ctx, owner, label, t(rec.path), 'restore', 'original from backup'); }
        ctx.vfs.del(rec.path, owner);
        return row(ctx, owner, label, t(rec.path), 'delete');
      }
      case 'block': {
        const cur = ctx.vfs.get(rec.path);
        if (!cur) return row(ctx, owner, label, t(rec.path), 'unchanged', 'file gone');
        const text = cur.toString('utf8');
        const next = removeBlock(text, rec);
        if (next === text) return row(ctx, owner, label, t(rec.path), 'unchanged', `block ${rec.id} not found`);
        if (rec.created && !next.trim()) { ctx.vfs.del(rec.path, owner); return row(ctx, owner, label, t(rec.path), 'delete', `block ${rec.id}`); }
        ctx.vfs.set(rec.path, next, owner);
        return row(ctx, owner, label, t(rec.path), 'update', `remove block ${rec.id}`);
      }
      case 'json': {
        const cur = ctx.vfs.get(rec.path);
        if (!cur) return row(ctx, owner, label, t(rec.path), 'unchanged', 'file gone');
        const tgt = readJsonTarget(cur, t(rec.path));
        const before = clone(tgt.obj);
        reverseOps(tgt.obj, rec.ops || [], (m) => ctx.warnings.push(`${t(rec.path)}: ${m}`));
        if (rec.created && Object.keys(tgt.obj).length === 0) { ctx.vfs.del(rec.path, owner); return row(ctx, owner, label, t(rec.path), 'delete'); }
        if (deq(before, tgt.obj)) return row(ctx, owner, label, t(rec.path), 'unchanged', 'nothing to remove');
        ctx.vfs.set(rec.path, jsonOut(tgt.obj, tgt.indent, tgt.eol), owner);
        return row(ctx, owner, label, t(rec.path), 'update', 'remove merged keys');
      }
      case 'npm': {
        const nm = `${rec.dir}/node_modules`;
        if (rec.createdNodeModules && statOrNull(nm)) {
          ctx.execs.push({ kind: 'rmrf', path: nm, owner, label: `remove ${t(nm)}` });
          return row(ctx, owner, label, t(nm), 'delete', 'node_modules');
        }
        return undefined;
      }
      default: return undefined;
    }
  } catch (e) {
    ctx.failed = true;
    row(ctx, owner, label, t(rec.path || rec.dir || ''), 'error', e.message);
    return undefined;
  }
}

// ---------------------------------------------------------------- apply
function mkdirp(dir, ctx) {
  // Collect missing ancestors first (mkdirSync's return value is not portable: Node 25 on Windows prefixes \\?\).
  const missing = [];
  for (let d = absPath(dir); !statOrNull(d); d = absPath(path.dirname(d))) {
    missing.push(d);
    if (absPath(path.dirname(d)) === d) break;
  }
  fs.mkdirSync(dir, { recursive: true });
  missing.forEach((d) => ctx.createdDirs.add(d));
}
// Write via a temp file in the same directory and rename over the target. Windows can refuse the rename
// while another process (antivirus, an editor, the tool itself) holds the file: retry briefly (EPERM/EBUSY/EACCES).
function atomicWrite(p, data) {
  const tmp = `${p}.llm-config-tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, p); return; } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}
// Always-loaded instruction files have hard or practical limits; warn before a tool silently truncates them.
// Codex stops reading project docs at 32 KiB combined (project_doc_max_bytes); Devin Desktop global rules cap at 6,000 chars.
const BUDGETS = [
  { re: /\/\.codex\/AGENTS(\.override)?\.md$/i, max: 16 * 1024, why: 'Codex reads at most 32 KiB of AGENTS.md (global + project combined)' },
  { re: /\/windsurf\/memories\/global_rules\.md$/i, max: 6000, why: 'Devin Desktop truncates global rules at 6,000 characters' },
  { re: /\/(CLAUDE|AGENTS|GEMINI|copilot-instructions)\.md$/i, max: 24 * 1024, why: 'loaded into every session' },
];
function checkBudgets(changes, ctx) {
  for (const ch of changes) {
    if (!ch.after) continue;
    const b = BUDGETS.find((x) => x.re.test(fwd(ch.path)));
    if (b && ch.after.length > b.max) ctx.warnings.push(`${tildeOf(ctx)(ch.path)} will be ${ch.after.length} bytes (> ${b.max}): ${b.why}`);
  }
}
function backupFile(ctx, p, data) {
  const k = keyOf(p);
  if (ctx.backedUp.has(k)) return;
  const b = backupPathFor(ctx, p);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.writeFileSync(b, data);
  ctx.backedUp.add(k);
}
function applyAll(ctx) {
  const changes = ctx.vfs.changes();
  for (const ch of changes) {
    try {
      if (ch.before) backupFile(ctx, ch.path, ch.before);
      if (ch.after === null) fs.rmSync(ch.path, { force: true });
      else {
        mkdirp(path.dirname(ch.path), ctx);
        atomicWrite(ch.path, ch.after);
        if (!IS_WIN && ch.mode !== undefined && (ch.mode & 0o111)) fs.chmodSync(ch.path, 0o755);
      }
      ch.ok = true;
    } catch (e) { ch.error = e.message; ctx.failed = true; }
  }
  for (const ex of ctx.execs) {
    try {
      if (ex.kind === 'chmod') {
        fs.chmodSync(ex.path, ex.mode);
        ex.rec.observed = fs.statSync(ex.path).mode & 0o7777;
      } else if (ex.kind === 'rmrf') {
        fs.rmSync(ex.path, { recursive: true, force: true });
      } else if (ex.kind === 'npm') {
        // npm is npm.cmd on Windows, which needs cmd.exe; call it directly instead of `shell: true` (DEP0190). Fixed args only.
        const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund'];
        const [cmd, args] = IS_WIN ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...npmArgs]] : ['npm', npmArgs];
        const r = spawnSync(cmd, args, { cwd: ex.dir, stdio: ctx.opts.verbose ? 'inherit' : 'pipe', encoding: 'utf8', windowsHide: true });
        if (r.error) throw r.error;
        if (r.status !== 0) throw new Error(`npm exited with ${r.status}: ${String(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
      }
      ex.ok = true;
    } catch (e) { ex.error = e.message; ctx.failed = true; }
  }
  return changes;
}

// ---------------------------------------------------------------- manifest
function loadManifest(p) {
  const empty = { version: MANIFEST_VERSION, components: {}, dirs: [] };
  const buf = readOrNull(p);
  if (!buf) return empty;
  try {
    const m = JSON.parse(buf.toString('utf8'));
    if (!isObj(m) || !isObj(m.components)) throw new Error('bad shape');
    m.dirs = Array.isArray(m.dirs) ? m.dirs : [];
    return m;
  } catch (e) { throw new Error(`cannot read ${p}: ${e.message}`); }
}
function writeManifest(p, m) {
  const text = JSON.stringify(m, null, 2) + '\n';
  if (readOrNull(p)?.toString('utf8') === text) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWrite(p, text);
  return true;
}

// ---------------------------------------------------------------- output
const STATUS_COLOR = { create: green, update: yellow, restore: yellow, delete: magenta, kept: yellow, unchanged: dim, skip: dim, error: red, run: cyan };
function printTable(rows, verbose) {
  const shown = verbose ? rows : rows.filter((r) => r.status !== 'unchanged' && r.status !== 'skip');
  const hidden = rows.length - shown.length;
  if (!shown.length) { if (hidden) console.log(dim(`  ${hidden} action(s) unchanged or skipped (use --verbose to list them)`)); return; }
  const cols = Math.max(60, process.stdout.columns || 100);
  const head = ['Component', 'Action', 'Target', 'Status'];
  const data = shown.map((r) => [r.comp, r.type, r.target, r.status, r.note || '']);
  const w = [0, 1, 2].map((i) => Math.max(head[i].length, ...data.map((d) => d[i].length)));
  w[2] = Math.min(w[2], Math.max(20, cols - w[0] - w[1] - 30));
  const cut = (s, n) => (s.length > n ? '~' + s.slice(s.length - n + 1) : s);
  console.log(bold(`  ${head[0].padEnd(w[0])}  ${head[1].padEnd(w[1])}  ${head[2].padEnd(w[2])}  ${head[3]}`));
  for (const d of data) {
    const st = (STATUS_COLOR[d[3]] || ((s) => s))(d[3]);
    console.log(`  ${d[0].padEnd(w[0])}  ${d[1].padEnd(w[1])}  ${cut(d[2], w[2]).padEnd(w[2])}  ${st}${d[4] ? dim(' ' + d[4]) : ''}`);
  }
  if (hidden) console.log(dim(`  ${hidden} more action(s) unchanged or skipped (use --verbose to list them)`));
}

// Line diff: trim common prefix/suffix, LCS on the middle (falls back to replace-all when huge).
function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const mid = [];
  const n = A.length, m = B.length;
  if (n * m > 4e6) { A.forEach((s) => mid.push({ t: '-', s })); B.forEach((s) => mid.push({ t: '+', s })); }
  else {
    const W = m + 1, dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { mid.push({ t: ' ', s: A[i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) mid.push({ t: '-', s: A[i++] });
      else mid.push({ t: '+', s: B[j++] });
    }
    while (i < n) mid.push({ t: '-', s: A[i++] });
    while (j < m) mid.push({ t: '+', s: B[j++] });
  }
  return [...a.slice(0, pre).map((s) => ({ t: ' ', s })), ...mid, ...a.slice(a.length - suf).map((s) => ({ t: ' ', s }))];
}
function splitLines(text) { if (text === '') return []; const l = text.replace(/\r\n/g, '\n').split('\n'); if (l[l.length - 1] === '') l.pop(); return l; }
export function unifiedDiff(oldText, newText, oldName, newName, context = 3) {
  const ops = lineDiff(splitLines(oldText), splitLines(newText));
  let o = 0, n = 0;
  for (const op of ops) { op.o = o + 1; op.n = n + 1; if (op.t !== '+') o++; if (op.t !== '-') n++; }
  const idx = ops.map((op, i) => (op.t !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return [];
  const hunks = [];
  let s = Math.max(0, idx[0] - context), e = Math.min(ops.length, idx[0] + context + 1);
  for (const c of idx.slice(1)) {
    if (c - context <= e) e = Math.min(ops.length, c + context + 1);
    else { hunks.push([s, e]); s = Math.max(0, c - context); e = Math.min(ops.length, c + context + 1); }
  }
  hunks.push([s, e]);
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  for (const [hs, he] of hunks) {
    const part = ops.slice(hs, he);
    const oc = part.filter((x) => x.t !== '+').length, nc = part.filter((x) => x.t !== '-').length;
    const os_ = oc ? part.find((x) => x.t !== '+').o : part[0].o - 1;
    const ns_ = nc ? part.find((x) => x.t !== '-').n : part[0].n - 1;
    out.push(`@@ -${os_},${oc} +${ns_},${nc} @@`);
    for (const x of part) out.push(x.t + x.s);
  }
  return out;
}
function printDiffs(changes, ctx) {
  const t = tildeOf(ctx);
  const LIMIT = 400;
  for (const ch of changes) {
    console.log('');
    console.log(bold(`${ch.kind === 'create' ? '+ new file' : ch.kind === 'delete' ? '- delete' : '~ modify'}  ${t(ch.path)}`) + dim(`  [${ch.owner}]`));
    const before = ch.before, after = ch.after;
    if ((before && isBinary(before)) || (after && isBinary(after))) { console.log(dim(`  binary file (${after ? after.length : 0} bytes)`)); continue; }
    const lines = unifiedDiff(before ? before.toString('utf8') : '', after ? after.toString('utf8') : '', before ? `a/${t(ch.path)}` : '/dev/null', after ? `b/${t(ch.path)}` : '/dev/null');
    const shown = ctx.opts.verbose ? lines : lines.slice(0, LIMIT);
    for (const l of shown) {
      if (l.startsWith('+++') || l.startsWith('---')) console.log(bold(l));
      else if (l.startsWith('@@')) console.log(cyan(l));
      else if (l[0] === '+') console.log(green(l));
      else if (l[0] === '-') console.log(red(l));
      else console.log(l);
    }
    if (shown.length < lines.length) console.log(dim(`  ... ${lines.length - shown.length} more diff lines (use --verbose)`));
  }
  for (const ex of ctx.execs) console.log('\n' + cyan(`$ would run: ${ex.label}`));
}
function printWarnings(ctx) {
  for (const w of [...new Set(ctx.warnings)]) console.log(yellow(`warning: ${w}`));
}
function printApplied(changes, ctx) {
  const t = tildeOf(ctx);
  const ok = changes.filter((c) => c.ok), bad = changes.filter((c) => c.error);
  if (ok.length || ctx.execs.some((e) => e.ok)) {
    console.log('\n' + bold('Changed:'));
    for (const c of ok) console.log(`  ${c.kind === 'create' ? green('+') : c.kind === 'delete' ? magenta('-') : yellow('~')} ${t(c.path)}`);
    for (const e of ctx.execs.filter((x) => x.ok)) console.log(`  ${cyan('$')} ${e.label}`);
  }
  for (const c of bad) console.log(red(`  failed to write ${t(c.path)}: ${c.error}`));
  for (const e of ctx.execs.filter((x) => x.error)) console.log(red(`  failed: ${e.label}: ${e.error}`));
  if (ctx.backedUp.size) console.log(`\nBackups: ${t(ctx.backupDir)}`);
}

// ---------------------------------------------------------------- API keys
// Component field "apiKey": { name, env, configFile (relative to $XDG_CONFIG_HOME or ~/.config), prefix?, url?, checkUrl? }.
// The key is looked up like the tool does it: env var, then the key file, then (Windows) the user environment in the registry.
// A pasted key is never echoed, logged, backed up or recorded in the manifest; it is written once, after the install is confirmed.
function apiKeyFile(k, vars, opts) {
  const base = (!opts.home && process.env.XDG_CONFIG_HOME?.trim()) || `${vars.HOME}/.config`;
  return absPath(`${base}/${k.configFile}`);
}
function apiKeyPresent(k, file, opts) {
  if (!opts.home && process.env[k.env]?.trim()) return true;
  try { if (fs.readFileSync(file, 'utf8').trim()) return true; } catch { /* missing */ }
  if (IS_WIN && !opts.home) {
    try {
      const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', k.env], { encoding: 'utf8', windowsHide: true }).stdout || '';
      if (new RegExp(`${k.env}\\s+REG_\\w+\\s+\\S`).test(out)) return true;
    } catch { /* not set */ }
  }
  return false;
}
async function checkApiKey(k, secret) {
  if (!k.checkUrl || typeof fetch !== 'function') return { state: 'unknown' };
  try {
    const r = await fetch(k.checkUrl, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { state: 'valid' };
    if (r.status === 401 || r.status === 403) return { state: 'invalid', status: r.status };
    return { state: 'unknown', why: `HTTP ${r.status}` };
  } catch (e) { return { state: 'unknown', why: e?.name === 'TimeoutError' ? 'timed out' : 'no connection' }; }
}
function readSecret(q) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(q);
    let buf = '';
    const finish = (v) => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
      stdout.write(v === null ? '\n' : dim(` (${v.length} characters)\n`));
      resolve(v);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk).replace(/\x1b\[20[01]~/g, '')) {
        // Windows sends Enter as \r\n: the menu prompt ends at \r and the \n arrives here first. A newline
        // before any character is not an answer; an empty paste is cancelled with Ctrl-C instead.
        if (ch === '\r' || ch === '\n') { if (!buf.trim()) continue; return finish(buf.trim()); }
        if (ch === '\u0003') return finish(null);
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch >= ' ') buf += ch;
      }
    };
    try { stdin.setRawMode(true); } catch { stdout.write('\n'); return resolve(null); }
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}
function savePendingKeys(ctx) {
  const t = tildeOf(ctx);
  for (const k of ctx.pendingKeys.splice(0)) {
    try { saveSecret(k.file, k.secret); console.log(green(`Saved your ${k.name} to ${t(k.file)} (readable only by you).`)); }
    catch (e) { ctx.failed = true; console.log(red(`failed to save the ${k.name} to ${t(k.file)}: ${e.message}`)); }
  }
}
function saveSecret(file, secret) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.llm-config-tmp-${process.pid}`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  if (!IS_WIN) fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
// Returns 'ok' (key present, pasted, or left for later), 'skip' (do not install the component) or 'abort'.
async function handleApiKey(c, vars, opts, prompts, ctx) {
  const k = c.apiKey;
  const t = tildeOf(ctx);
  const file = apiKeyFile(k, vars, opts);
  if (apiKeyPresent(k, file, opts)) return 'ok';
  const later = `${c.id}: no ${k.name} yet, so it stays inactive until you set ${k.env} or put the key in ${t(file)}`;
  if (opts.dryRun) { ctx.warnings.push(`${c.id}: no ${k.name} found (${k.env} or ${t(file)}); a real install asks how to handle it`); return 'ok'; }
  if (!prompts.interactive) { ctx.warnings.push(later); return 'ok'; }
  console.log('\n' + bold(`${c.title} needs your ${k.name}`) + ` (${k.env}), and none was found.` + (k.url ? dim(`  Get one at ${k.url}`) : ''));
  console.log(`  1) Paste it now: saved to ${t(file)}, readable only by you (input is hidden)`);
  console.log(`  2) Add it later: install now; ${c.id} stays inactive until the key exists`);
  console.log(`  3) Skip ${c.id}: do not install it this time`);
  for (;;) {
    const a = await ask('Choice [1/2/3, Enter = 2]: ');
    if (a === null) return 'abort';
    const v = a.trim();
    if (v === '' || v === '2') {
      ctx.warnings.push(later);
      return 'ok';
    }
    if (v === '3') return 'skip';
    if (v !== '1') {
      // A key pasted here was echoed: say so instead of only rejecting the answer.
      if (v.length >= 16 || (k.prefix && v.startsWith(k.prefix))) console.log(red(`That looks like a key, and this prompt showed it on screen. Choose 1 to paste it hidden; if others could see your screen, replace the key${k.url ? ` (${k.url})` : ''}.`));
      else console.log(red('Type 1, 2 or 3.'));
      continue;
    }
    if (!prompts.raw) { console.log(yellow('Hidden input needs a real terminal here. Choose 2 and write the key file yourself (see the README).')); continue; }
    const secret = await readSecret(`Paste your ${k.name}, then press Enter (Ctrl-C to go back): `);
    if (!secret) continue;
    if (/\s/.test(secret)) { console.log(red('That contains spaces, so it is not a key. Try again.')); continue; }
    if (k.prefix && !secret.startsWith(k.prefix) && !(await confirm(yellow(`${k.name}s start with "${k.prefix}" and this one does not. Use it anyway?`)))) continue;
    process.stdout.write(dim('Checking the key... '));
    const chk = await checkApiKey(k, secret);
    if (chk.state === 'invalid') { console.log(red(`rejected (HTTP ${chk.status}). Paste another key, or choose 2 or 3.`)); continue; }
    console.log(chk.state === 'valid' ? green('accepted.') : yellow(`not checked (${chk.why || 'no check available'}); it will be saved as entered.`));
    ctx.pendingKeys.push({ file, secret, name: k.name });
    return 'ok';
  }
}

// ---------------------------------------------------------------- prompts
function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    rl.question(q, (a) => { done = true; rl.close(); resolve(a); });
    rl.on('close', () => { if (!done) resolve(null); });
  });
}
async function confirm(q) {
  const a = await ask(`${q} [Y/n] `);
  if (a === null) return false;
  return !/^\s*n/i.test(a);
}
function tagsFor(c, inf, eff, chosen, comps) {
  const tags = [];
  if (inf.detected === true) tags.push(green('detected'));
  else if (inf.detected === false) tags.push(dim('not detected'));
  if (c.local) tags.push(magenta('local'));
  else if (c.localOverlay) tags.push(magenta('+local'));
  if (inf.installed) tags.push(blue('installed'));
  if (!inf.supported) tags.push(yellow(`not for ${process.platform}`));
  if (inf.missingBins.length) tags.push(yellow(`needs ${inf.missingBins.join(', ')}`));
  if (eff.has(c.id) && !chosen.has(c.id)) {
    const by = [...eff].filter((x) => comps.get(x)?.requires.includes(c.id));
    if (by.length) tags.push(dim(`required by ${by.join(', ')}`));
  }
  return tags.join(' ');
}
async function pickPlain(items, initial, info, comps) {
  let lastGroup = null;
  console.log(bold('Components:'));
  items.forEach((c, i) => {
    if (c.group !== lastGroup) { console.log(cyan(`\n${GROUP_LABEL[c.group] || c.group}`)); lastGroup = c.group; }
    const inf = info.get(c.id);
    const box = !inf.supported ? '[-]' : initial.has(c.id) ? '[x]' : '[ ]';
    console.log(`  ${String(i + 1).padStart(2)}. ${box} ${c.title} (${c.id}) ${tagsFor(c, inf, closure(initial, comps), initial, comps)}`);
    if (c.description) console.log(dim(`        ${c.description}`));
  });
  for (;;) {
    const ans = await ask('\nComponents to install (numbers or ids, comma separated; "a" = all; Enter = keep [x]; "q" = quit): ');
    if (ans === null || /^\s*q/i.test(ans)) return null;
    if (!ans.trim()) return new Set(initial);
    if (ans.trim().toLowerCase() === 'a') return new Set(items.filter((c) => info.get(c.id).supported).map((c) => c.id));
    const out = new Set(); const bad = [];
    for (const tok of splitList(ans)) {
      const n = Number(tok);
      const c = Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : comps.get(tok);
      if (!c || !info.get(c.id).supported) bad.push(tok); else out.add(c.id);
    }
    if (bad.length) { console.log(red(`not available: ${bad.join(', ')}`)); continue; }
    return out;
  }
}
function pickInteractive(items, initial, info, comps) {
  const stdin = process.stdin, out = process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return pickPlain(items, initial, info, comps);
  try { stdin.setRawMode(true); } catch { return pickPlain(items, initial, info, comps); }
  readline.emitKeypressEvents(stdin);
  return new Promise((resolve) => {
    const chosen = new Set(initial);
    let cur = 0, drawn = 0;
    const draw = () => {
      const eff = closure(chosen, comps);
      const width = Math.max(40, (out.columns || 80) - 1);
      const rows = out.rows || 40;
      const groups = new Set(items.map((c) => c.group)).size;
      const inline = items.length * 2 + groups * 2 + 6 < rows;
      const lines = [bold('Select components to install'), dim('up/down move  space toggle  a all  enter confirm  q quit')];
      let lastGroup = null;
      items.forEach((c, i) => {
        if (c.group !== lastGroup) { lines.push(''); lines.push(cyan(bold(GROUP_LABEL[c.group] || c.group))); lastGroup = c.group; }
        const inf = info.get(c.id);
        const ptr = i === cur ? cyan('>') : ' ';
        const box = !inf.supported ? dim('[-]') : chosen.has(c.id) ? green('[x]') : eff.has(c.id) ? green('[+]') : '[ ]';
        const title = i === cur ? bold(c.title) : c.title;
        lines.push(`${ptr} ${box} ${title} ${dim(`(${c.id})`)} ${tagsFor(c, inf, eff, chosen, comps)}`);
        if (inline && c.description) lines.push(`      ${dim(c.description)}`);
      });
      lines.push('');
      if (!inline) lines.push(dim(items[cur].description || ''));
      lines.push(`${[...eff].filter((id) => info.get(id)?.supported).length} selected`);
      const prefix = drawn ? `\x1b[${drawn}A\r\x1b[J` : '';
      out.write(prefix + lines.map((l) => truncAnsi(l, width)).join('\n') + '\n');
      drawn = lines.length;
    };
    const finish = (v) => {
      stdin.removeListener('keypress', onKey);
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
      out.write('\x1b[?25h');
      resolve(v);
    };
    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(null);
      switch (key.name) {
        case 'up': case 'k': cur = (cur - 1 + items.length) % items.length; break;
        case 'down': case 'j': case 'tab': cur = (cur + 1) % items.length; break;
        case 'space': {
          const id = items[cur].id;
          if (info.get(id).supported) { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); }
          break;
        }
        case 'a': {
          const all = items.filter((c) => info.get(c.id).supported).map((c) => c.id);
          if (all.every((id) => chosen.has(id))) chosen.clear(); else all.forEach((id) => chosen.add(id));
          break;
        }
        case 'return': case 'enter': return finish(chosen);
        case 'q': case 'escape': return finish(null);
        default: return undefined;
      }
      draw();
      return undefined;
    };
    out.write('\x1b[?25l');
    draw();
    stdin.on('keypress', onKey);
    stdin.resume();
  });
}

// ---------------------------------------------------------------- commands
function printList(comps, info) {
  let lastGroup = null;
  for (const c of sortedComps(comps)) {
    if (c.group !== lastGroup) { console.log(cyan(bold(`\n${GROUP_LABEL[c.group] || c.group}`))); lastGroup = c.group; }
    const inf = info.get(c.id);
    const def = c.default === true ? 'default' : c.default === 'detect' ? 'default if detected' : '';
    console.log(`  ${bold(c.id.padEnd(12))} ${c.title} ${dim(def)} ${tagsFor(c, inf, new Set(), new Set(), comps)}`);
    if (c.description) console.log(dim(`  ${''.padEnd(12)} ${c.description}`));
    if (c.requires.length) console.log(dim(`  ${''.padEnd(12)} requires: ${c.requires.join(', ')}`));
  }
}

async function runInstall(opts, comps, info, manifest, vars, root, prompts) {
  const ctx = makeCtx(opts, vars, root);
  const t = tildeOf(ctx);
  let chosen;
  if (opts.update) {
    const installed = Object.keys(manifest.components);
    if (!installed.length) { console.error(red('error: nothing is installed yet, so there is nothing to update. Run the installer without --update first.')); return 2; }
    const gone = installed.filter((id) => !comps.has(id));
    if (gone.length) ctx.warnings.push(`no longer in this checkout, left as installed: ${gone.join(', ')} (remove with --uninstall ${gone.join(',')})`);
    chosen = new Set(installed.filter((id) => comps.has(id)));
  } else if (opts.components) {
    const unknown = opts.components.filter((id) => !comps.has(id));
    if (unknown.length) { console.error(red(`error: unknown component(s): ${unknown.join(', ')} (see --list)`)); return 2; }
    chosen = new Set(opts.components);
  } else if (opts.all) {
    chosen = new Set([...comps.values()].filter((c) => info.get(c.id).supported).map((c) => c.id));
  } else {
    const initial = defaultSelection(comps, info);
    if (prompts.interactive) {
      chosen = prompts.raw ? await pickInteractive(sortedComps(comps), initial, info, comps) : await pickPlain(sortedComps(comps), initial, info, comps);
      if (!chosen) { console.log('Aborted.'); return 130; }
    } else chosen = initial;
  }
  if (!chosen.size) { console.log('Nothing selected.'); return 0; }

  const all = closure(chosen, comps);
  // replaces: a selected component (typically a local overlay) stands in for another one.
  for (const id of [...all]) for (const r of comps.get(id)?.replaces || []) if (all.delete(r)) ctx.warnings.push(`${r} not installed: replaced by ${id}`);
  const final = [];
  for (const id of topoOrder(all, comps)) {
    const c = comps.get(id);
    if (!c) { ctx.warnings.push(`a selected component requires "${id}", which does not exist`); continue; }
    const inf = info.get(id);
    if (!inf.supported) { row(ctx, id, 'component', '', 'skip', `not available on ${process.platform}`); continue; }
    if (inf.missingBins.length) { ctx.warnings.push(`${id}: skipped, missing ${inf.missingBins.join(', ')} on PATH`); row(ctx, id, 'component', '', 'skip', `missing ${inf.missingBins.join(', ')}`); continue; }
    final.push(c);
  }
  // A component that needs an API key: if none is found, ask how to handle it before anything is planned.
  for (const c of [...final]) {
    if (!c.apiKey || !final.includes(c)) continue;
    const res = await handleApiKey(c, vars, opts, prompts, ctx);
    if (res === 'abort') { console.log('Aborted.'); return 130; }
    if (res === 'skip') {
      const drop = new Set([c.id]);
      for (let grew = true; grew;) { grew = false; for (const d of final) if (!drop.has(d.id) && d.requires.some((r) => drop.has(r))) { drop.add(d.id); grew = true; } }
      for (const id of drop) final.splice(final.findIndex((x) => x.id === id), 1);
      ctx.warnings.push(`not installed (no ${c.apiKey.name}): ${[...drop].join(', ')}`);
    }
  }
  if (!final.length) { printWarnings(ctx); console.log('Nothing left to install.'); return 0; }
  const finalIds = new Set(final.map((c) => c.id));
  for (const c of final) for (const r of c.requires) if (!finalIds.has(r) && comps.has(r) && !manifest.components[r]) ctx.warnings.push(`${c.id} requires ${r}, which is not being installed`);
  ctx.whenSet = new Set([...finalIds, ...Object.keys(manifest.components)]);
  // omits: target paths (a file, or a folder ending in /) that no other selected component may copy to.
  ctx.omits = [];
  for (const c of final) for (const raw of c.omits) {
    try { ctx.omits.push({ path: targetPath(raw, ctx, 'omits'), dir: raw.endsWith('/'), by: c.id }); }
    catch (e) { ctx.warnings.push(`${c.id}: omits ${raw}: ${e.message}`); }
  }

  // Pass 1: which record keys does the new plan produce (to detect stale ones)?
  const keySets = new Map();
  {
    const probe = makeCtx({ ...opts, verbose: false }, vars, root);
    probe.whenSet = ctx.whenSet;
    probe.omits = ctx.omits;
    for (const c of final) {
      probe.oldRecords = new Map((manifest.components[c.id]?.records || []).map((r) => [r.key, r]));
      const r = planComponent(c, probe);
      keySets.set(c.id, { keys: new Set(r.records.map((x) => x.key)), hadError: r.hadError });
    }
  }
  // A file copied by several selected components belongs to the last one in plan order.
  ctx.shadow = new Map();
  for (const c of final) for (const k of keySets.get(c.id).keys) if (k.startsWith('copy:')) ctx.shadow.set(k, c.id);
  // Pass 2: real plan; stale records of each component are reversed first.
  const newComps = clone(manifest.components);
  for (const c of final) {
    const old = manifest.components[c.id];
    const { keys, hadError } = keySets.get(c.id);
    const kept = [];
    for (const r of old?.records || []) {
      if (keys.has(r.key)) continue;
      if (hadError) kept.push(r); else planReverse(r, ctx, c.id, 'remove (stale)');
    }
    ctx.oldRecords = new Map((old?.records || []).map((r) => [r.key, r]));
    const res = planComponent(c, ctx);
    newComps[c.id] = { title: c.title, installedAt: old?.installedAt || new Date().toISOString(), updatedAt: old?.updatedAt || null, records: [...res.records, ...kept] };
  }

  const changes = ctx.vfs.changes();
  checkBudgets(changes, ctx);
  console.log(bold(`\nllm-config ${opts.dryRun ? 'dry run' : 'install'}`) + dim(`  home: ${vars.HOME}`));
  console.log(dim(`components: ${final.map((c) => c.id).join(', ') || '(none)'}`));
  printTable(ctx.rows, opts.verbose);
  printWarnings(ctx);

  if (opts.dryRun) {
    const drift = changes.length + ctx.execs.length;
    if (opts.json) {
      JSON_OUT.write(JSON.stringify({ mode: opts.check ? 'check' : 'dry-run', home: vars.HOME, components: final.map((c) => c.id), drift: drift > 0,
        changes: changes.map((c) => ({ path: fwd(c.path), kind: c.kind, component: c.owner })), commands: ctx.execs.map((e) => ({ label: e.label, component: e.owner })),
        actions: ctx.rows, warnings: ctx.warnings, failed: ctx.failed }, null, 2) + '\n');
      return ctx.failed ? 1 : opts.check && drift ? 3 : 0;
    }
    if (opts.check) {
      console.log('\n' + (drift ? yellow(`Drift: ${changes.length} file change(s), ${ctx.execs.length} command(s) would be applied.`) : green('No drift: installed files match the repository.')));
      return ctx.failed ? 1 : drift ? 3 : 0;
    }
    printDiffs(changes, ctx);
    console.log('\n' + (changes.length || ctx.execs.length ? `Dry run: ${changes.length} file change(s), ${ctx.execs.length} command(s) planned. Nothing was written.` : 'Dry run: nothing to change.'));
    return ctx.failed ? 1 : 0;
  }
  const newManifest = { version: MANIFEST_VERSION, home: vars.HOME, source: fwd(root), components: newComps, dirs: manifest.dirs || [] };
  if (!changes.length && !ctx.execs.length) {
    const wrote = writeManifest(`${ctx.stateDir}/manifest.json`, newManifest);
    console.log('\n' + green('Nothing to change: everything is already up to date.') + (wrote ? dim(' (manifest refreshed)') : ''));
    savePendingKeys(ctx); // a key pasted for an already installed component still has to be saved
    printPost(final);
    return ctx.failed ? 1 : 0;
  }
  if (prompts.interactive && !(await confirm(`\nApply ${changes.length} file change(s) and ${ctx.execs.length} command(s)?`))) { console.log('Aborted.'); return 130; }

  const applied = applyAll(ctx);
  savePendingKeys(ctx);
  const now = new Date().toISOString();
  const touched = new Set([...applied.filter((c) => c.ok).map((c) => c.owner), ...ctx.execs.filter((e) => e.ok).map((e) => e.owner)]);
  for (const id of touched) if (newComps[id]) newComps[id].updatedAt = now;
  // Records for files that failed to be created are dropped so uninstall does not touch them.
  const failedCreates = new Set(applied.filter((c) => c.error && c.kind === 'create').map((c) => keyOf(c.path)));
  for (const c of Object.values(newComps)) c.records = c.records.filter((r) => !(r.path && failedCreates.has(keyOf(r.path)) && r.kind === 'copy'));
  newManifest.dirs = [...new Set([...(manifest.dirs || []), ...ctx.createdDirs])].sort();
  try { writeManifest(`${ctx.stateDir}/manifest.json`, newManifest); } catch (e) { ctx.failed = true; console.log(red(`failed to write manifest: ${e.message}`)); }

  printApplied(applied, ctx);
  console.log(`Manifest: ${t(ctx.stateDir + '/manifest.json')}`);
  printPost(final);
  console.log('\n' + bold('Open a new session of each tool (Claude Code, Codex, opencode, Gemini CLI) so it picks up the new configuration.'));
  if (ctx.failed) console.log(red(`\nSome actions failed (see above).`));
  return ctx.failed ? 1 : 0;
}
function printPost(final) {
  const notes = final.filter((c) => c.postInstall);
  if (!notes.length) return;
  console.log('\n' + bold('Notes:'));
  for (const c of notes) {
    const [first, ...rest] = c.postInstall.split('\n');
    console.log(`  ${cyan(c.id)}: ${first}`);
    for (const l of rest) console.log(`  ${''.padEnd(c.id.length)}  ${l}`);
  }
}

async function runUninstall(opts, comps, manifest, vars, root, prompts) {
  const ctx = makeCtx(opts, vars, root);
  const t = tildeOf(ctx);
  const installed = Object.keys(manifest.components);
  if (!installed.length) { console.log(`Nothing is installed (no components in ${t(ctx.stateDir + '/manifest.json')}).`); return 0; }
  let ids = opts.uninstallIds || installed;
  const notInstalled = ids.filter((id) => !manifest.components[id]);
  if (notInstalled.length) ctx.warnings.push(`not installed: ${notInstalled.join(', ')}`);
  ids = ids.filter((id) => manifest.components[id]);
  if (!ids.length) { printWarnings(ctx); return 0; }
  const removing = new Set(ids);
  for (const other of installed) {
    if (removing.has(other)) continue;
    const req = (comps.get(other)?.requires || []).filter((r) => removing.has(r));
    if (req.length) ctx.warnings.push(`${other} (still installed) requires ${req.join(', ')}`);
  }
  // Order: reverse install order (dependents first).
  const known = new Map([...comps].filter(([id]) => manifest.components[id]));
  for (const id of installed) if (!known.has(id)) known.set(id, { id, requires: [], group: 'extras' });
  const order = topoOrder(installed, known).filter((id) => removing.has(id)).reverse();
  const keepComps = clone(manifest.components);
  // Actions of remaining components that were conditional on a removed component.
  for (const other of installed) {
    if (removing.has(other)) continue;
    const recs = keepComps[other].records || [];
    const cond = recs.filter((r) => r.when && r.when.some((w) => removing.has(w)));
    for (const r of [...cond].reverse()) planReverse(r, ctx, other, `remove (when ${r.when.join(',')})`);
    keepComps[other].records = recs.filter((r) => !cond.includes(r));
  }
  for (const id of order) {
    for (const r of [...(manifest.components[id].records || [])].reverse()) planReverse(r, ctx, id, 'uninstall');
    delete keepComps[id];
  }
  const changes = ctx.vfs.changes();
  console.log(bold(`\nllm-config uninstall${opts.dryRun ? ' (dry run)' : ''}`) + dim(`  home: ${vars.HOME}`));
  console.log(dim(`components: ${order.join(', ')}`));
  printTable(ctx.rows, true);
  printWarnings(ctx);
  if (opts.dryRun) {
    printDiffs(changes, ctx);
    console.log(`\nDry run: ${changes.length} file change(s), ${ctx.execs.length} command(s) planned. Nothing was written.`);
    return ctx.failed ? 1 : 0;
  }
  if (prompts.interactive && !(await confirm(`\nUninstall ${order.join(', ')}?`))) { console.log('Aborted.'); return 130; }
  const applied = applyAll(ctx);
  const dirs = [...(manifest.dirs || [])].sort((a, b) => b.length - a.length);
  const left = [];
  for (const d of dirs) {
    try { fs.rmdirSync(d); } catch (e) { if (e.code !== 'ENOENT') left.push(d); }
  }
  const newManifest = { version: MANIFEST_VERSION, home: vars.HOME, ...(manifest.source ? { source: manifest.source } : {}), components: keepComps, dirs: left.sort() };
  try { writeManifest(`${ctx.stateDir}/manifest.json`, newManifest); } catch (e) { ctx.failed = true; console.log(red(`failed to write manifest: ${e.message}`)); }
  printApplied(applied, ctx);
  console.log('\n' + bold('Open a new session of each tool so it picks up the change.'));
  if (ctx.failed) console.log(red('\nSome actions failed (see above).'));
  return ctx.failed ? 1 : 0;
}

const JSON_OUT = process.stdout;
async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { console.error(`error: ${e.message}\nRun with --help for usage.`); return 2; }
    throw e;
  }
  const hintTTY = process.env.LLM_CONFIG_TTY === '1';
  const ttyOut = !!process.stdout.isTTY || hintTTY;
  useColor = opts.color !== false && !process.env.NO_COLOR && ttyOut;
  if (opts.help) { console.log(HELP); return 0; }
  const [maj] = process.versions.node.split('.').map(Number);
  if (maj < 18) { console.error(`error: Node.js >= 18 is required (found ${process.versions.node})`); return 1; }

  const root = absPath(opts.root || process.env.LLM_CONFIG_ROOT || path.join(SCRIPT_DIR, '..'));
  const vars = resolveVars(opts.home);
  const { comps, errors } = loadComponents(root);
  for (const e of errors) console.error(red(`error: ${e}`));
  let manifest;
  try { manifest = loadManifest(`${vars.HOME}/.llm-config/manifest.json`); } catch (e) { console.error(red(`error: ${e.message}`)); return 1; }
  const info = compInfo(comps, vars, manifest);

  if (opts.list) {
    if (!comps.size) console.log(`No components found under ${root}/components.`);
    printList(comps, info);
    return errors.length ? 1 : 0;
  }
  const canPrompt = (!!process.stdin.isTTY && !!process.stdout.isTTY) || hintTTY;
  const prompts = { interactive: canPrompt && !opts.yes && !opts.dryRun, raw: !!process.stdin.isTTY && !!process.stdout.isTTY };
  if (!canPrompt && !opts.yes && !opts.dryRun) {
    console.error('error: not running in a terminal, so no prompts are possible. Pass --yes (optionally with --components a,b or --all), or --dry-run.');
    return 2;
  }
  let code;
  if (opts.uninstall) code = await runUninstall(opts, comps, manifest, vars, root, prompts);
  else {
    if (!comps.size) { console.error(red(`error: no components found under ${root}/components`)); return 1; }
    code = await runInstall(opts, comps, info, manifest, vars, root, prompts);
  }
  return errors.length && code === 0 ? 1 : code;
}

const isMain = process.argv[1] && absPath(process.argv[1]) === absPath(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stdout.write('\x1b[?25h');
    console.error(`unexpected error: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}
