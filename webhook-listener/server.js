// HTTP surface. Only POST /hooks/jira is meant to be reachable through the tunnel.
// The handler never runs agent work: it verifies, filters, enqueues and replies (202).
import express from 'express';
import { verifySignature, verifyToken } from './verifySignature.js';
import { createRateLimiter } from './rateLimit.js';
import { evaluateJiraEvent } from '../jira-integration/webhookFilter.js';
import { ISSUE_KEY_RE } from '../jira-integration/jiraClient.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DELIVERY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function createApp({ config, logger, secrets, jobStore, killSwitch, reconciler = null, extraRoutes = null, now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const perClient = createRateLimiter({ ...config.rateLimit.perClient, now });
  const global = createRateLimiter({ ...config.rateLimit.global, now });
  const proxyHeader = config.server.trustProxyHeader;
  // x-forwarded-for (ngrok) can be a list: the first entry is the original client.
  const clientKey = (req) => (proxyHeader && req.get(proxyHeader)?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  const authMode = config.jira.webhookAuth ?? 'hmac';
  const tokenHeader = config.jira.tokenHeader ?? 'x-ngauto-token';

  // Local-only health check: refused if it arrived via the tunnel (proxy header present).
  app.get('/healthz', (req, res) => {
    if (!LOOPBACK.has(req.socket.remoteAddress) || (proxyHeader && req.get(proxyHeader))) return res.status(404).end();
    res.json({ ok: true, paused: killSwitch.isActive() });
  });

  app.post(
    '/hooks/jira',
    (req, res, next) => {
      if (!killSwitch.isActive()) return next();
      logger.warn('webhook.rejected', { reason: 'kill_switch' });
      res.status(503).set('Retry-After', '300').end();
    },
    (req, res, next) => {
      const client = clientKey(req);
      const g = global.take('global');
      const c = g.allowed ? perClient.take(client) : g;
      if (c.allowed) return next();
      logger.warn('security.rate_limited', { client });
      res.status(429).set('Retry-After', String(c.retryAfterSec)).end();
    },
    express.raw({ type: () => true, limit: config.server.bodyLimit }),
    async (req, res) => {
      const client = clientKey(req);
      const rawId = req.get('x-atlassian-webhook-identifier');
      const deliveryId = rawId && DELIVERY_ID_RE.test(rawId) ? rawId : null;

      let secret;
      try {
        secret = await secrets.get('jira-webhook-secret');
      } catch {
        logger.error('security.missing_secret', { name: 'jira-webhook-secret' });
        return res.status(503).end();
      }

      const sig =
        authMode === 'token'
          ? verifyToken({ secret, header: req.get(tokenHeader) })
          : verifySignature({ secret, rawBody: req.body, header: req.get(config.jira.signatureHeader) });
      if (!sig.ok) {
        logger.warn('security.auth_failure', { reason: sig.reason, client, deliveryId });
        return res.status(401).end();
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        logger.warn('webhook.invalid_json', { client, deliveryId });
        return res.status(400).end();
      }

      if (authMode === 'token') return handleAutomation(payload, res, client);

      if (deliveryId && !jobStore.recordDelivery(deliveryId)) {
        logger.info('webhook.duplicate_delivery', { deliveryId });
        return res.status(200).json({ status: 'duplicate' });
      }

      const verdict = evaluateJiraEvent(payload, { ...config.jira, now: now() });
      if (!verdict.accept) {
        logger.info('webhook.ignored', { reason: verdict.reason, issueKey: verdict.issueKey, deliveryId });
        return res.status(202).json({ status: 'ignored' });
      }

      const result = jobStore.enqueue({
        issueKey: verdict.issueKey,
        issueId: verdict.issueId,
        source: 'webhook',
        dedupeKey: verdict.dedupeKey,
      });
      logger.info(`webhook.${result.status}`, { issueKey: verdict.issueKey, jobId: result.job?.id, trigger: verdict.trigger, deliveryId });
      res.status(202).json({ status: result.status === 'enqueued' ? 'accepted' : 'duplicate' });
    },
  );

  // Jira Automation body: {"issueKey":"{{issue.key}}"}. Reply immediately; the issue is then
  // re-fetched from Jira and evaluated exactly like a polled issue (body is only a hint).
  function handleAutomation(payload, res, client) {
    const issueKey = payload?.issueKey;
    if (typeof issueKey !== 'string' || !ISSUE_KEY_RE.test(issueKey)) {
      logger.warn('webhook.invalid_payload', { client });
      return res.status(400).end();
    }
    if (!reconciler) {
      logger.error('webhook.no_jira_client', { issueKey, hint: 'needs jira.baseUrl, jira.email and the jira-api-token secret' });
      return res.status(503).end();
    }
    res.status(202).json({ status: 'accepted' });
    reconciler
      .checkIssue(issueKey, { source: 'automation' })
      .then((r) => logger.info(`webhook.${r.status}`, { issueKey, reason: r.reason, jobId: r.jobId, trigger: r.trigger }))
      .catch((err) => logger.warn('webhook.check_failed', { issueKey, err, status: err?.status, hint: 'poller will retry on its next run' }));
  }

  extraRoutes?.(app); // local portal (dashboard.js) - loopback-only, refused via tunnel

  app.use((req, res) => res.status(404).end());

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') {
      logger.warn('security.body_too_large', { client: clientKey(req) });
      return res.status(413).end();
    }
    logger.error('http.error', { err });
    res.status(err?.status && err.status < 500 ? err.status : 500).end();
  });

  return app;
}
