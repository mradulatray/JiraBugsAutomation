// Phase 6: push the bug branch and open (or update) a Draft MR into the target branch.
// The MR is always a Draft; merging stays a human decision.

export function mrTitle(issueKey, summary) {
  const s = String(summary ?? '').replace(new RegExp(`^${issueKey}:\\s*`), '').trim() || 'automated fix';
  return `Draft: ${issueKey}: ${s}`.slice(0, 250);
}

export function mrDescription({ issueKey, jiraUrl, messages, diffStat, buildCmd }) {
  const first = messages[0] ?? '';
  const body = first.split('\n').slice(1).join('\n').replace(/\n*Automated fix by[\s\S]*$/, '').trim();
  const followUps = messages.slice(1).map((m) => `- ${m.split('\n')[0]}`).join('\n');
  return [
    `**Jira:** [${issueKey}](${jiraUrl})`,
    '',
    '### What changed',
    body || '_See commits._',
    followUps ? `\n### Follow-up commits\n${followUps}` : '',
    '',
    '### Files',
    '```',
    diffStat.trim() || '(none)',
    '```',
    '',
    '### Checks',
    `- [x] Compiles: \`${buildCmd}\``,
    '- [ ] Reviewed by a developer',
    '- [ ] Tested on simulator/device',
    '',
    '---',
    '_Created automatically by JiraBugAutomation (Claude Code). This is a Draft: review and test before marking ready._',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

export function createPublisher({ config, gitlab, workspace, jira, logger, getToken = null }) {
  const remoteUrl = getToken ? `${config.gitlab.baseUrl.replace(/\/+$/, '')}/${config.gitlab.projectPath}.git` : null;
  const target = config.gitlab.defaultTargetBranch;
  return {
    async publish({ job, worktree, branch }) {
      if (job.target_branch && job.target_branch !== target) throw new Error(`job targets ${job.target_branch}, config targets ${target}`);
      await workspace.push(worktree, branch, { protectedBranches: config.gitlab.protectedBranches, ...(getToken ? { remoteUrl, token: await getToken() } : {}) });
      logger.info('job.pushed', { jobId: job.id, issueKey: job.issue_key, branch });

      const messages = await workspace.commitMessages(worktree, target);
      const summary = (messages[0] ?? '').split('\n')[0];
      const mr = {
        source_branch: branch,
        target_branch: target,
        title: mrTitle(job.issue_key, summary),
        description: mrDescription({
          issueKey: job.issue_key,
          jiraUrl: jira.browseUrl(job.issue_key),
          messages,
          diffStat: await workspace.diffStat(worktree, target),
          buildCmd: 'xcodebuild NaukriGulf_Debug (iOS Simulator)',
        }),
        remove_source_branch: true,
        labels: (config.gitlab.mrLabels ?? []).join(',') || undefined,
      };
      const existing = await gitlab.findOpenMr(branch);
      if (existing) {
        const u = await gitlab.updateMr(existing.iid, { title: mr.title, description: mr.description });
        return { mrUrl: u?.web_url ?? existing.web_url, created: false };
      }
      const created = await gitlab.createMr(mr);
      return { mrUrl: created.web_url, created: true };
    },
  };
}
