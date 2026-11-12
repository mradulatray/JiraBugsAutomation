// Structured JSON-lines logger. Every field passes through redact() before it is written.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { redact } from '../security/redact.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ dir, file = 'ngauto.log', level = 'info', maxBytes = 10 * 1024 * 1024, stdout = true, base = {} } = {}) {
  const target = dir ? path.join(dir, file) : null;
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });

  function rotate() {
    try {
      if (statSync(target).size > maxBytes) renameSync(target, `${target}.1`);
    } catch {
      /* file does not exist yet */
    }
  }

  function write(lvl, event, fields = {}) {
    if (LEVELS[lvl] < (LEVELS[level] ?? LEVELS.info)) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, event, ...redact({ ...base, ...fields }) });
    if (target) {
      rotate();
      appendFileSync(target, line + '\n', { mode: 0o600 });
    }
    if (stdout) (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(line + '\n');
  }

  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    child: (extra) => createLogger({ dir, file, level, maxBytes, stdout, base: { ...base, ...extra } }),
  };
}

export const nullLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return nullLogger; } };
