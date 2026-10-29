// "First time within a window" markers shared by the hooks that push back only once.
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const DIR = process.env.CLAUDE_CHECKS_STATE || join(homedir(), '.agents', 'cache', 'claude-checks-once');

export function firstTime(key, windowMs = 60 * 60e3) {
  try {
    mkdirSync(DIR, { recursive: true });
    for (const f of readdirSync(DIR)) { const p = join(DIR, f); try { if (Date.now() - statSync(p).mtimeMs > windowMs) unlinkSync(p); } catch { /* raced */ } }
    writeFileSync(join(DIR, createHash('sha256').update(String(key)).digest('hex').slice(0, 24)), '', { flag: 'wx' });
    return true;
  } catch (e) { return e?.code !== 'EEXIST'; }
}
