// Service entry point (run by launchd or `npm start`).
import { loadConfig } from './config/index.js';
import { createLogger } from './lib/logger.js';
import { createKillSwitch } from './security/killSwitch.js';
import { createSecretStore } from './security/secrets.js';
import { openJobStore } from './queue/jobStore.js';
import { createApp } from './webhook-listener/server.js';
import { createJiraClient } from './jira-integration/jiraClient.js';
import { createReconciler } from './jira-integration/reconciler.js';
import { createAgentRunner } from './agent-runner/runner.js';
import { createMacNotifier } from './notifications/macos.js';
import { mountDashboard } from './webhook-listener/dashboard.js';
import { run } from './agent-runner/exec.js';
import { createWorkspace } from './agent-runner/workspace.js';
import { createGitlabClient } from './gitlab-integration/gitlabClient.js';
import { createPublisher } from './gitlab-integration/publisher.js';

const config = loadConfig();
const logger = createLogger({ dir: config.paths.logs, level: config.logging.level, stdout: config.logging.stdout });
const killSwitch = createKillSwitch(config.paths.killFile);

if (killSwitch.isActive()) {
  logger.warn('service.start_blocked', { reason: 'kill_switch', info: killSwitch.info() });
  process.exit(0); // exit 0 => launchd (KeepAlive.SuccessfulExit=false) will not respawn
}

const jobStore = openJobStore(config.paths.db);
for (const job of jobStore.recoverInterrupted()) {
  logger.warn('job.interrupted', { jobId: job.id, issueKey: job.issue_key });
}
jobStore.pruneDeliveries();

const secrets = createSecretStore(config);
if (!(await secrets.has('jira-webhook-secret'))) {
  logger.warn('security.missing_secret', { name: 'jira-webhook-secret', effect: 'all webhooks will be rejected with 503' });
}
if (!config.jira.accountId) {
  logger.warn('config.missing', { key: 'jira.accountId', effect: 'all events will be ignored' });
}

// The reconciler serves both the poller and the Jira Automation webhook (which only names an issue).
let reconciler = null;
let runner = null;
let jira = null;
const notify = config.notifications?.channels?.includes('macos') ? createMacNotifier({ logger }) : () => {};
if (!config.jira.baseUrl || !config.jira.email || !(await secrets.has('jira-api-token'))) {
  logger.warn('jira.client_disabled', { reason: 'needs jira.baseUrl, jira.email and the jira-api-token secret', effect: 'no polling; automation webhooks get 503' });
} else {
  jira = createJiraClient({ baseUrl: config.jira.baseUrl, email: config.jira.email, getToken: () => secrets.get('jira-api-token') });
  reconciler = createReconciler({ config, jira, jobStore, logger, killSwitch });
  if (config.jira.poll?.enabled) reconciler.start();
  if (config.agent?.enabled) {
    if (!config.repo.path) {
      logger.warn('config.missing', { key: 'repo.path', effect: 'agent runner disabled' });
    } else {
      const workspace = createWorkspace({ run });
      let publisher = null;
      if (config.gitlab.autoMr === false) {
        logger.info('gitlab.mr_disabled', { reason: 'gitlab.autoMr=false' });
      } else if (!(await secrets.has('gitlab-token'))) {
        logger.warn('gitlab.mr_disabled', { reason: 'gitlab-token secret missing', effect: 'fixes stop at VALIDATED (no push / Draft MR)' });
      } else {
        const gitlab = createGitlabClient({ baseUrl: config.gitlab.baseUrl, projectPath: config.gitlab.projectPath, getToken: () => secrets.get('gitlab-token') });
        publisher = createPublisher({ config, gitlab, workspace, jira, logger, getToken: () => secrets.get('gitlab-token') });
      }
      runner = createAgentRunner({ config, jobStore, jira, logger, killSwitch, notify, workspace, publisher });
      runner.start();
    }
  }
}

const app = createApp({
  config, logger, secrets, jobStore, killSwitch, reconciler,
  extraRoutes: (a) => mountDashboard(a, { config, jobStore, jira, killSwitch, runner, logger, mrEnabled: Boolean(runner?.publishes) }),
});
const server = app.listen(config.server.port, config.server.host, () => {
  logger.info('service.started', { host: config.server.host, port: server.address().port, env: config.env, pid: process.pid, portal: `http://127.0.0.1:${server.address().port}/` });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

let shuttingDown = false;
function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('service.stopping', { reason });
  clearInterval(killWatch);
  clearInterval(pruneTimer);
  reconciler?.stop();
  runner?.stop();
  setTimeout(() => process.exit(code), 10_000).unref();
  server.close(() => {
    jobStore.close();
    logger.info('service.stopped', { reason });
    process.exit(code);
  });
  server.closeIdleConnections();
}

const killWatch = setInterval(() => {
  if (killSwitch.isActive()) shutdown('kill_switch', 0);
}, 5_000);
const pruneTimer = setInterval(() => jobStore.pruneDeliveries(), 86_400_000);

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('service.uncaught_exception', { err });
  shutdown('uncaught_exception', 1);
});
process.on('unhandledRejection', (err) => {
  logger.error('service.unhandled_rejection', { err });
  shutdown('unhandled_rejection', 1);
});
