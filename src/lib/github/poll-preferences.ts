export const GITHUB_POLL_SECONDS_KEY = 'notework:github-poll-seconds';
export const DEFAULT_GITHUB_POLL_SECONDS = 4;
export function readGitHubPollSeconds() {
  try {
    const value = Number(localStorage.getItem(GITHUB_POLL_SECONDS_KEY));
    return Number.isFinite(value) && value >= 1 ? value : DEFAULT_GITHUB_POLL_SECONDS;
  } catch { return DEFAULT_GITHUB_POLL_SECONDS; }
}
