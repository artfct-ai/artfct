/** A markdown link. Its text is what a reader of the page sees. */
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** Markdown marks a host drops from the plain text of a block. */
const MARKDOWN_MARKS = /[*_`~#>]/g;

/**
 * True when `text` holds `passage`. Both sides drop markdown marks, straighten quotes, and
 * collapse whitespace, so a passage quoted from a page's markdown matches the plain text of a
 * block. A passage left empty by that matches nothing.
 */
export function textHoldsPassage(text: string, passage: string): boolean {
  const wanted = comparable(passage);
  return wanted !== "" && comparable(text).includes(wanted);
}

function comparable(text: string): string {
  return text
    .replace(MARKDOWN_LINK, "$1")
    .replace(MARKDOWN_MARKS, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
