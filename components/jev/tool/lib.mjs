// Shared Jev (TypeSafe) client for the CLI and the tool adapters (Claude Code, Codex, opencode), routed through OpenRouter.
import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
// decisions.jsonl and the gate's once-per-tool-call markers; JEV_LOG_DIR moves them (tests use a temp dir).
export const LOG_DIR = process.env.JEV_LOG_DIR || join(HERE, 'logs');
// 1.14 is TypeSafe's preview build (docs.typesafe.ai/models); 1.13 is the stable one. Thresholds were tuned on 1.14.
export const DEFAULT_MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.14';
const FALLBACK_MODEL = process.env.JEV_FALLBACK_MODEL || 'typesafe/jev-1.13';
const MAX_STATE_CHARS = 60000;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // decisions.jsonl rotates to decisions.1.jsonl (one generation)

// Hooks fail open, so their errors would vanish. They append here instead; claude-checks/hook-health.mjs reports them.
// Same path and format as logHookError in the claude-checks component.
export const HOOK_ERRORS = process.env.AGENTS_HOOK_ERRORS || join(homedir(), '.agents', 'cache', 'hook-errors.log');
export function logHookError(hook, e) {
  try {
    mkdirSync(dirname(HOOK_ERRORS), { recursive: true });
    try { if (statSync(HOOK_ERRORS).size > 256 << 10) writeFileSync(HOOK_ERRORS, readFileSync(HOOK_ERRORS, 'utf8').slice(-(128 << 10)).replace(/^[^\n]*\n/, '')); } catch { /* no log yet */ }
    appendFileSync(HOOK_ERRORS, JSON.stringify({ t: new Date().toISOString(), hook, err: String(e?.stack || e).split('\n').slice(0, 3).join(' | ') }) + '\n');
  } catch { /* nowhere to report */ }
}

// Opt-out shared by every adapter: env JEV_HOOK=0, or a marker file .agents/jev-off or .claude/jev-off in the project.
export function optedOut(cwd) {
  if (process.env.JEV_HOOK === '0') return true;
  if (!cwd) return false;
  return existsSync(join(cwd, '.agents', 'jev-off')) || existsSync(join(cwd, '.claude', 'jev-off'));
}

export function keyFilePath() {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'jev', 'key');
}

let keyWarned = false;
function readKeyFile() {
  const p = keyFilePath();
  try {
    const k = readFileSync(p, 'utf8').trim();
    if (!k) return null;
    if (process.platform !== 'win32' && !keyWarned) {
      try {
        if (statSync(p).mode & 0o077) { keyWarned = true; process.stderr.write(`jev: ${p} is readable by group/others; run: chmod 600 ${p}\n`); }
      } catch { /* ignore */ }
    }
    return k;
  } catch { return null; }
}

// Key lookup order: env OPENROUTER_API_KEY -> key file ($XDG_CONFIG_HOME/jev/key or ~/.config/jev/key) -> Windows registry.
export function apiKey() {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  const fromFile = readKeyFile();
  if (fromFile) return fromFile;
  // A user-scope variable set after Claude Code started is not inherited; read it from the registry.
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'OPENROUTER_API_KEY'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const m = out.match(/OPENROUTER_API_KEY\s+REG_\w+\s+(\S+)/);
      if (m) return m[1];
    } catch { /* not set */ }
  }
  return null;
}

// Strip obvious secrets before the text leaves the machine. Redact BEFORE truncating, or a cut can
// remove the prefix a pattern needs. B also matches after a JSON escape (\n, \t), where \b fails.
const B = String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))`;
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PEM]'],
  [new RegExp(B + String.raw`(?:sk|pk|rk)[-_][A-Za-z0-9_\-]{16,}`, 'g'), '[REDACTED_KEY]'],
  [new RegExp(B + String.raw`(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}`, 'g'), '[REDACTED_TOKEN]'],
  [new RegExp(B + String.raw`(?:glpat-[A-Za-z0-9_\-]{20,}|npm_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,})`, 'g'), '[REDACTED_TOKEN]'],
  [new RegExp(B + String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`, 'g'), '[REDACTED_AWS]'],
  [new RegExp(B + String.raw`eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`, 'g'), '[REDACTED_JWT]'],
  // user:password@ in any URL (postgres://, mongodb+srv://, https://)
  [/([a-z][a-z0-9+.\-]*:\/\/[^\s:\/@"'\\]+:)[^\s@\/"'\\]+@/gi, '$1[REDACTED]@'],
  [/((?:Authorization|Proxy-Authorization)\\?["']?\s*[:=]\s*\\?["']?\s*(?:Bearer|Basic|Token)?\s*)[^\s"'\\,}]+/gi, '$1[REDACTED]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+\/\-]{16,}=*/g, '$1[REDACTED]'],
  // NAME=value / "name": "value" for secret-like names, including JSON-escaped quotes (\")
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|_authToken)[A-Za-z0-9_]*\\?["']?\s*[:=]\s*\\?["']?)[^\s"'\\,}]{3,}/gi, '$1[REDACTED]'],
  // Long opaque blobs mixing letters and digits (bare keys of unknown format)
  [new RegExp(B + String.raw`(?=[A-Za-z0-9_\-+=]*[0-9])(?=[A-Za-z0-9_\-+=]*[A-Za-z])[A-Za-z0-9_\-+=]{48,}`, 'g'), '[REDACTED_BLOB]'],
];
export function redact(text) {
  let s = String(text);
  for (const [re, to] of SECRET_PATTERNS) s = s.replace(re, to);
  return s;
}

// Redact string leaves before JSON.stringify, so escapes cannot hide a secret from the patterns.
function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

function prepState(state) {
  let s = typeof state === 'string' ? redact(state) : JSON.stringify(redactDeep(state));
  s = redact(s);
  if (s.length > MAX_STATE_CHARS) s = s.slice(0, MAX_STATE_CHARS / 2) + '\n…[truncated]…\n' + s.slice(-MAX_STATE_CHARS / 2);
  return s;
}

export function log(entry) {
  try {
    const dir = LOG_DIR;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'decisions.jsonl');
    try { if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, join(dir, 'decisions.1.jsonl')); } catch { /* no log yet */ }
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging never breaks a decision */ }
}

// Flatten each answer to the fields a caller actually branches on.
function summarize(answers) {
  const s = {};
  for (const [k, a] of Object.entries(answers)) {
    if (a.type === 'noul') s[k] = { yes: a.noul >= 0.5, p: +a.noul.toFixed(3) };
    else if (a.type === 'choice') s[k] = { choice: a.choice, confidence: +a.confidence.toFixed(3), probabilities: a.probabilities };
    else if (a.type === 'score') s[k] = { score: +a.score.toFixed(2), confidence: +a.confidence.toFixed(3) };
    else s[k] = a;
  }
  return s;
}

// The API rejects a choice/score question without `instructions` (400 at questions.<name>.instructions)
// even though the SDK types mark it optional, so fill a neutral default.
function normalize(questions) {
  const q = {};
  for (const [k, v] of Object.entries(questions)) {
    q[k] = v.instructions == null && v.type !== 'noul'
      ? { ...v, instructions: v.type === 'choice' ? 'Which option best fits the state?' : 'Rate the state on this rubric.' }
      : v;
  }
  return q;
}

export function presets() {
  return JSON.parse(readFileSync(join(HERE, 'presets.json'), 'utf8'));
}

// Never throws. Returns {ok:true, model, ms, answers, usage} or {ok:false, model, ms, error}.
// `timeout` is per attempt; `deadline` (epoch ms) caps the call including the fallback attempt,
// so a hook finishes inside its own timeout instead of being killed by Claude Code.
export async function decide({ state, questions, model }, { label = 'ask', timeout = Number(process.env.JEV_TIMEOUT_MS) || 10000, retries = 1, deadline = Infinity } = {}) {
  const useModel = model || DEFAULT_MODEL;
  // Test seams: JEV_OFFLINE=1 never touches the network; JEV_TEST_ANSWERS (JSON of summarized answers) fakes a reply.
  if (process.env.JEV_TEST_ANSWERS) {
    try { return { ok: true, model: 'test', ms: 0, answers: JSON.parse(process.env.JEV_TEST_ANSWERS), usage: null }; }
    catch (e) { return { ok: false, model: 'test', ms: 0, error: { message: 'bad JEV_TEST_ANSWERS: ' + e.message } }; }
  }
  if (process.env.JEV_OFFLINE === '1') return { ok: false, model: useModel, ms: 0, error: { message: 'JEV_OFFLINE=1' } };
  // Bun (opencode's plugin runtime) marks a response body used once the SDK takes a reader on it, so every
  // call fails with "Body already used". Run the call in Node instead; the child writes the log line.
  if (process.versions.bun && !process.env.JEV_IN_CHILD) return decideInNode({ state, questions, model }, { label, timeout, retries, deadline });
  const key = apiKey();
  if (!key) return { ok: false, model: useModel, ms: 0, error: { message: 'no API key: set OPENROUTER_API_KEY or write it to ' + keyFilePath() } };
  const sent = prepState(state);
  const t0 = Date.now();
  const left = () => Math.min(timeout, deadline - Date.now());
  try {
    // Imported lazily so the parsers and adapters load (and fail open) even before npm install.
    const { TypeSafeClient } = await import('@typesafe-ai/sdk');
    const client = m => new TypeSafeClient({ apiKey: key, baseURL: 'https://openrouter.ai/api', compression: false, timeout: Math.max(1, left()), retry: { maxRetries: retries }, logLevel: 'off' })
      .systemOne({ model: m, state: sent, questions: normalize(questions) });
    if (left() < 500) throw new Error('no time left before the hook deadline');
    let r;
    try { r = await client(useModel); } catch (e) {
      // A preview model can be withdrawn; retry once on the stable build unless the key or request is at fault.
      // OpenRouter answers a withdrawn model with 400 "Model ... does not exist".
      const gone = e?.status === 404 || /does not exist|not found/i.test(String(e?.message));
      if (useModel === FALLBACK_MODEL || (!gone && [400, 401, 402, 403].includes(e?.status)) || Date.now() - t0 > timeout * 0.6 || left() < 1500) throw e;
      r = await client(FALLBACK_MODEL);
    }
    const ms = Date.now() - t0;
    const answers = summarize(r.answers);
    log({ label, model: r.model, ms, state_sha: createHash('sha256').update(sent).digest('hex').slice(0, 16), state_len: sent.length, answers, usage: r.usage, cwd: process.cwd() });
    return { ok: true, model: r.model, ms, answers, usage: r.usage };
  } catch (e) {
    const ms = Date.now() - t0;
    const body = e?.body === undefined ? undefined : JSON.stringify(e.body?.error ?? e.body).slice(0, 2000);
    const error = { name: e?.name, status: e?.status, message: String(e?.message || e).split('\n')[0].slice(0, 300), body };
    log({ label, model: useModel, ms, error });
    return { ok: false, model: useModel, ms, error };
  }
}

function decideInNode(args, opts) {
  const t0 = Date.now();
  const fail = (message) => ({ ok: false, model: args.model || DEFAULT_MODEL, ms: Date.now() - t0, error: { message } });
  const budget = Math.max(500, Math.min(opts.timeout * 2 + 1000, (Number.isFinite(opts.deadline) ? opts.deadline : Infinity) - Date.now()));
  return new Promise((done) => {
    let child;
    try {
      child = execFile(process.env.JEV_NODE || 'node', [join(HERE, 'decide-cli.mjs')],
        { timeout: budget, maxBuffer: 1 << 20, windowsHide: true, env: { ...process.env, JEV_IN_CHILD: '1' } },
        (err, stdout) => {
          if (err) return done(fail('node child failed: ' + String(err.message).split('\n')[0].slice(0, 200)));
          try { done(JSON.parse(stdout)); } catch { done(fail('node child returned no JSON')); }
        });
    } catch (e) { return done(fail('cannot start node: ' + e.message)); }
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ args, opts: { ...opts, deadline: Number.isFinite(opts.deadline) ? opts.deadline : null } }));
  });
}

export async function runPreset(name, state, opts = {}) {
  const p = presets()[name];
  if (!p) return { ok: false, error: { message: `unknown preset "${name}"`, presets: Object.keys(presets()) } };
  return decide({ state, questions: p.questions, model: p.model }, { label: 'preset:' + name, ...opts });
}
