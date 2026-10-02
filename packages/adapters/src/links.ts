const HTTP_LINK = /https?:\/\/[^\s<>()"'\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Extract unique http(s) links from free text. Trailing punctuation is dropped. */
export function extractLinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(HTTP_LINK)) {
    links.add(match[0].replace(TRAILING_PUNCTUATION, ""));
  }
  return [...links];
}
