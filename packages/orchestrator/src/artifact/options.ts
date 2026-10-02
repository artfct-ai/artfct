/** The heading of the page section where an author lists its options. */
export const OPTIONS_HEADING = "Proposed Options";

const HEADING_LINE = /^#{1,6}\s+(.*?)[\s#]*$/;
const NUMBERED_ITEM = /^\d+[.)]\s+(.+)$/;

/** The options a page lists: the top-level numbered items under the options heading, in order. */
export function parseDocumentOptions(documentText: string): string[] {
  const options: string[] = [];
  let underHeading = false;
  for (const line of documentText.split("\n")) {
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      underHeading = heading[1] === OPTIONS_HEADING;
      continue;
    }
    const item = underHeading ? NUMBERED_ITEM.exec(line) : null;
    if (item?.[1]) options.push(item[1].trim());
  }
  return options;
}
