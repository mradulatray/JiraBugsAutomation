// Child-process helper for the agent runner. No shell: argv arrays only.
// - minimal environment (no NGAUTO_SECRET_* or other inherited secrets)
// - hard timeout + external abort (kill switch / shutdown) kill the whole process group
// - output is captured with a size cap and optionally tee'd to a log file
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { homedir, userInfo } from 'node:os';

const PASS_ENV = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'DEVELOPER_DIR'];

export function childEnv(extra = {}) {
  const env = {};
  for (const k of PASS_ENV) if (process.env[k]) env[k] = process.env[k];
  env.HOME ??= homedir();
  env.USER ??= userInfo().username;
  env.PATH = [`${env.HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return { ...env, ...extra };
}

/**
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}>}
 */
export function run(cmd, args, { cwd, input, timeoutMs = 10 * 60_000, signal, env = childEnv(), logFile, maxBytes = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const log = logFile ? createWriteStream(logFile, { flags: 'a', mode: 0o600 }) : null;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 5_000).unref();
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (which) => (chunk) => {
      log?.write(chunk);
      const s = chunk.toString('utf8');
      if (which === 'out') stdout = (stdout + s).slice(-maxBytes);
      else stderr = (stderr + s).slice(-maxBytes);
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      log?.end();
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      log?.end();
      resolve({ code, stdout, stderr, timedOut, aborted });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
