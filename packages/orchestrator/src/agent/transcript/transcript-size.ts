/** How many characters `estimatedTokens` counts as one token. */
export const CHARS_PER_TOKEN = 4;

/** A rough token count of text that no provider has counted yet. */
export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
