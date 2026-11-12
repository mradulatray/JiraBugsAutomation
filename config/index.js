// Configuration loader.
// Precedence (low -> high): config/default.json, config/local.json (gitignored),
// file at $NGAUTO_CONFIG, then env vars of the form NGAUTO__section__key=value.
// No machine-specific paths are hardcoded; "~" and relative paths are resolved here.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function coerce(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function applyEnv(cfg, env) {
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('NGAUTO__')) continue;
    const keys = k.slice('NGAUTO__'.length).split('__').filter(Boolean);
    if (keys.length === 0) continue;
    let o = cfg;
    for (const key of keys.slice(0, -1)) {
      if (!isPlainObject(o[key])) o[key] = {};
      o = o[key];
    }
    o[keys.at(-1)] = coerce(v);
  }
}

export function expandPath(p, base = ROOT) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) return path.join(homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

export function validateConfig(cfg) {
  const errors = [];
  const { server, jira, secrets } = cfg;
  if (!LOOPBACK_HOSTS.has(server.host) && !server.allowNonLoopback) {
    errors.push(`server.host "${server.host}" is not loopback; set server.allowNonLoopback=true only behind a trusted proxy`);
  }
  if (!Number.isInteger(server.port) || server.port < 0 || server.port > 65535) {
    errors.push('server.port must be an integer 0-65535');
  }
  if (!Array.isArray(jira.projects) || jira.projects.length === 0) errors.push('jira.projects must be a non-empty array');
  if (!Array.isArray(jira.issueTypes) || jira.issueTypes.length === 0) errors.push('jira.issueTypes must be a non-empty array');
  if (jira.baseUrl && !/^https:\/\/[^/\s]+\/?$/.test(jira.baseUrl)) errors.push('jira.baseUrl must be an https origin, e.g. https://site.atlassian.net');
  if (!['hmac', 'token'].includes(jira.webhookAuth ?? 'hmac')) errors.push('jira.webhookAuth must be "hmac" or "token"');
  if (cfg.tunnel?.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cfg.tunnel.domain)) errors.push('tunnel.domain must be a bare hostname, e.g. abc-123.ngrok-free.app');
  const poll = jira.poll ?? {};
  if (poll.enabled && (!Number.isFinite(poll.intervalSec) || poll.intervalSec < 30)) errors.push('jira.poll.intervalSec must be >= 30');
  if (!['keychain', 'env'].includes(secrets.provider)) errors.push('secrets.provider must be "keychain" or "env"');
  const agent = cfg.agent ?? {};
  if (agent.enabled) {
    if (!(agent.timeoutMin > 0)) errors.push('agent.timeoutMin must be > 0');
    if (!(agent.pollSec >= 5)) errors.push('agent.pollSec must be >= 5');
    if (!Number.isInteger(agent.maxFixAttempts) || agent.maxFixAttempts < 0 || agent.maxFixAttempts > 5) errors.push('agent.maxFixAttempts must be 0-5');
  }
  if (cfg.validate?.enabled && (!Array.isArray(cfg.validate.command) || !cfg.validate.command.length)) errors.push('validate.command must be a non-empty argv array');
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
}

export function loadConfig({ env = process.env } = {}) {
  let cfg = readJson(path.join(ROOT, 'config', 'default.json'));
  const local = path.join(ROOT, 'config', 'local.json');
  if (existsSync(local)) cfg = deepMerge(cfg, readJson(local));
  if (env.NGAUTO_CONFIG) cfg = deepMerge(cfg, readJson(expandPath(env.NGAUTO_CONFIG, process.cwd())));
  applyEnv(cfg, env);

  const home = expandPath(cfg.paths.home);
  cfg.paths = {
    ...cfg.paths,
    home,
    logs: expandPath(cfg.paths.logs),
    db: path.join(home, 'state.db'),
    killFile: path.join(home, 'KILL'),
    workspaces: path.join(home, 'workspaces'),
  };
  if (cfg.repo.path) cfg.repo.path = expandPath(cfg.repo.path);
  if (cfg.agent?.claudePath) cfg.agent.claudePath = expandPath(cfg.agent.claudePath);

  validateConfig(cfg);
  return cfg;
}
