const LINEAR_ISSUE = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)/;

/** The issue identifier a Linear issue URL names, for example `ENG-42`. Null for any other URL. */
export function linearIssueKeyFromUrl(url: string): string | null {
  return LINEAR_ISSUE.exec(url)?.[1] ?? null;
}

const LINEAR_PROJECT = /^https:\/\/linear\.app\/[^/]+\/project\/([^/?#]+)/;

/** The slug id at the end of the project segment of a Linear project URL. Null for any other URL. */
export function linearProjectSlugFromUrl(url: string): string | null {
  const segment = LINEAR_PROJECT.exec(url)?.[1];
  if (!segment) return null;
  return segment.slice(segment.lastIndexOf("-") + 1) || null;
}
