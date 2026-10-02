import type { TranscriptRow } from "./transcript";

/** How many characters `estimatedTokens` counts as one token. */
export const CHARS_PER_TOKEN = 4;

/** A rough token count of text that no provider has counted yet. */
export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Index of the first row compaction keeps: the latest user message. 0 when nothing comes before it. */
export function cutIndex(rows: TranscriptRow[]): number {
  for (let index = rows.length - 1; index > 0; index -= 1) {
    if (rows[index]!.message.role === "user") return index;
  }
  return 0;
}
