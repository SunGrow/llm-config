#!/usr/bin/env node
// Claude Code Stop hook: if Claude changed code files in this turn after its last test/build/check command (or ran
// none), send it back once to run the check or to name what is unverified. Rule-based, no model call.
import { tmpdir } from 'node:os';
import { resolve, extname, basename } from 'node:path';
import { optedOut, readStdinJson, tail, parseLines, isTypedPrompt, logHookError } from './common.mjs';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Prose and data files: editing these does not call for a test run.
const NON_CODE = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc', '.csv', '.log', '.png', '.jpg', '.svg', '.html']);
export const VERIFY = /\b(test|tests|spec|pytest|jest|vitest|mocha|ctest|tsc|eslint|ruff|mypy|flake8|clippy|lint|typecheck|build|check|compile|msbuild|dotnet|cargo|gradle|gradlew|mvn|make|cmake|ninja|UnrealBuildTool|Build\.bat|RunUAT|py_compile|selftest)\b|node --check|bash -n|go (test|vet|build)/i;

const lower = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const inTemp = (p) => lower(resolve(p)).startsWith(lower(resolve(tmpdir())));

// Returns the code files edited after the last verifying command in the current turn ([] = nothing to say).
export function unverifiedEdits(entries) {
  let start = 0;
  entries.forEach((e, i) => { if (isTypedPrompt(e)) start = i; });
  let edited = new Map(); // path -> true, reset by each verifying command
  for (const e of entries.slice(start)) {
    if (e.type !== 'assistant') continue;
    for (const c of e.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(c.name)) {
        const p = c.input?.file_path || c.input?.notebook_path;
        if (p && !NON_CODE.has(extname(p).toLowerCase()) && !inTemp(p)) edited.set(p, true);
      } else if (SHELL_TOOLS.has(c.name)) {
        const cmd = String(c.input?.command || '');
        if (VERIFY.test(cmd)) edited = new Map();
        // Running or loading the edited file itself (a helper script, a config the command reads) checks it.
        else for (const p of [...edited.keys()]) if (cmd.includes(basename(p))) edited.delete(p);
      }
    }
  }
  return [...edited.keys()];
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  try {
    const input = readStdinJson();
    if (input?.transcript_path && !input.stop_hook_active && !optedOut(input.cwd)) {
      const files = unverifiedEdits(parseLines(tail(input.transcript_path)));
      if (files.length) {
        const list = files.slice(0, 8).join(', ') + (files.length > 8 ? ` and ${files.length - 8} more` : '');
        console.log(JSON.stringify({ decision: 'block', reason: `Done-check: in this turn you changed ${list} after the last test/build/check command (or ran none). Run the check that covers these changes now; if none applies or it cannot run here, say in your final message which changes are not verified and why. Do not repeat earlier work.` }));
      }
    }
  } catch (e) { logHookError('done-check', e); /* never block on our own failure */ }
}
