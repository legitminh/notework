// Log in with the Notework GitHub App. No secret ships in the web or native app.
// The web app uses GitHub's redirect flow: GitHub returns to Notework with a one-time
// code, and the login relay (relay/github-login-worker.js) adds the app's client secret
// to exchange it, with PKCE so an intercepted code is useless. The native app uses the
// device flow, which needs only the public client ID, and sends its two requests from
// Rust because GitHub's login endpoints refuse browser (CORS) requests.
// The app is set to issue user tokens that do not expire, so one login lasts until
// the person revokes it on GitHub. Tokens stay in IndexedDB and go only to GitHub.
import { focusApp, githubLogin, isNativeApp, openGitHubLogin } from '../native-fs';
import { readAccount, storeAccount } from './storage';

/** Values from the GitHub App's settings page. Empty until the app exists. */
export const GITHUB_APP = {
  /** Public client ID, from the app's General page. */
  clientId: 'Iv23liQC2jMk0ctskelI',
  /** The `<slug>` in github.com/apps/<slug>. */
  slug: 'minh-notework',
  /** HTTPS origin of the login relay for the web app, without a trailing slash. */
  relay: 'https://notework-github-login.totallylegitperson-example.workers.dev'
};

export interface GitHubAccount { token: string; login: string }
export interface DeviceCode { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }
export interface AccessibleRepository { owner: string; repo: string; branch: string; private: boolean; canPush: boolean }

/** Why GitHub login is unavailable here, or '' when it can be used. */
export function githubLoginUnavailable() {
  if (!GITHUB_APP.clientId) return 'GitHub login is not set up in this version yet. use a personal access token for now.';
  if (!isNativeApp() && !GITHUB_APP.relay) return 'GitHub login in the browser needs the login relay, which is not set up yet. use the native app or a personal access token for now.';
  return '';
}

export const installUrl = () => GITHUB_APP.slug
  ? `https://github.com/apps/${encodeURIComponent(GITHUB_APP.slug)}/installations/new` : 'https://github.com/settings/installations';

type Step = 'code' | 'token';
async function loginRequest<T>(step: Step, params: Record<string, string>): Promise<T> {
  if (isNativeApp()) {
    return JSON.parse(await githubLogin(step, params)) as T;
  }
  const path = step === 'code' ? '/login/device/code' : '/login/oauth/access_token';
  let response: Response;
  try {
    response = await fetch(GITHUB_APP.relay + path, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params), signal: AbortSignal.timeout(15000)
    });
  } catch { throw new Error('could not reach GitHub. check your connection and try again.'); }
  if (!response.ok) throw new Error(`GitHub login failed (HTTP ${response.status}). try again.`);
  return await response.json() as T;
}

const LOGIN_KEY = 'notework:github-login';
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Web app: leave for GitHub's approval page. GitHub sends the person back to this app's callback URL. */
export async function startRedirectLogin() {
  const unavailable = githubLoginUnavailable();
  if (unavailable) throw new Error(unavailable);
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  // The page reloads on return, so the check values must outlive it. They are single use.
  try { sessionStorage.setItem(LOGIN_KEY, JSON.stringify({ state, verifier })); }
  catch { throw new Error('this browser blocked session storage, which GitHub login needs.'); }
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({ client_id: GITHUB_APP.clientId, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  location.assign(url);
}

/** Web app: finish a login GitHub just returned from, if any. The app's start-up navigation then clears the address bar. */
export async function finishRedirectLogin(): Promise<GitHubAccount | undefined> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code'), state = params.get('state'), denied = params.get('error');
  if (!state || (!code && !denied)) return undefined;
  let saved: { state?: string; verifier?: string } = {};
  try { saved = JSON.parse(sessionStorage.getItem(LOGIN_KEY) ?? '{}'); sessionStorage.removeItem(LOGIN_KEY); } catch { /* Treated as unknown below. */ }
  if (saved.state !== state || !saved.verifier) throw new Error('this GitHub login did not start here or has expired. log in again.');
  if (denied) throw new Error('the GitHub login was cancelled on GitHub.');
  const result = await loginRequest<{ access_token?: string; error?: string }>('token', {
    client_id: GITHUB_APP.clientId, code: code!, code_verifier: saved.verifier
  });
  if (!result.access_token) throw new Error(result.error === 'incorrect_client_credentials'
    ? 'the login relay is missing the GitHub App client secret.' : 'GitHub did not finish the login. log in again.');
  return saveAccount(result.access_token);
}

async function saveAccount(token: string) {
  const login = (await githubGet<{ login: string }>('/user', token)).login;
  const account = { token, login };
  await storeAccount(account);
  return account;
}

/** Copy text from a click handler even when the text arrives later (Safari and WebKit allow this form). */
export function copyLater(text: Promise<string>) {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      void navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((value) => new Blob([value], { type: 'text/plain' })) })])
        .catch(() => text.then((value) => navigator.clipboard?.writeText(value)).catch(() => {}));
      return;
    }
  } catch { /* Fall back to a plain write below. */ }
  void text.then((value) => navigator.clipboard?.writeText(value)).catch(() => {});
}

/** Native app: open GitHub's code page in the system browser. */
export const openDeviceLogin = (code: DeviceCode) => openGitHubLogin(code.verification_uri);

export async function startDeviceLogin() {
  const unavailable = githubLoginUnavailable();
  if (unavailable) throw new Error(unavailable);
  const code = await loginRequest<DeviceCode & { error?: string; error_description?: string }>('code', { client_id: GITHUB_APP.clientId });
  if (code.error || !code.device_code) throw new Error(code.error === 'device_flow_disabled'
    ? 'device flow is turned off for the Notework GitHub App.' : 'GitHub did not start the login. try again.');
  return code;
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Wait until the person approves the code on GitHub, then save and return the account. */
export async function finishDeviceLogin(code: DeviceCode, signal: AbortSignal): Promise<GitHubAccount> {
  let interval = Math.max(5, code.interval || 5);
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await wait(interval * 1000, signal);
    const result = await loginRequest<{ access_token?: string; error?: string; interval?: number }>('token', {
      client_id: GITHUB_APP.clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    });
    signal.throwIfAborted();
    if (result.access_token) {
      const account = await saveAccount(result.access_token);
      if (isNativeApp()) void focusApp().catch(() => {});
      return account;
    }
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval = result.interval ?? interval + 5; continue; }
    if (result.error === 'access_denied') throw new Error('the GitHub login was cancelled on GitHub.');
    if (result.error === 'expired_token') break;
    throw new Error('GitHub did not finish the login. try again.');
  }
  throw new Error('the login code expired. start the GitHub login again.');
}

export const savedAccount = () => readAccount().catch(() => undefined);
export const forgetAccount = () => storeAccount(undefined);

async function githubGet<T>(path: string, token: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch('https://api.github.com' + path, {
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10' },
      signal: AbortSignal.timeout(15000)
    });
  } catch { throw new Error('could not reach GitHub. check your connection and try again.'); }
  if (response.status === 401) throw new Error('the GitHub login expired or was revoked. log in again.');
  if (!response.ok) throw new Error(`GitHub could not list your repositories (HTTP ${response.status}). try again.`);
  return await response.json() as T;
}

/** Repositories the person allowed the app to reach, across every account it is installed on. */
export async function accessibleRepositories(token: string) {
  const repositories: AccessibleRepository[] = [];
  type Installations = { installations: { id: number }[] };
  type Repositories = { total_count: number; repositories: { name: string; owner: { login: string }; default_branch: string;
    private: boolean; archived: boolean; permissions?: { push?: boolean } }[] };
  for (let page = 1; ; page++) {
    const { installations } = await githubGet<Installations>(`/user/installations?per_page=100&page=${page}`, token);
    for (const { id } of installations) {
      for (let repoPage = 1; ; repoPage++) {
        const result = await githubGet<Repositories>(`/user/installations/${id}/repositories?per_page=100&page=${repoPage}`, token);
        for (const item of result.repositories) repositories.push({ owner: item.owner.login, repo: item.name, branch: item.default_branch,
          private: item.private, canPush: !item.archived && item.permissions?.push !== false });
        if (result.repositories.length < 100) break;
      }
    }
    if (installations.length < 100) break;
  }
  return repositories.sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`, undefined, { sensitivity: 'base' }));
}
