// Minimal GitLab REST v4 client (PRIVATE-TOKEN). https origin only, redirects refused,
// timeout + size cap, error messages never include response bodies.
export class GitlabApiError extends Error {
  constructor(status, path, detail) {
    super(`GitLab API ${status} for ${path}${detail ? ` (${detail})` : ''}`);
    this.name = 'GitlabApiError';
    this.status = status;
  }
}

export function createGitlabClient({ baseUrl, projectPath, getToken, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!baseUrl || !projectPath) throw new Error('gitlab.baseUrl and gitlab.projectPath are required');
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:') throw new Error('gitlab.baseUrl must use https');
  const project = encodeURIComponent(projectPath);

  async function request(method, path, { query, body } = {}) {
    const url = new URL(`/api/v4${path}`, origin);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, {
      method,
      headers: { 'PRIVATE-TOKEN': await getToken(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // GitLab's validation message (e.g. "Another open merge request already exists") is safe and useful.
      let detail;
      try {
        const m = JSON.parse(text).message;
        detail = (Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : '').slice(0, 200) || undefined;
      } catch {}
      throw new GitlabApiError(res.status, url.pathname, detail);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    currentUser: () => request('GET', '/user'),
    findOpenMr: async (sourceBranch) => (await request('GET', `/projects/${project}/merge_requests`, { query: { state: 'opened', source_branch: sourceBranch } }))?.[0] ?? null,
    createMr: (mr) => request('POST', `/projects/${project}/merge_requests`, { body: mr }),
    updateMr: (iid, patch) => request('PUT', `/projects/${project}/merge_requests/${iid}`, { body: patch }),
  };
}
