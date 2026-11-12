// Secret access. Default provider is the macOS login Keychain (via /usr/bin/security,
// invoked with execFile - no shell). The "env" provider exists for future cloud
// deployments where a secrets manager injects NGAUTO_SECRET_* variables.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerSecret } from './redact.js';

const execFileAsync = promisify(execFile);

export const SECRET_NAMES = Object.freeze(['jira-webhook-secret', 'jira-api-token', 'gitlab-token']);

export class MissingSecretError extends Error {
  constructor(name) {
    super(`Secret "${name}" is not configured`);
    this.name = 'MissingSecretError';
    this.secretName = name;
  }
}

export function envVarName(name) {
  return `NGAUTO_SECRET_${name.toUpperCase().replaceAll('-', '_')}`;
}

export function createSecretStore(config, { env = process.env, exec = execFileAsync } = {}) {
  const cache = new Map();

  async function read(name) {
    if (config.secrets.provider === 'env') return env[envVarName(name)];
    try {
      const { stdout } = await exec(
        '/usr/bin/security',
        ['find-generic-password', '-s', config.secrets.keychainService, '-a', name, '-w'],
        { timeout: 10_000 },
      );
      return stdout.replace(/\n$/, '');
    } catch {
      return undefined; // never surface stderr: it can echo item attributes
    }
  }

  async function get(name) {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret name: ${name}`);
    if (cache.has(name)) return cache.get(name);
    const value = await read(name);
    if (!value) throw new MissingSecretError(name);
    registerSecret(value);
    cache.set(name, value);
    return value;
  }

  async function has(name) {
    try {
      await get(name);
      return true;
    } catch {
      return false;
    }
  }

  return { get, has, clearCache: () => cache.clear() };
}
