export interface GitHubConnection { owner: string; repo: string; branch: string }
export interface GitEntry { path: string; sha: string; mode: string; type: 'tree' | 'blob' | 'commit'; size?: number }
export interface GitSnapshot { head: string; tree: string; entries: GitEntry[] }
export type TreeChange = Pick<GitEntry, 'path' | 'mode' | 'type'> & { sha: string | null };

async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let content = '';
  for (let i = 0; i < bytes.length; i += 24576) content += btoa(String.fromCharCode(...bytes.subarray(i, i + 24576)));
  return content;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, action: string, readonly repositoryId?: string) {
    super(status === 401 ? 'The GitHub token is missing, expired, or was rejected.'
      : status === 403 ? 'GitHub refused access. Check the token permissions, branch rules, and API limits.'
      : status === 404 ? 'GitHub could not find the repository, branch, or object. Check the connection in settings.'
      : `GitHub could not ${action} (HTTP ${status}). Check the branch rules or try again.`);
  }
  get canReconnect() { return [401, 403, 404].includes(this.status); }
}

export class GitHubWriteUncertain extends Error {
  constructor() { super('GitHub did not confirm whether the branch was updated. Check the connection and retry; Notework kept a local copy.'); }
}

export class GitHubApi {
  constructor(readonly connection: GitHubConnection, private readonly token: string, private readonly repositoryId: string) {}

  async request<T>(path: string, action: string, method = 'GET', body?: unknown): Promise<T> {
    const { owner, repo } = this.connection;
    return this.fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, action, method, body);
  }

  private async fetchJson<T>(url: string, action: string, method: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method, redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new Error('Could not reach GitHub. Check your connection and try again.');
    }
    if (!response.ok) throw new GitHubApiError(response.status, action, this.repositoryId);
    return response.json() as Promise<T>;
  }

  private branchRef() { return 'heads/' + this.connection.branch.split('/').map(encodeURIComponent).join('/'); }
  async head() {
    return (await this.request<{ object: { sha: string } }>(`/git/ref/${this.branchRef()}`, 'read the branch')).object.sha;
  }

  async snapshot(head: string): Promise<GitSnapshot> {
    const commit = await this.request<{ tree: { sha: string } }>(`/git/commits/${head}`, 'read the commit');
    const tree = commit.tree.sha;
    const get = (sha: string, recursive = '') =>
      this.request<{ tree: GitEntry[]; truncated: boolean }>(`/git/trees/${sha}${recursive}`, 'read the folder');
    const result = await get(tree, '?recursive=1');
    if (!result.truncated) return { head, tree, entries: result.tree };
    const entries: GitEntry[] = [];
    const queue = [{ sha: tree, prefix: '' }];
    for (const { sha, prefix } of queue) {
      const directory = await get(sha);
      if (directory.truncated) throw new Error('A GitHub folder is too large to list completely.');
      for (const entry of directory.tree) {
        const path = prefix + entry.path;
        entries.push({ ...entry, path });
        if (entry.type === 'tree') queue.push({ sha: entry.sha, prefix: path + '/' });
      }
    }
    return { head, tree, entries };
  }

  async blob(sha: string) {
    const result = await this.request<{ content: string; encoding: string }>(`/git/blobs/${sha}`, 'read the file');
    if (result.encoding !== 'base64') throw new Error('GitHub returned an unsupported file encoding.');
    return new Blob([Uint8Array.from(atob(result.content.replace(/\s/g, '')), (char) => char.charCodeAt(0))]);
  }

  async createBlob(blob: Blob) {
    const content = await base64(blob);
    return (await this.request<{ sha: string }>('/git/blobs', 'store the file', 'POST', { content, encoding: 'base64' })).sha;
  }

  async publishFiles(expectedHeadOid: string, files: { path: string; blob: Blob }[], message: string) {
    const { owner, repo, branch } = this.connection;
    const additions = await Promise.all(files.map(async ({ path, blob }) => ({ path, contents: await base64(blob) })));
    type Result = {
      data?: { createCommitOnBranch?: { commit?: { oid: string; tree: { oid: string } } } };
      errors?: { type?: string }[];
    };
    let result: Result;
    try {
      result = await this.fetchJson<Result>('https://api.github.com/graphql', 'publish the edit', 'POST', {
        query: `mutation PublishEdit($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) { commit { oid tree { oid } } }
        }`,
        variables: { input: { branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
          expectedHeadOid, message: { headline: message }, fileChanges: { additions } } }
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status < 500 && error.status !== 408) throw error;
      throw new GitHubWriteUncertain();
    }
    const commit = result?.data?.createCommitOnBranch?.commit;
    if (commit?.oid && commit.tree?.oid) return { head: commit.oid, tree: commit.tree.oid };
    if (result?.errors?.some(({ type }) => type === 'FORBIDDEN' || type === 'RATE_LIMITED')) throw new GitHubApiError(403, 'publish the edit', this.repositoryId);
    if (result?.errors?.some(({ type }) => type === 'NOT_FOUND')) throw new GitHubApiError(404, 'publish the edit', this.repositoryId);
    if (result?.errors?.length && !result.data?.createCommitOnBranch) throw new GitHubApiError(422, 'publish the edit', this.repositoryId);
    throw new GitHubWriteUncertain();
  }

  async publish(base: GitSnapshot, tree: TreeChange[], message: string) {
    const next = await this.request<{ sha: string }>('/git/trees', 'create the changed tree', 'POST', { base_tree: base.tree, tree });
    const commit = await this.request<{ sha: string }>('/git/commits', 'create the commit', 'POST',
      { message, tree: next.sha, parents: [base.head] });
    if (await this.head() !== base.head) throw new GitHubApiError(409, 'update the branch');
    try {
      await this.request(`/git/refs/${this.branchRef()}`, 'update the branch', 'PATCH', { sha: commit.sha, force: false });
    } catch (error) {
      // If the response was lost after the update, avoid replaying the commit.
      if (await this.head().catch(() => undefined) !== commit.sha) {
        if (error instanceof GitHubApiError) throw error;
        throw new GitHubWriteUncertain();
      }
    }
    return { head: commit.sha, tree: next.sha };
  }
}
