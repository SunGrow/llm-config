#!/usr/bin/env node
// Claude Code PreToolUse hook for the Agent tool: make the subagent model a deliberate choice.
// 1. No model and the agent type has none of its own: deny once and ask for one (the call would inherit the
//    session's model, usually the most expensive one).
// 2. Jev's model_tier preset classifies the brief by kind of work, and ROUTES gives that kind's model and effort.
//    A different model: deny once with the suggestion, up or down. Re-issuing the same call (same type and brief)
//    goes through, so Claude can keep the model.
// 3. The model fits and neither the call nor the agent definition sets effort: set the route's effort on the call.
// Fails open on any error. ROUTE_MIN 0.8: on 81 hand-labeled briefs (01.11, 73 real, 8 written for image reading,
// hard code and 3D) the route agreed with the label on 74 overall and 48 of 54 at >= 0.8; of 40 real calls with a
// known model it pushed back on 6, none of them labeled as fitting the model they ran on.
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { runPreset, optedOut, LOG_DIR, logHookError } from './lib.mjs';

export const ROUTE_MIN = 0.8;
// Evidence per route, with sources and what is unmeasured: bench/model-routing.md
export const ROUTES = {
  recipe: { model: 'haiku', effort: 'high' },
  research: { model: 'sonnet', effort: 'high' },
  code: { model: 'sonnet', effort: 'high' },
  hard_code: { model: 'opus', effort: 'medium' },
  build_3d: { model: 'sonnet', effort: 'high' },
  visual: { model: 'sonnet', effort: 'high' },
  read_image_text: { model: 'opus', effort: 'low' },
  verify: { model: 'opus', effort: 'high' },
};
const ONCE_MS = 60 * 60e3;
// Built-in types without a model of their own: they run on the session's model.
const INHERITS = new Set(['general-purpose', 'Plan', 'claude']);
const SKIP = new Set(['fork']); // a fork always runs on the parent's model
const tier = (m) => /opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : /fable/i.test(m) ? 'fable' : '';

// An agent definition's text (project .claude/agents first, then the user's).
function definition(type, cwd, claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  for (const dir of [cwd && join(cwd, '.claude', 'agents'), join(claudeHome, 'agents')].filter(Boolean)) {
    const f = join(dir, type + '.md');
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  return null;
}

// Model from an agent definition's front matter.
export function definedModel(type, cwd, claudeHome) {
  const d = definition(type, cwd, claudeHome);
  if (d === null) return null;
  const m = d.match(/^---[\s\S]*?^model:\s*["']?([\w.-]+)/m);
  return m ? m[1] : 'inherit';
}

function definedEffort(type, cwd) {
  return /^---[\s\S]*?^effort:\s*["']?\w+/m.test(definition(type, cwd) || '');
}

// The session's own model: the newest assistant message in the transcript tail.
export function sessionModel(path) {
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size, len = Math.min(size, 1 << 20), buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].includes('"assistant"') && lines[i].match(/"model":"([^"]+)"/);
        if (m && !m[1].startsWith('<')) return m[1];
      }
    } finally { closeSync(fd); }
  } catch { /* no transcript */ }
  return null;
}

// True the first time this exact call is seen within the window.
export function firstTime(key) {
  try {
    const dir = join(LOG_DIR, 'agent-model-once');
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) { const p = join(dir, f); try { if (Date.now() - statSync(p).mtimeMs > ONCE_MS) unlinkSync(p); } catch { /* raced */ } }
    writeFileSync(join(dir, createHash('sha256').update(key).digest('hex').slice(0, 24)), '', { flag: 'wx' });
    return true;
  } catch (e) { return e?.code !== 'EEXIST'; }
}

// Returns { deny: reason }, { effort } to set on the call, or {} (allow as is).
export async function agentModelDecision(input, { deadline = Date.now() + 9000 } = {}) {
  const ti = input?.tool_input || {};
  const type = ti.subagent_type || 'general-purpose';
  if (SKIP.has(type) || optedOut(input?.cwd)) return {};
  const key = `${type}\n${ti.model || ''}\n${ti.prompt || ''}`;
  const defined = ti.model ? null : definedModel(type, input.cwd);
  if (!ti.model && (defined === 'inherit' || (!defined && INHERITS.has(type)))) {
    if (!firstTime('nomodel\n' + key)) return {};
    return { deny: `Agent model not set: this ${type} agent would run on the session's model. Re-issue the call with model: "haiku" (checklist or per-item recipe), "sonnet" (bounded step, investigation, research, implementation from a brief) or "opus" (verification, critique, design choice, synthesis). Re-issuing it unchanged keeps the session's model.` };
  }
  const model = ti.model || defined || sessionModel(input.transcript_path) || '';
  if (!tier(model) || !String(ti.prompt || '').trim()) return {};
  const r = await runPreset('model_tier', { subagent_type: type, description: ti.description || '', brief: String(ti.prompt).slice(0, 4000) }, { label: 'agent-model', timeout: 6000, retries: 0, deadline });
  const k = r.ok && r.answers?.kind, route = k && ROUTES[k.choice];
  if (!route || !(k.confidence >= ROUTE_MIN)) return {};
  if (tier(model) === route.model) return ti.effort || definedEffort(type, input.cwd) ? {} : { effort: route.effort };
  if (!firstTime('tier\n' + key)) return {};
  return { deny: `Jev rates this brief as ${k.choice} work (p=${k.confidence}), which runs best on ${route.model} at ${route.effort} effort, but the agent would run on ${model}. Re-issue it with model: "${route.model}". If the rating is wrong, re-issue the same call unchanged to keep ${model}. (Advisory classifier; it can be wrong.)` };
}

if (process.argv[1] && import.meta.url.endsWith('agent-model-hook.mjs') && process.argv[1].endsWith('agent-model-hook.mjs')) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (['Agent', 'Task'].includes(input.tool_name)) {
      const d = await agentModelDecision(input);
      if (d.deny) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.deny } }));
      else if (d.effort) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, effort: d.effort } } }));
    }
  } catch (e) { logHookError('agent-model-hook', e); /* fail open */ }
}
