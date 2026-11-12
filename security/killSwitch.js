// Emergency stop. Presence of the KILL file means:
// - the listener rejects all webhooks with 503 and shuts itself down
// - the queue must not start new work (checked by the agent runner in later phases)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function createKillSwitch(file) {
  return {
    file,
    isActive: () => existsSync(file),
    activate(reason = 'manual') {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), reason }) + '\n', { mode: 0o600 });
    },
    clear() {
      rmSync(file, { force: true });
    },
    info() {
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return { reason: 'unknown' };
      }
    },
  };
}
