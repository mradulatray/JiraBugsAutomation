# ng-automation

Local Jira → Claude Code → GitLab **Draft** MR automation for the NaukriGulf iOS app.
Lives outside the iOS repo on purpose: the agent never sees or edits its own guardrails.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffold, config, Keychain secrets, redacting logger, CLI, launchd | ✅ done |
| 2 | Express listener on 127.0.0.1, raw body, rate limit, kill switch | ✅ done |
| 3 | HMAC verification, Jira event filter, dedupe, SQLite job queue | ✅ done |
| 4 | Jira REST fetch, TICKET.md builder, reconciler (polling) | ✅ done |
| 5 | Agent runner: worktree, headless Claude fix, commit, xcodebuild check, macOS notifications | ✅ done |
| 6 | Push branch + GitLab Draft MR (VALIDATED → MR_DRAFT) | next |
| 7–10 | Jira comment, Jenkins beta1 build, E2E | pending |

Jobs are enqueued (state `QUEUED`) by the webhook **or** the poller. The agent runner (in the same
service) takes one job at a time:

```
QUEUED → FETCHING   TICKET.md + git worktree ~/.ngauto/workspaces/<KEY>/repo on bugfix/<KEY>-<slug> from origin/release
       → ANALYZING  claude -p in the worktree (no Bash/web/MCP; edits only; $agent.maxBudgetUsd cap)
       → IMPLEMENTING  forbidden-path check (fastlane, Pods, Jenkinsfile, signing…), local commit
       → VALIDATING xcodebuild NaukriGulf_Debug (simulator); on errors Claude retries ≤ agent.maxFixAttempts
       → VALIDATED  compiled, committed locally — nothing is pushed yet (Phase 6)
exits: NEEDS_INFO (agent's question in `ngauto show`), VALIDATION_FAILED, FAILED, INTERRUPTED
```

**Portal:** open http://127.0.0.1:8787/ (this Mac only) — all jobs, current step, Claude's questions with an
answer box (posted to Jira as your comment, then re-queued), Retry/Cancel, ticket, code diff and build log.

`ngauto show <id>` shows history, the question/error and the workspace (agent-*.json, build-*.log);
`ngauto retry <id>` re-queues; `ngauto cancel <id>`; `ngauto kill` aborts a running agent/build.

### Polling (no tunnel / Jira admin needed)

Every `jira.poll.intervalSec` (120 s) the service runs, as you, roughly:

```
assignee = <accountId> AND project in (NGBUGS) AND issuetype in (Bug)
AND (assignee CHANGED TO <accountId> AFTER "-Nm" OR created >= "-Nm")
```

It confirms each hit from the issue changelog and enqueues it with the same dedupe key the
webhook uses (`KEY:assign:<changelogId>` / `KEY:created`), so both paths never double-enqueue.
First poll after start looks back `maxEventAgeSec` (6 h); later polls look back since the last
success + 5 min. Errors back off exponentially (honours `Retry-After`). Needs `jira.baseUrl`,
`jira.email` and the `jira-api-token` secret (a *classic* Atlassian API token for that email).

## Real-time on the Mac: ngrok + Jira Automation

```
Jira Automation rule ──HTTPS──▶ ngrok static domain ──▶ 127.0.0.1:8787/hooks/jira
  (x-ngauto-token header)                                 │ token check, rate limit
                                                          ▼
                                      re-fetch issue + changelog from Jira API ──▶ QUEUED job
```

The request body only names the issue; whether it is really a Bug newly assigned to you is
decided from Jira API data (same rules and dedupe key as the poller, which keeps running as a
backstop for anything missed while the Mac was asleep).

1. ngrok account (free) → copy your authtoken and claim the free **static domain**, then:
   `ngrok config add-authtoken <token>` (Terminal.app).
2. `config/local.json`:
   ```json
   { "jira":   { "webhookAuth": "token" },
     "server": { "trustProxyHeader": "x-forwarded-for" },
     "tunnel": { "domain": "your-name.ngrok-free.app" } }
   ```
3. `node cli/ngauto.js secret generate jira-webhook-secret` (Terminal.app) → copy the value shown once.
4. `node cli/ngauto.js install && node cli/ngauto.js tunnel install`
5. Jira → NGBUGS → Project settings → Automation → Create rule:
   - Trigger **Issue assigned**
   - Condition **Issue fields condition**: Assignee = you; **Issue type** = Bug
   - Action **Send web request**: URL `https://your-name.ngrok-free.app/hooks/jira`, method POST,
     body *Custom data* `{"issueKey":"{{issue.key}}"}`, headers `Content-Type: application/json`
     and `x-ngauto-token: <secret>` (tick *Hidden*).
   - Turn it on, then "Validate" with a test issue and check `logs/ngauto.log`.

`ngauto kill` stops the listener **and** the tunnel.

## Setup

```bash
npm install
cp config/local.example.json config/local.json   # set jira.baseUrl, jira.accountId, jira.email, repo.path
node cli/ngauto.js secret set jira-api-token      # prompts; value never hits argv/logs
node cli/ngauto.js poll --dry-run                 # verify Jira auth + JQL
npm test
npm start                                        # foreground, or:
node cli/ngauto.js install                       # launchd, auto-start at login
```

## Commands

```
ngauto install | uninstall    launchd service
ngauto start | stop | restart
ngauto status                 service, kill switch, secrets, job counts
ngauto kill [reason]          EMERGENCY STOP (blocks webhooks, stops listener, halts jobs)
ngauto unkill
ngauto jobs [limit]
ngauto show <id> | retry <id> | cancel <id>
ngauto secret set <jira-webhook-secret|jira-api-token|gitlab-token>
ngauto sign <payload.json>    HMAC for local curl tests
ngauto poll [--dry-run]       one poll now (dry run shows what would be enqueued)
ngauto ticket <KEY> [--write] print TICKET.md (or write ~/.ngauto/workspaces/<KEY>/TICKET.md)
```

## Configuration

`config/default.json` → `config/local.json` (gitignored) → `$NGAUTO_CONFIG` → env
`NGAUTO__section__key=value`. Secrets: macOS Keychain service `ngauto` (default) or
`NGAUTO_SECRET_*` env vars (`secrets.provider=env`, for future cloud use).

## Security behaviour (implemented)

- Binds to loopback only (refuses otherwise unless `server.allowNonLoopback`).
- Only `POST /hooks/jira` exists publicly; `/healthz` is refused if it arrived via the tunnel.
- HMAC-SHA256 over the exact raw body, constant-time compare; unsigned/invalid → 401.
- Rate limit (global + per client via `cf-connecting-ip`) → 429; body > 1 MB → 413.
- Dedupe by `X-Atlassian-Webhook-Identifier` and by `issueKey + changelogId`; one active job per issue.
- Accepts only: configured project, issue type `Bug`, assignee change **to** `jira.accountId`, event ≤ 6 h old.
- Logs are JSON lines with key/pattern/runtime-secret redaction (`logs/ngauto.log`, 0600).
- Kill switch file `~/.ngauto/KILL`: 503s, listener self-terminates within 5 s, refuses to start.
- Restart recovery: in-flight jobs become `INTERRUPTED` and require a manual resume.
- `TICKET.md`: Jira text is size-capped, control/bidi chars stripped, and fenced between
  per-file random `UNTRUSTED_JIRA_CONTENT` markers; attachments are listed, never downloaded.
- Jira client: https origin only, redirects refused (credentials never leave the site),
  15 s timeout, 5 MB response cap, error messages never include response bodies.
