/** The most UTF-16 units Notion takes in one rich text item. */
const NOTION_RICH_TEXT_UNITS = 2000;

/** A surrogate half without its partner. A surrogate pair matches as one code point. */
const LONE_SURROGATE = /\p{Surrogate}/u;

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/** A Notion page link, or a page id with or without dashes, reads as the page it names. */
export function notionPageLinkNamesItsPage(
  link: string,
  read: string | null,
  pageId: string,
): void {
  if (read === pageId) return;
  violated("notionPageLinkNamesItsPage", `${JSON.stringify(link)} read as ${read} for ${pageId}`);
}

/**
 * The rich text parts join back to the text. Each part holds at most 2000 UTF-16 units and does
 * not split a surrogate pair.
 */
export function notionRichTextJoinsBack(text: string, parts: string[]): void {
  const name = "notionRichTextJoinsBack";
  const long = parts.findIndex((part) => part.length > NOTION_RICH_TEXT_UNITS);
  if (long !== -1) violated(name, `part ${long} holds ${parts[long]?.length} units`);
  const broken = parts.findIndex((part) => LONE_SURROGATE.test(part));
  if (!LONE_SURROGATE.test(text) && broken !== -1) {
    violated(name, `part ${broken} splits a surrogate pair at its end or start`);
  }
  if (parts.join("") !== text) violated(name, "the parts do not join back to the text");
}

/** What a Linear document write did: the content Linear holds after it, or the error it threw. */
export type LinearWriteOutcome = { content: string } | { error: unknown };

/**
 * After a person adds the line `personLine` to a document the author read, the write throws or
 * leaves the author's text with that line kept. It succeeds when the line sits two or more
 * unchanged lines away from every author change.
 */
export function linearWriteKeepsTheConcurrentEdit(write: {
  authorText: string;
  personLine: string;
  farFromEveryChange: boolean;
  outcome: LinearWriteOutcome;
}): void {
  const name = "linearWriteKeepsTheConcurrentEdit";
  const { authorText, personLine, farFromEveryChange, outcome } = write;
  if ("error" in outcome) {
    if (farFromEveryChange) violated(name, `the write threw: ${String(outcome.error)}`);
    return;
  }
  const lines = outcome.content.split("\n");
  const personLines = lines.filter((line) => line === personLine).length;
  if (personLines !== 1) {
    violated(name, `the document holds the person's line ${personLines} times`);
  }
  const authorLines = lines.filter((line) => line !== personLine).join("\n");
  if (authorLines !== authorText) {
    violated(name, `${JSON.stringify(outcome.content)} is not the author's text with the line`);
  }
}
