const GITHUB_PULL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** The repo and number a GitHub pull request URL names. Null for any other URL. */
export function githubPullFromUrl(url: string): { repo: string; number: number } | null {
  const match = GITHUB_PULL.exec(url);
  if (!match || !match[1] || !match[2]) return null;
  return { repo: match[1], number: Number(match[2]) };
}

/** The canonical GitHub URL of a pull request. */
export function githubPullUrl(pull: { repo: string; number: number }): string {
  return `https://github.com/${pull.repo}/pull/${pull.number}`;
}

/** The HTTPS clone URL of a GitHub repository, without credentials. */
export function githubCloneUrl(repoFull: string): string {
  return `https://github.com/${repoFull}.git`;
}
