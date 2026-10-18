// Runs one decide() call under Node for hosts whose runtime breaks the SDK (Bun inside opencode; see lib.mjs).
// stdin: {"args": {state, questions, model}, "opts": {label, timeout, retries, deadline}}; stdout: decide()'s result as JSON.
import { decide } from './lib.mjs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  let r;
  try {
    const { args, opts } = JSON.parse(input);
    r = await decide(args, { ...opts, deadline: opts.deadline ?? Infinity });
  } catch (e) {
    r = { ok: false, model: null, ms: 0, error: { message: 'decide-cli: ' + String(e?.message || e).slice(0, 200) } };
  }
  process.stdout.write(JSON.stringify(r));
});
