// Git worktree per issue: the agent never touches the user's own checkout.
// <workspaces>/<KEY>/repo  -> worktree on bugfix/<KEY>-<slug>, based on origin/<base>
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { childEnv } from './exec.js';

export function slugify(text, max = 40) {
  const s = String(text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'fix';
}

export function branchName(issueKey, summary) {
  return `bugfix/${issueKey}-${slugify(summary)}`;
}

// Paths the agent must never change (build/release/CI plumbing and agent config).
// Matched against repo-relative paths.
export const DEFAULT_FORBIDDEN = [
  /(^|\/)Jenkinsfile$/,
  /(^|\/)fastlane\//,
  /(^|\/)Gemfile(\.lock)?$/,
  /(^|\/)Podfile(\.lock)?$/,
  /(^|\/)Pods\//,
  /(^|\/)LocalPods\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)\.claude\//,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)scripts\//,
  /\.(xcconfig|entitlements|mobileprovision|p12|pem|key)$/,
  /(^|\/)GoogleService-Info.*\.plist$/,
];

export function createWorkspace({ run, git = 'git' }) {
  async function sh(cwd, args, opts = {}) {
    const r = await run(git, args, { cwd, timeoutMs: opts.timeoutMs ?? 5 * 60_000, signal: opts.signal, ...(opts.env ? { env: opts.env } : {}) });
    if (r.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
      throw new Error(`git ${args[0]} failed (${r.timedOut ? 'timeout' : `exit ${r.code}`}): ${msg}`);
    }
    return r.stdout;
  }

  /** Fresh worktree for the issue on a (re)created local branch from origin/<base>. */
  async function prepare({ repoPath, workspaceDir, issueKey, summary, base, signal }) {
    if (!existsSync(path.join(repoPath, '.git'))) throw new Error(`repo.path is not a git checkout: ${repoPath}`);
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    const worktree = path.join(workspaceDir, 'repo');
    const branch = branchName(issueKey, summary);

    await sh(repoPath, ['fetch', '--no-tags', 'origin', base], { signal, timeoutMs: 15 * 60_000 });
    if (existsSync(worktree)) await sh(repoPath, ['worktree', 'remove', '--force', worktree], { signal });
    await sh(repoPath, ['worktree', 'prune'], { signal });
    // -B: (re)create the local branch at origin/<base>. Only ever a local, unpushed branch at this stage.
    await sh(repoPath, ['worktree', 'add', '--no-track', '-B', branch, worktree, `origin/${base}`], { signal, timeoutMs: 15 * 60_000 });
    return { worktree, branch };
  }

  /** Repo-relative paths with any change (tracked or untracked). */
  async function changedFiles(worktree) {
    const out = await sh(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = out.split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      const status = entry.slice(0, 2);
      files.push(entry.slice(3));
      if (status[0] === 'R' || status[0] === 'C') files.push(parts[++i]); // rename/copy: next item is the source
    }
    return [...new Set(files)];
  }

  function checkAllowed(files, { appSubdir, forbidden = DEFAULT_FORBIDDEN }) {
    const prefix = appSubdir ? `${appSubdir.replace(/\/+$/, '')}/` : '';
    const bad = files.filter((f) => (prefix && !f.startsWith(prefix)) || forbidden.some((re) => re.test(f)));
    return { ok: bad.length === 0, bad };
  }

  async function commitAll(worktree, message) {
    await sh(worktree, ['add', '--all']);
    await sh(worktree, ['commit', '--no-verify', '-m', message]);
    return (await sh(worktree, ['rev-parse', 'HEAD'])).trim();
  }

  async function diffStat(worktree, base) {
    return sh(worktree, ['diff', '--stat', `origin/${base}...HEAD`]);
  }

  async function hasCommits(worktree, base) {
    try {
      return Number((await sh(worktree, ['rev-list', '--count', `origin/${base}..HEAD`])).trim()) > 0;
    } catch {
      return false;
    }
  }

  /** Commit messages on the branch, oldest first. */
  async function commitMessages(worktree, base) {
    const out = await sh(worktree, ['log', '--reverse', '--format=%B%x00', `origin/${base}..HEAD`]);
    return out.split('\0').map((m) => m.trim()).filter(Boolean);
  }

  /**
   * Push the issue branch. Only automation-owned branches (bugfix/…) and never a protected one.
   * With { remoteUrl, token }: push over HTTPS using the GitLab token as an Authorization header
   * passed via GIT_CONFIG_* env (never in argv or the URL); the saved credential helper is bypassed.
   * Lease = the remote sha we just read, so a commit pushed by someone else in between is never lost;
   * a retry (branch recreated from origin/<base>) intentionally replaces the automation's own branch.
   */
  async function push(worktree, branch, { protectedBranches = [], signal, remoteUrl, token } = {}) {
    if (!/^bugfix\/[A-Z][A-Z0-9_]+-\d+(-[a-z0-9-]+)?$/.test(branch) || protectedBranches.includes(branch)) {
      throw new Error(`refusing to push branch "${branch}"`);
    }
    const ref = `refs/heads/${branch}`;
    let target = 'origin';
    let env;
    if (token) {
      if (!/^https:\/\/[^@\s]+$/.test(remoteUrl ?? '')) throw new Error('push remoteUrl must be an https URL without credentials');
      target = remoteUrl;
      env = childEnv({
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`,
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '',
      });
    }
    const remoteSha = ((await sh(worktree, ['ls-remote', target, ref], { signal, env, timeoutMs: 2 * 60_000 })).split(/\s/)[0] ?? '').trim();
    await sh(worktree, ['push', '--no-verify', `--force-with-lease=${ref}:${remoteSha}`, target, `HEAD:${ref}`], { signal, env, timeoutMs: 10 * 60_000 });
    return remoteSha || null;
  }

  /**
   * One fixed build directory for every job: check out the job's HEAD there (detached) so Xcode
   * sees the same source paths each time and only recompiles what changed. git leaves unchanged
   * files untouched (mtimes kept), which is what makes the incremental build work.
   */
  async function syncBuildTree({ repoPath, buildDir, worktree, signal }) {
    const sha = (await sh(worktree, ['rev-parse', 'HEAD'])).trim();
    if (!existsSync(path.join(buildDir, '.git'))) {
      await sh(repoPath, ['worktree', 'prune'], { signal });
      await sh(repoPath, ['worktree', 'add', '--detach', buildDir, sha], { signal, timeoutMs: 15 * 60_000 });
    } else {
      await sh(buildDir, ['checkout', '--force', '--detach', sha], { signal, timeoutMs: 10 * 60_000 });
      await sh(buildDir, ['clean', '-fdq'], { signal });
    }
    return sha;
  }

  return { prepare, changedFiles, checkAllowed, commitAll, diffStat, hasCommits, commitMessages, push, syncBuildTree };
}
