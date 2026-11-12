// Minimal Jira Cloud REST v3 client (Basic auth: account email + API token).
// - credentials are only ever sent to the configured https origin (redirects are refused)
// - every request has a timeout and a response size cap
// - error objects never include response bodies (they can echo request data)
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

export class JiraApiError extends Error {
  constructor(status, path, { retryAfterSec } = {}) {
    super(`Jira API ${status} for ${path}`);
    this.name = 'JiraApiError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

function assertIssueKey(key) {
  if (typeof key !== 'string' || !ISSUE_KEY_RE.test(key)) throw new Error(`Invalid issue key: ${String(key).slice(0, 40)}`);
}

export function createJiraClient({ baseUrl, email, getToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000, maxBytes = 5 * 1024 * 1024 }) {
  if (!baseUrl) throw new Error('jira.baseUrl is not configured');
  if (!email) throw new Error('jira.email is not configured');
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:') throw new Error('jira.baseUrl must use https');

  async function request(method, path, { query, body } = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) throw new Error('Refusing cross-origin Jira request');
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    const token = await getToken();
    const headers = {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      await res.body?.cancel().catch(() => {});
      throw new JiraApiError(res.status, url.pathname, { retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined });
    }
    const len = Number(res.headers.get('content-length'));
    if (len > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Jira response too large (${len} bytes)`);
    }
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('Jira response too large');
    return text ? JSON.parse(text) : null;
  }

  /** JQL search via the enhanced endpoint (POST /rest/api/3/search/jql, token pagination). */
  async function searchIssues(jql, { fields = ['summary'], pageSize = 50, maxPages = 5 } = {}) {
    const issues = [];
    let nextPageToken;
    for (let page = 0; page < maxPages; page++) {
      const r = await request('POST', '/rest/api/3/search/jql', { body: { jql, fields, maxResults: pageSize, nextPageToken } });
      issues.push(...(r?.issues ?? []));
      nextPageToken = r?.nextPageToken;
      if (!nextPageToken || r?.isLast) break;
    }
    return issues;
  }

  async function getIssue(key, { fields } = {}) {
    assertIssueKey(key);
    return request('GET', `/rest/api/3/issue/${key}`, { query: { fields: fields?.join(',') } });
  }

  /** Full changelog (oldest first), capped at maxPages * 100 histories. */
  async function getChangelog(key, { maxPages = 20 } = {}) {
    assertIssueKey(key);
    const out = [];
    let startAt = 0;
    for (let page = 0; page < maxPages; page++) {
      const r = await request('GET', `/rest/api/3/issue/${key}/changelog`, { query: { startAt, maxResults: 100 } });
      const values = r?.values ?? [];
      out.push(...values);
      startAt += values.length;
      if (r?.isLast || values.length === 0 || (Number.isFinite(r?.total) && startAt >= r.total)) break;
    }
    return out;
  }

  /** Most recent comments first. */
  async function getComments(key, { maxResults = 15 } = {}) {
    assertIssueKey(key);
    const r = await request('GET', `/rest/api/3/issue/${key}/comment`, { query: { orderBy: '-created', maxResults } });
    return r?.comments ?? [];
  }

  const myself = () => request('GET', '/rest/api/3/myself');

  /** Adds a plain-text comment (paragraphs split on blank lines) as the token's user. */
  async function addComment(key, text) {
    assertIssueKey(key);
    const paragraphs = String(text).replace(/\r\n/g, '\n').trim().split(/\n{2,}/).filter(Boolean);
    if (!paragraphs.length) throw new Error('Empty comment');
    const content = paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
    }));
    return request('POST', `/rest/api/3/issue/${key}/comment`, { body: { body: { type: 'doc', version: 1, content } } });
  }

  return { searchIssues, getIssue, getChangelog, getComments, addComment, myself, browseUrl: (key) => new URL(`/browse/${key}`, origin).href };
}
