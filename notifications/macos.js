// macOS Notification Center pop-ups. Prefers terminal-notifier (registers as its own app,
// so macOS shows it reliably); falls back to osascript. Text is always passed as argv,
// never interpolated into script source, so ticket text cannot inject anything.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const TERMINAL_NOTIFIER = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'].find((p) => existsSync(p));

export function createMacNotifier({ logger, enabled = process.platform === 'darwin', notifierPath = TERMINAL_NOTIFIER } = {}) {
  return function notify(title, message = '') {
    if (!enabled) return;
    const clean = (s, n) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
    const t = clean(title, 80);
    // terminal-notifier treats a leading "-" or "[" specially; prefix a space to be safe.
    const m = clean(message, 200).replace(/^([-[])/, ' $1') || ' ';
    const [cmd, args] = notifierPath
      ? [notifierPath, ['-title', 'ngauto', '-subtitle', t, '-message', m, '-group', `ngauto-${t.split(':')[0]}`, '-sound', 'default']]
      : ['/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title "ngauto" subtitle (item 1 of argv)', '-e', 'end run', t, m]];
    execFile(cmd, args, { timeout: 10_000 }, (err) => err && logger?.warn('notify.failed', { err }));
  };
}
