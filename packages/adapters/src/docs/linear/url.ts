const LINEAR_DOCUMENT = /^https:\/\/linear\.app\/[^/]+\/document\/([^/?#]+)/;

/** The slug id at the end of a Linear document URL. Null for any other URL. */
export function linearDocumentSlugFromUrl(url: string): string | null {
  const segment = LINEAR_DOCUMENT.exec(url)?.[1];
  if (!segment) return null;
  const withoutTrailingPunctuation = segment.replace(/[^A-Za-z0-9]+$/, "");
  return withoutTrailingPunctuation.slice(withoutTrailingPunctuation.lastIndexOf("-") + 1) || null;
}
