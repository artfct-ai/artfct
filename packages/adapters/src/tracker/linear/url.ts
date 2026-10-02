const LINEAR_ISSUE = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)/;

/** The issue identifier a Linear issue URL names, for example `ENG-42`. Null for any other URL. */
export function linearIssueKeyFromUrl(url: string): string | null {
  return LINEAR_ISSUE.exec(url)?.[1] ?? null;
}
