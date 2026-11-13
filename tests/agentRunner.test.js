import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createAgentRunner, buildLogTail, codeErrors } from '../agent-runner/runner.js';
import { createPublisher, mrTitle } from '../gitlab-integration/publisher.js';
import { createGitlabClient } from '../gitlab-integration/gitlabClient.js';
import { claudeArgs, parseClaudeOutput, DISALLOWED_TOOLS } from '../agent-runner/claudeAgent.js';
import { createWorkspace, slugify, branchName } from '../agent-runner/workspace.js';
import { run } from '../agent-runner/exec.js';
import { openJobStore } from '../queue/jobStore.js';
import { nullLogger } from '../lib/logger.js';
import { tempDir } from './helpers.js';

const verdict = (v) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', total_cost_usd: 0.42, num_turns: 7, result: `Done.\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` });

test('parseClaudeOutput: fixed, needs_info, missing verdict, CLI error', () => {
  const ok = parseClaudeOutput(verdict({ status: 'fixed', summary: 'Fix crash\non nil profile', details: 'x' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'fixed');
  assert.equal(ok.summary, 'Fix crash on nil profile'); // control chars stripped
  assert.equal(ok.sessionId, 'sess-1');
  assert.equal(parseClaudeOutput(verdict({ status: 'needs_info', question: 'Which screen?' })).question, 'Which screen?');
  assert.equal(parseClaudeOutput(JSON.stringify({ subtype: 'success', result: 'no json here' })).reason, 'missing_verdict');
  assert.equal(parseClaudeOutput(verdict({ status: 'merged' })).reason, 'bad_verdict');
  assert.equal(parseClaudeOutput(JSON.stringify({ subtype: 'error_max_budget_usd', is_error: true })).ok, false);
  assert.equal(parseClaudeOutput('garbage').reason, 'unparseable_cli_output');
});

test('claudeArgs: no shell/web/MCP; user+project settings (corp proxy)', () => {
  const a = claudeArgs({ maxBudgetUsd: 5, resumeSessionId: 's' });
  const at = (flag) => a[a.indexOf(flag) + 1];
  for (const t of ['Bash', 'WebFetch', 'WebSearch']) assert.ok(DISALLOWED_TOOLS.includes(t));
  assert.equal(at('--disallowedTools'), DISALLOWED_TOOLS.join(','));
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(at('--setting-sources'), 'user,project');
  assert.equal(at('--max-budget-usd'), '5');
  assert.equal(at('--resume'), 's');
  assert.ok(!a.includes('--dangerously-skip-permissions'));
});

test('slugify / branchName / buildLogTail', () => {
  assert.equal(slugify('Crash on “Apply” button — iOS 18!!'), 'crash-on-apply-button-ios-18');
  assert.equal(slugify('$$$'), 'fix');
  assert.equal(branchName('NGBUGS-1', 'a'.repeat(80)).length, 'bugfix/NGBUGS-1-'.length + 40);
  const tail = buildLogTail('ok\n/x/A.swift:3:1: error: cannot find foo\nmore\n** BUILD FAILED **');
  assert.match(tail, /error: cannot find foo/);
  assert.doesNotMatch(tail, /^ok$/m);
});

test('workspace: real git worktree, changed files, forbidden paths, commit', async () => {
  const dir = tempDir();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = path.join(dir, 'origin');
  mkdirSync(path.join(origin, 'App/Sources'), { recursive: true });
  git(origin, 'init', '-q', '-b', 'release');
  git(origin, 'config', 'user.email', 't@t');
  git(origin, 'config', 'user.name', 't');
  writeFileSync(path.join(origin, 'App/Sources/A.swift'), 'let a = 1\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'init');
  const clone = path.join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  git(clone, 'config', 'user.email', 't@t');
  git(clone, 'config', 'user.name', 't');

  const ws = createWorkspace({ run });
  const wsDir = path.join(dir, 'ws', 'NGBUGS-1');
  const { worktree, branch } = await ws.prepare({ repoPath: clone, workspaceDir: wsDir, issueKey: 'NGBUGS-1', summary: 'Fix A', base: 'release' });
  assert.equal(branch, 'bugfix/NGBUGS-1-fix-a');
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'release'); // user's checkout untouched

  writeFileSync(path.join(worktree, 'App/Sources/A.swift'), 'let a = 2\n');
  writeFileSync(path.join(worktree, 'App/Sources/B.swift'), 'let b = 1\n');
  const files = await ws.changedFiles(worktree);
  assert.deepEqual(files.sort(), ['App/Sources/A.swift', 'App/Sources/B.swift']);
  assert.equal(ws.checkAllowed(files, { appSubdir: 'App' }).ok, true);
  assert.deepEqual(ws.checkAllowed(['App/fastlane/Fastfile', 'Jenkinsfile', 'App/x.xcconfig'], { appSubdir: 'App' }).bad.length, 3);
  assert.equal(ws.checkAllowed(['Other/x.swift'], { appSubdir: 'App' }).ok, false);

  const sha = await ws.commitAll(worktree, 'NGBUGS-1: fix');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(await ws.changedFiles(worktree), []);

  // Shared build tree: created on first sync, then switched to other commits in place.
  const buildDir = path.join(dir, 'buildtree');
  const sha1 = await ws.syncBuildTree({ repoPath: clone, buildDir, worktree });
  assert.equal(sha1, sha);
  assert.equal(readFileSync(path.join(buildDir, 'App/Sources/A.swift'), 'utf8'), 'let a = 2\n');
  writeFileSync(path.join(buildDir, 'stray.txt'), 'x');
  writeFileSync(path.join(worktree, 'App/Sources/A.swift'), 'let a = 3\n');
  await ws.commitAll(worktree, 'NGBUGS-1: more');
  await ws.syncBuildTree({ repoPath: clone, buildDir, worktree });
  assert.equal(readFileSync(path.join(buildDir, 'App/Sources/A.swift'), 'utf8'), 'let a = 3\n');
  assert.equal(existsSync(path.join(buildDir, 'stray.txt')), false);

  // Re-prepare (retry) resets the branch to origin/release and recreates the worktree.
  const again = await ws.prepare({ repoPath: clone, workspaceDir: wsDir, issueKey: 'NGBUGS-1', summary: 'Fix A', base: 'release' });
  assert.equal(readFileSync(path.join(again.worktree, 'App/Sources/A.swift'), 'utf8'), 'let a = 1\n');
});

// ---------- runner with fakes ----------

function harness({ agentOutputs = [], builds = [], changed = [['App/Sources/A.swift']], kill = false, publisher = null, buildFailOutput = 'X.swift:1:1: error: boom\n** BUILD FAILED **' } = {}) {
  const home = tempDir();
  const config = {
    paths: { home, workspaces: path.join(home, 'workspaces') },
    repo: { path: '/repo', appSubdir: 'App' },
    gitlab: { defaultTargetBranch: 'release' },
    jira: { ticket: { maxComments: 5 } },
    agent: { claudePath: '/bin/claude', timeoutMin: 1, maxBudgetUsd: 1, maxFixAttempts: 2, pollSec: 15 },
    validate: { enabled: true, timeoutMin: 1, command: ['xcodebuild', '-derivedDataPath', '{derivedData}', 'build'] },
  };
  const store = openJobStore(':memory:');
  const job = store.enqueue({ issueKey: 'NGBUGS-7', source: 'poll', dedupeKey: 'NGBUGS-7:assign:1' }).job;
  const calls = { claude: [], build: [], commits: [], notes: [] };
  const run = async (cmd, args, opts) => {
    if (cmd === '/bin/claude') {
      calls.claude.push({ args, input: opts.input });
      return { code: 0, stdout: agentOutputs.shift() ?? '', stderr: '', timedOut: false, aborted: false };
    }
    calls.build.push({ args, cwd: opts.cwd });
    const ok = builds.shift() ?? true;
    return { code: ok ? 0 : 65, stdout: ok ? '** BUILD SUCCEEDED **' : buildFailOutput, stderr: '', timedOut: false, aborted: false };
  };
  const workspace = {
    prepare: async () => ({ worktree: '/ws/NGBUGS-7/repo', branch: 'bugfix/NGBUGS-7-crash' }),
    changedFiles: async () => changed.shift() ?? [],
    checkAllowed: createWorkspace({ run }).checkAllowed,
    commitAll: async (_wt, msg) => (calls.commits.push(msg), 'a'.repeat(40)),
    diffStat: async () => ' 1 file changed, 2 insertions(+)',
    hasCommits: async () => true,
  };
  const jira = {
    getIssue: async (key) => ({ key, fields: { summary: 'Crash on apply', description: null, issuetype: { name: 'Bug' }, project: { key: 'NGBUGS' } } }),
    getComments: async () => [],
    browseUrl: (k) => `https://x.atlassian.net/browse/${k}`,
  };
  const runner = createAgentRunner({
    config, jobStore: store, jira, logger: nullLogger, killSwitch: { isActive: () => kill },
    notify: (t, m) => calls.notes.push(t), run, workspace, publisher, setTimer: () => null, clearTimer: () => {},
  });
  runner.start();
  return { runner, store, job, calls, config };
}

test('runner happy path: QUEUED → … → VALIDATED, ticket written, commit + build', async () => {
  const h = harness({ agentOutputs: [verdict({ status: 'fixed', summary: 'Guard nil profile', details: 'root cause' })] });
  await h.runner.tick();
  const j = h.store.getJob(h.job.id);
  assert.equal(j.state, 'VALIDATED');
  assert.equal(j.branch, 'bugfix/NGBUGS-7-crash');
  assert.deepEqual(h.store.jobEvents(j.id).map((e) => e.to_state), ['QUEUED', 'FETCHING', 'ANALYZING', 'IMPLEMENTING', 'VALIDATING', 'VALIDATED']);
  assert.ok(existsSync(path.join(h.config.paths.workspaces, 'NGBUGS-7', 'TICKET.md')));
  assert.match(h.calls.claude[0].input, /UNTRUSTED_JIRA_CONTENT/);
  assert.match(h.calls.commits[0], /^NGBUGS-7: Guard nil profile/);
  assert.equal(h.calls.build[0].cwd, '/ws/NGBUGS-7/repo/App');
  assert.ok(h.calls.build[0].args.includes(path.join(h.config.paths.home, 'DerivedData')));
  assert.ok(h.calls.notes.includes('NGBUGS-7: fix ready'));
});

test('runner: needs_info stops without committing', async () => {
  const h = harness({ agentOutputs: [verdict({ status: 'needs_info', question: 'Which iOS version?' })] });
  await h.runner.tick();
  const j = h.store.getJob(h.job.id);
  assert.equal(j.state, 'NEEDS_INFO');
  assert.equal(j.error, 'Which iOS version?');
  assert.equal(h.calls.commits.length, 0);
});

test('runner: forbidden file change fails the job', async () => {
  const h = harness({ agentOutputs: [verdict({ status: 'fixed', summary: 's' })], changed: [['App/fastlane/Fastfile']] });
  await h.runner.tick();
  const j = h.store.getJob(h.job.id);
  assert.equal(j.state, 'FAILED');
  assert.match(j.error, /forbidden paths: App\/fastlane\/Fastfile/);
  assert.equal(h.calls.commits.length, 0);
});

test('runner: compile error → agent retry (resumed session) → VALIDATED', async () => {
  const h = harness({
    agentOutputs: [verdict({ status: 'fixed', summary: 's' }), verdict({ status: 'fixed', summary: 'fix build' })],
    builds: [false, true],
    changed: [['App/A.swift'], ['App/A.swift']],
  });
  await h.runner.tick();
  assert.equal(h.store.getJob(h.job.id).state, 'VALIDATED');
  assert.equal(h.calls.claude.length, 2);
  const retryArgs = h.calls.claude[1].args;
  assert.equal(retryArgs[retryArgs.indexOf('--resume') + 1], 'sess-1');
  assert.match(h.calls.claude[1].input, /error: boom/);
  assert.equal(h.calls.commits.length, 2);
});

test('runner: compile keeps failing → VALIDATION_FAILED after maxFixAttempts', async () => {
  const fixed = verdict({ status: 'fixed', summary: 's' });
  const h = harness({ agentOutputs: [fixed, fixed, fixed], builds: [false, false, false], changed: [['App/A.swift'], ['App/A.swift'], ['App/A.swift']] });
  await h.runner.tick();
  assert.equal(h.store.getJob(h.job.id).state, 'VALIDATION_FAILED');
  assert.equal(h.calls.build.length, 3); // initial + 2 fix attempts
});

test('runner: does nothing while the kill switch is active', async () => {
  const h = harness({ kill: true });
  await h.runner.tick();
  assert.equal(h.store.getJob(h.job.id).state, 'QUEUED');
  assert.equal(h.calls.claude.length, 0);
});

test('runner: agent CLI error → FAILED; exception mid-job → FAILED with message', async () => {
  const h = harness({ agentOutputs: [JSON.stringify({ subtype: 'error_max_budget_usd', is_error: true })] });
  await h.runner.tick();
  assert.match(h.store.getJob(h.job.id).error, /error_max_budget_usd/);

  const h2 = harness();
  h2.runner.stop();
  const r2 = createAgentRunner({
    config: h2.config, jobStore: h2.store, logger: nullLogger, killSwitch: { isActive: () => false },
    jira: { getIssue: async () => { throw new Error('Jira API 500'); }, getComments: async () => [], browseUrl: () => '' },
    run: async () => ({}), workspace: {}, setTimer: () => null, clearTimer: () => {},
  });
  r2.start();
  await r2.tick();
  const j2 = h2.store.getJob(h2.job.id);
  assert.equal(j2.state, 'FAILED');
  assert.match(j2.error, /Jira API 500/);
});

test('runner: non-code build failure (Pods script) → VALIDATION_FAILED without asking Claude', async () => {
  const h = harness({
    agentOutputs: [verdict({ status: 'fixed', summary: 's' })],
    builds: [false],
    buildFailOutput: "Pods-NaukriGulf-frameworks.sh: line 132: ARCHS[@]: unbound variable\nCommand PhaseScriptExecution failed with a nonzero exit code\n** BUILD FAILED **\nThe following build commands failed:\n\tPhaseScriptExecution [CP] Embed Pods Frameworks",
  });
  await h.runner.tick();
  const j = h.store.getJob(h.job.id);
  assert.equal(j.state, 'VALIDATION_FAILED');
  assert.match(j.error, /non-code reason/);
  assert.equal(h.calls.claude.length, 1); // no "fix the build" run
});

test('runner: Pods compile errors are not treated as code errors', () => {
  assert.equal(codeErrors('/w/repo/App/Pods/Foo/Bar.swift:3:1: error: x').length, 0);
  assert.equal(codeErrors('/w/repo/App/Classes/A.swift:3:1: error: x').length, 1);
});

test('runner: VALIDATED → PUSHING → MR_DRAFT with publisher', async () => {
  const published = [];
  const publisher = { publish: async ({ job, branch }) => (published.push(branch), { mrUrl: 'https://gl/mr/1', created: true }) };
  const h = harness({ agentOutputs: [verdict({ status: 'fixed', summary: 'Fix' })], publisher });
  await h.runner.tick();
  const j = h.store.getJob(h.job.id);
  assert.equal(j.state, 'MR_DRAFT');
  assert.equal(j.mr_url, 'https://gl/mr/1');
  assert.deepEqual(published, ['bugfix/NGBUGS-7-crash']);
  assert.deepEqual(h.store.jobEvents(j.id).map((e) => e.to_state).slice(-3), ['VALIDATED', 'PUSHING', 'MR_DRAFT']);
});

test('runner: publish failure → FAILED; "publish" mode retries only push+MR; "rebuild" skips Claude', async () => {
  let fail = true;
  const publisher = { publish: async () => { if (fail) throw new Error('GitLab API 401'); return { mrUrl: 'https://gl/mr/2', created: true }; } };
  const h = harness({ agentOutputs: [verdict({ status: 'fixed', summary: 'Fix' })], publisher });
  mkdirSync(path.join(h.config.paths.workspaces, 'NGBUGS-7', 'repo'), { recursive: true });
  await h.runner.tick();
  let j = h.store.getJob(h.job.id);
  assert.equal(j.state, 'FAILED');
  assert.match(j.error, /push\/MR failed: GitLab API 401/);

  fail = false;
  h.store.transition(j.id, 'QUEUED', { note: 'publish' });
  await h.runner.tick();
  j = h.store.getJob(h.job.id);
  assert.equal(j.state, 'MR_DRAFT');
  assert.equal(h.calls.claude.length, 1);
  assert.equal(h.calls.build.length, 1); // publish mode: no new build

  h.store.transition(j.id, 'QUEUED', { note: 'rebuild' });
  await h.runner.tick();
  assert.equal(h.store.getJob(h.job.id).state, 'MR_DRAFT');
  assert.equal(h.calls.claude.length, 1); // still no new Claude run
  assert.equal(h.calls.build.length, 2); // rebuild compiled again
});

test('runner: rebuild without an existing fix fails clearly', async () => {
  const h = harness();
  h.store.transition(h.job.id, 'CANCELLED');
  const id = h.store.enqueue({ issueKey: 'NGBUGS-8', source: 'poll', dedupeKey: 'x' }).job.id;
  h.store.transition(id, 'CANCELLED');
  // QUEUED with rebuild note but no branch/worktree
  const j2 = h.store.enqueue({ issueKey: 'NGBUGS-9', source: 'poll', dedupeKey: 'y' }).job;
  h.store.transition(j2.id, 'FETCHING'); h.store.transition(j2.id, 'FAILED'); h.store.transition(j2.id, 'QUEUED', { note: 'rebuild' });
  await h.runner.tick();
  assert.match(h.store.getJob(j2.id).error, /cannot rebuild: no existing fix/);
});

test('workspace.push refuses non-bugfix and protected branches', async () => {
  const ws = createWorkspace({ run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  await assert.rejects(ws.push('/x', 'release', { protectedBranches: ['release'] }), /refusing/);
  await assert.rejects(ws.push('/x', 'feature/foo'), /refusing/);
  await assert.rejects(ws.push('/x', 'bugfix/NGBUGS-1-x;rm -rf'), /refusing/);
  await ws.push('/x', 'bugfix/NGBUGS-1-fix-a', { protectedBranches: ['release'] });
});

test('publisher: Draft title, description from commits, reuses an open MR', async () => {
  const calls = [];
  const gitlab = {
    findOpenMr: async () => (calls.some((c) => c[0] === 'create') ? { iid: 5, web_url: 'https://gl/mr/5' } : null),
    createMr: async (mr) => (calls.push(['create', mr]), { web_url: 'https://gl/mr/5' }),
    updateMr: async (iid, p) => (calls.push(['update', iid, p]), { web_url: 'https://gl/mr/5' }),
  };
  const workspace = {
    push: async () => calls.push(['push']),
    commitMessages: async () => ['NGBUGS-7: Guard nil profile\n\nRoot cause: x.\n\nAutomated fix by ng-automation (Claude Code).\nJira: u', 'NGBUGS-7: fix build after automated change'],
    diffStat: async () => ' A.swift | 2 +-\n 1 file changed',
  };
  const config = { gitlab: { defaultTargetBranch: 'release', protectedBranches: ['release'] } };
  const pub = createPublisher({ config, gitlab, workspace, jira: { browseUrl: (k) => `https://j/${k}` }, logger: nullLogger });
  const job = { id: 1, issue_key: 'NGBUGS-7', target_branch: 'release' };
  const r1 = await pub.publish({ job, worktree: '/w', branch: 'bugfix/NGBUGS-7-x' });
  assert.equal(r1.created, true);
  const mr = calls.find((c) => c[0] === 'create')[1];
  assert.equal(mr.title, 'Draft: NGBUGS-7: Guard nil profile');
  assert.equal(mr.target_branch, 'release');
  assert.match(mr.description, /Root cause: x\./);
  assert.doesNotMatch(mr.description, /Automated fix by ng-automation/);
  assert.match(mr.description, /fix build after automated change/);
  const r2 = await pub.publish({ job, worktree: '/w', branch: 'bugfix/NGBUGS-7-x' });
  assert.equal(r2.created, false);
  assert.equal(calls.at(-1)[0], 'update');
  assert.equal(mrTitle('NGBUGS-7', 'NGBUGS-7: x'), 'Draft: NGBUGS-7: x');
});

test('gitlabClient: https only, token header, project path encoded, error detail', async () => {
  assert.throws(() => createGitlabClient({ baseUrl: 'http://gl', projectPath: 'a/b', getToken: async () => 't' }), /https/);
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), opts });
    if (opts.method === 'POST') return new Response(JSON.stringify({ message: ['Another open merge request already exists'] }), { status: 409 });
    return new Response(JSON.stringify([{ iid: 1 }]), { status: 200 });
  };
  const gl = createGitlabClient({ baseUrl: 'https://gitlab.example.com', projectPath: 'naukrigulf/iosapp', getToken: async () => 'tok', fetchImpl });
  assert.equal((await gl.findOpenMr('bugfix/X-1')).iid, 1);
  assert.match(seen[0].url, /\/api\/v4\/projects\/naukrigulf%2Fiosapp\/merge_requests\?state=opened&source_branch=bugfix%2FX-1/);
  assert.equal(seen[0].opts.headers['PRIVATE-TOKEN'], 'tok');
  assert.equal(seen[0].opts.redirect, 'error');
  await assert.rejects(gl.createMr({}), /409.*Another open merge request/);
});
