#!/usr/bin/env node
// Operator CLI: service control (launchd), emergency stop, job inspection, secrets.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, ROOT } from '../config/index.js';
import { createKillSwitch } from '../security/killSwitch.js';
import { createSecretStore, SECRET_NAMES } from '../security/secrets.js';
import { openJobStore } from '../queue/jobStore.js';
import { computeSignature } from '../webhook-listener/verifySignature.js';
import { createJiraClient, ISSUE_KEY_RE } from '../jira-integration/jiraClient.js';
import { createReconciler } from '../jira-integration/reconciler.js';
import { buildTicketMarkdown, fetchTicket, writeTicket } from '../jira-integration/ticketBuilder.js';
import { nullLogger } from '../lib/logger.js';

const config = loadConfig();
const killSwitch = createKillSwitch(config.paths.killFile);
const label = config.launchd.label;
const domain = `gui/${process.getuid()}`;
const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(args, { quiet = false } = {}) {
  const r = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (!quiet && r.status !== 0 && r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

const isLoaded = () => launchctl(['print', `${domain}/${label}`], { quiet: true });

const tunnelLabel = config.tunnel.label;
const tunnelPlist = path.join(homedir(), 'Library', 'LaunchAgents', `${tunnelLabel}.plist`);
const tunnelLoaded = () => launchctl(['print', `${domain}/${tunnelLabel}`], { quiet: true });

function findNgrok() {
  for (const p of ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok']) if (existsSync(p)) return p;
  const r = spawnSync('/usr/bin/which', ['ngrok'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function tunnelInstall() {
  if (killSwitch.isActive()) return fail('Kill switch is active. Run `ngauto unkill` first.');
  const ngrok = findNgrok();
  if (!ngrok) return fail('ngrok not found. Install it: brew install ngrok');
  if (!config.tunnel.domain) return fail('Set tunnel.domain in config/local.json (your ngrok static domain, e.g. abc-123.ngrok-free.app).');
  if (config.jira.webhookAuth !== 'token' && config.jira.webhookAuth !== 'hmac') return fail('jira.webhookAuth must be set.');
  const plist = readFileSync(path.join(ROOT, 'launchd', 'tunnel.plist.template'), 'utf8')
    .replaceAll('{{LABEL}}', xmlEscape(tunnelLabel))
    .replaceAll('{{NGROK}}', xmlEscape(ngrok))
    .replaceAll('{{DOMAIN}}', xmlEscape(config.tunnel.domain))
    .replaceAll('{{PORT}}', xmlEscape(config.server.port))
    .replaceAll('{{LOGDIR}}', xmlEscape(config.paths.logs));
  mkdirSync(path.dirname(tunnelPlist), { recursive: true });
  mkdirSync(config.paths.logs, { recursive: true, mode: 0o700 });
  writeFileSync(tunnelPlist, plist, { mode: 0o644 });
  if (tunnelLoaded()) launchctl(['bootout', `${domain}/${tunnelLabel}`], { quiet: true });
  if (launchctl(['bootstrap', domain, tunnelPlist])) {
    console.log(`Tunnel started: https://${config.tunnel.domain}/hooks/jira -> 127.0.0.1:${config.server.port} (starts at login).`);
  }
}

function tunnelUninstall() {
  if (tunnelLoaded()) launchctl(['bootout', `${domain}/${tunnelLabel}`]);
  rmSync(tunnelPlist, { force: true });
  console.log('Tunnel stopped and launchd entry removed.');
}

function install() {
  const extraEnv = process.env.NGAUTO_CONFIG
    ? `    <key>NGAUTO_CONFIG</key>\n    <string>${xmlEscape(path.resolve(process.env.NGAUTO_CONFIG))}</string>\n`
    : '';
  const plist = readFileSync(path.join(ROOT, 'launchd', 'listener.plist.template'), 'utf8')
    .replaceAll('{{LABEL}}', xmlEscape(label))
    .replaceAll('{{NODE}}', xmlEscape(process.execPath))
    .replaceAll('{{ENTRY}}', xmlEscape(path.join(ROOT, 'index.js')))
    .replaceAll('{{WORKDIR}}', xmlEscape(ROOT))
    .replaceAll('{{LOGDIR}}', xmlEscape(config.paths.logs))
    .replaceAll('{{EXTRA_ENV}}', extraEnv);
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(config.paths.logs, { recursive: true, mode: 0o700 });
  writeFileSync(plistPath, plist, { mode: 0o644 });
  console.log(`Wrote ${plistPath}`);
  if (isLoaded()) launchctl(['bootout', `${domain}/${label}`], { quiet: true });
  if (launchctl(['bootstrap', domain, plistPath])) console.log('Service installed and started (starts automatically at login).');
}

function uninstall() {
  if (isLoaded()) launchctl(['bootout', `${domain}/${label}`]);
  rmSync(plistPath, { force: true });
  console.log('Service stopped and launchd entry removed.');
}

function start() {
  if (killSwitch.isActive()) return fail('Kill switch is active. Run `ngauto unkill` first.');
  if (!existsSync(plistPath)) return fail('Not installed. Run `ngauto install` (or `npm start` for foreground).');
  if (isLoaded()) launchctl(['kickstart', `${domain}/${label}`]);
  else launchctl(['bootstrap', domain, plistPath]);
  console.log('Started.');
}

function stop() {
  if (isLoaded()) launchctl(['bootout', `${domain}/${label}`]);
  console.log('Stopped (will start again at next login unless uninstalled).');
}

function restart() {
  if (killSwitch.isActive()) return fail('Kill switch is active. Run `ngauto unkill` first.');
  if (!isLoaded()) return start();
  launchctl(['kickstart', '-k', `${domain}/${label}`]);
  console.log('Restarted.');
}

function kill(reason) {
  killSwitch.activate(reason || 'manual');
  if (isLoaded()) launchctl(['bootout', `${domain}/${label}`], { quiet: true });
  if (tunnelLoaded()) launchctl(['bootout', `${domain}/${tunnelLabel}`], { quiet: true });
  // Later phases: also SIGTERM -> SIGKILL the active agent process group recorded in jobs.agent_pid.
  console.log(`KILL SWITCH ACTIVE (${killSwitch.file}). Listener + tunnel stopped; webhooks rejected; no new jobs start.`);
}

function unkill() {
  killSwitch.clear();
  console.log('Kill switch cleared. Run `ngauto start` (and `ngauto tunnel install` if you use the tunnel) to resume.');
}

async function status() {
  const secrets = createSecretStore(config);
  console.log(`Kill switch : ${killSwitch.isActive() ? `ACTIVE ${JSON.stringify(killSwitch.info())}` : 'off'}`);
  console.log(`launchd     : ${existsSync(plistPath) ? (isLoaded() ? 'loaded' : 'installed, not loaded') : 'not installed'}`);
  try {
    const r = await fetch(`http://127.0.0.1:${config.server.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    console.log(`Listener    : ${r.ok ? `up on 127.0.0.1:${config.server.port}` : `HTTP ${r.status}`}`);
  } catch {
    console.log('Listener    : not responding');
  }
  console.log(`Tunnel      : ${existsSync(tunnelPlist) ? (tunnelLoaded() ? `loaded (https://${config.tunnel.domain}/hooks/jira)` : 'installed, not loaded') : 'not installed'}`);
  console.log(`Webhook auth: ${config.jira.webhookAuth}${config.jira.webhookAuth === 'token' ? ` (header ${config.jira.tokenHeader})` : ''}`);
  for (const name of SECRET_NAMES) console.log(`Secret      : ${name.padEnd(20)} ${(await secrets.has(name)) ? 'present' : 'MISSING'}`);
  console.log(`Jira account: ${config.jira.accountId || 'NOT SET (jira.accountId)'}`);
  if (existsSync(config.paths.db)) {
    const store = openJobStore(config.paths.db);
    console.log(`Jobs        : ${JSON.stringify(store.countByState())}`);
    store.close();
  }
}

function jobs(limit = 20) {
  if (!existsSync(config.paths.db)) return console.log('No jobs yet.');
  const store = openJobStore(config.paths.db);
  const rows = store.listJobs(Number(limit) || 20);
  store.close();
  if (!rows.length) return console.log('No jobs yet.');
  for (const j of rows) {
    console.log(`#${String(j.id).padEnd(4)} ${j.issue_key.padEnd(14)} ${j.state.padEnd(18)} ${j.updated_at}  ${j.mr_url ?? ''}${j.error ? `  error=${j.error}` : ''}`);
  }
}

function withStore(fn) {
  if (!existsSync(config.paths.db)) return fail('No jobs yet.');
  const store = openJobStore(config.paths.db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function jobArg(id) {
  const n = Number(String(id ?? '').replace(/^#/, ''));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function show(id) {
  const n = jobArg(id);
  if (!n) return fail('Usage: ngauto show <jobId>');
  withStore((store) => {
    const j = store.getJob(n);
    if (!j) return fail(`Job #${n} not found`);
    console.log(`Job #${j.id}  ${j.issue_key}  ${j.state}  (attempts ${j.attempts})`);
    if (j.branch) console.log(`Branch    : ${j.branch} -> ${j.target_branch}`);
    if (j.mr_url) console.log(`MR        : ${j.mr_url}`);
    if (j.error) console.log(`Info/error: ${j.error}`);
    const ws = path.join(config.paths.workspaces, j.issue_key);
    if (existsSync(ws)) console.log(`Workspace : ${ws}  (repo/, TICKET.md, agent-*.json, build-*.log)`);
    console.log('History:');
    for (const e of store.jobEvents(n)) console.log(`  ${e.at}  ${(e.from_state ?? '').padEnd(17)} -> ${e.to_state.padEnd(17)} ${e.note ?? ''}`);
  });
}

function retry(id) {
  const n = jobArg(id);
  if (!n) return fail('Usage: ngauto retry <jobId>');
  withStore((store) => {
    const j = store.transition(n, 'QUEUED', { note: 'manual retry', patch: { error: null } });
    console.log(`Job #${n} (${j.issue_key}) re-queued; the runner starts it within ${config.agent.pollSec}s (worktree is recreated from origin/${config.gitlab.defaultTargetBranch}).`);
  });
}

function requeueMode(id, mode) {
  const n = jobArg(id);
  if (!n) return fail(`Usage: ngauto ${mode} <jobId>`);
  withStore((store) => {
    const j = store.getJob(n);
    if (!j?.branch || !existsSync(path.join(config.paths.workspaces, j.issue_key, 'repo'))) return fail(`Job #${n} has no existing fix; use retry.`);
    store.transition(n, 'QUEUED', { note: mode, patch: { error: null } });
    console.log(`Job #${n} (${j.issue_key}) re-queued for ${mode === 'rebuild' ? 'Xcode build only (reusing the fix)' : 'push + Draft MR'}.`);
  });
}

function cancel(id) {
  const n = jobArg(id);
  if (!n) return fail('Usage: ngauto cancel <jobId>');
  withStore((store) => {
    const j = store.transition(n, 'CANCELLED', { note: 'cancelled by user' });
    console.log(`Job #${n} (${j.issue_key}) cancelled.`);
  });
}

// Generates a random secret, stores it, and shows it ONCE so it can be pasted into Jira.
function secretGenerate(name) {
  if (name !== 'jira-webhook-secret') return fail('Only jira-webhook-secret can be generated.');
  if (!process.stdout.isTTY) return fail('No interactive terminal. Run this in Terminal.app (not via Claude\'s "!" prefix) so the value is not captured.');
  const svc = config.secrets.keychainService;
  const value = randomBytes(32).toString('hex');
  const r = spawnSync('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s ${svc} -a ${name} -w "${value}"\n`, encoding: 'utf8' });
  if (r.status !== 0) return fail('Failed to store secret.');
  console.log(`Stored in Keychain. Paste this into the Jira Automation rule header (${config.jira.tokenHeader}); it is not shown again:\n\n  ${value}\n`);
}

async function secretSet(name) {
  if (!SECRET_NAMES.includes(name)) return fail(`Unknown secret. One of: ${SECRET_NAMES.join(', ')}`);
  if (!process.stdin.isTTY) return fail('No interactive terminal. Run this in Terminal.app (not via Claude\'s "!" prefix).');
  const svc = config.secrets.keychainService;
  const value = (await readHidden(`Paste value for "${name}" and press Enter: `)).trim();
  if (!value) return fail('Empty value, nothing stored.');
  // Token charset only: keeps the `security -i` command line unambiguous (no quotes/spaces).
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(value)) return fail('Value contains unexpected characters (spaces/quotes?). Copy it again with the Copy button.');
  // `security`'s own -w prompt truncates input at 128 chars, so send the command on stdin
  // (`security -i`) instead: the value never appears in argv/ps or shell history.
  const r = spawnSync('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s ${svc} -a ${name} -w "${value}"\n`, encoding: 'utf8' });
  if (r.status !== 0) return fail('Failed to store secret.');
  const check = spawnSync('/usr/bin/security', ['find-generic-password', '-s', svc, '-a', name, '-w'], { encoding: 'utf8' });
  if (check.status !== 0 || check.stdout.replace(/\n$/, '') !== value) {
    return fail('Verification failed: stored value does not match. If Keychain showed a popup, choose "Always Allow" and retry.');
  }
  console.log(`Stored and verified (${value.length} characters).`);
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function sign(file) {
  if (!file) return fail('Usage: ngauto sign <payload.json>');
  const secret = await createSecretStore(config).get('jira-webhook-secret');
  console.log(computeSignature(secret, readFileSync(file)));
}

function jiraClient() {
  const secrets = createSecretStore(config);
  return createJiraClient({ baseUrl: config.jira.baseUrl, email: config.jira.email, getToken: () => secrets.get('jira-api-token') });
}

async function poll(flags) {
  const dryRun = flags.includes('--dry-run');
  const jira = jiraClient();
  const me = await jira.myself();
  if (me?.accountId !== config.jira.accountId) {
    console.warn(`WARNING: token belongs to ${me?.accountId}, but jira.accountId is ${config.jira.accountId}`);
  }
  const store = dryRun ? null : openJobStore(config.paths.db);
  try {
    const r = await createReconciler({ config, jira, jobStore: store, logger: nullLogger, killSwitch }).pollOnce({ dryRun });
    if (r.skipped) return fail(`Skipped: ${r.skipped}`);
    console.log(`JQL: ${r.jql}`);
    if (!r.results.length) console.log('No newly assigned bugs in the lookback window.');
    for (const x of r.results) console.log(`${String(x.issueKey).padEnd(14)} ${x.status.padEnd(18)} ${x.reason ?? x.trigger ?? ''}${x.jobId ? `  job #${x.jobId}` : ''}`);
  } finally {
    store?.close();
  }
}

async function ticket(key, flags) {
  if (!ISSUE_KEY_RE.test(key ?? '')) return fail('Usage: ngauto ticket <ISSUE-KEY> [--write]');
  const jira = jiraClient();
  if (flags.includes('--write')) return console.log(`Wrote ${await writeTicket({ jira, config, issueKey: key })}`);
  const { issue, comments } = await fetchTicket(jira, key, { maxComments: config.jira.ticket?.maxComments });
  process.stdout.write(buildTicketMarkdown({ issue, comments, browseUrl: jira.browseUrl(key) }));
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

const HELP = `ngauto <command>
  install | uninstall      install/remove the launchd service (auto-start at login)
  start | stop | restart   control the service
  status                   service, kill switch, secrets and job summary
  kill [reason]            EMERGENCY STOP: block webhooks, stop listener, halt jobs
  unkill                   clear the kill switch
  jobs [limit]             list recent jobs
  show <jobId>             job details, history and workspace paths
  retry <jobId>            re-queue a NEEDS_INFO/FAILED/VALIDATION_FAILED/INTERRUPTED/VALIDATED job
  rebuild <jobId>          re-run only the Xcode build on the existing fix (no new Claude run)
  publish <jobId>          push the branch + open/update the Draft MR (needs gitlab-token)
  cancel <jobId>           cancel a job (to stop a RUNNING job use \`ngauto kill\`)
  secret set <name>        store a secret in Keychain (${SECRET_NAMES.join(', ')})
  secret generate jira-webhook-secret   create + store a random webhook secret, shown once
  tunnel install|uninstall run the ngrok tunnel as a launchd service (tunnel.domain)
  sign <file>              print the HMAC signature for a local test payload
  poll [--dry-run]         poll Jira once for bugs newly assigned to you (enqueue unless --dry-run)
  ticket <KEY> [--write]   print TICKET.md for an issue (or write it to the workspace)`;

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  install,
  uninstall,
  start,
  stop,
  restart,
  status,
  kill: () => kill(args.join(' ')),
  unkill,
  jobs: () => jobs(args[0]),
  show: () => show(args[0]),
  retry: () => retry(args[0]),
  cancel: () => cancel(args[0]),
  rebuild: () => requeueMode(args[0], 'rebuild'),
  publish: () => requeueMode(args[0], 'publish'),
  secret: () => (args[0] === 'set' ? secretSet(args[1]) : args[0] === 'generate' ? secretGenerate(args[1]) : fail('Usage: ngauto secret set|generate <name>')),
  tunnel: () => (args[0] === 'install' ? tunnelInstall() : args[0] === 'uninstall' ? tunnelUninstall() : fail('Usage: ngauto tunnel install|uninstall')),
  sign: () => sign(args[0]),
  poll: () => poll(args),
  ticket: () => ticket(args[0], args.slice(1)),
};

if (!commands[cmd]) {
  console.log(HELP);
  if (cmd && cmd !== 'help') process.exitCode = 1;
} else {
  try {
    await commands[cmd]();
  } catch (err) {
    if (err?.name === 'JiraApiError' && (err.status === 401 || err.status === 403)) {
      fail(`Jira rejected the credentials (HTTP ${err.status}). jira.email must be the login email of the account that created\nthe token, and the token must be a classic API token (id.atlassian.com > Security > API tokens). Re-store it with:\n  ngauto secret set jira-api-token`);
    } else {
      fail(`${err?.name ?? 'Error'}: ${err?.message ?? err}`);
    }
  }
}
