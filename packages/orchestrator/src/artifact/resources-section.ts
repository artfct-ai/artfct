/** The heading of the resources section, the last section of the root page. */
export const RESOURCES_HEADING = "## Resources";

/** A page split at its resources section. `resources` is empty on a page without one. */
export type ResourcesSplit = { body: string; resources: string };

/** Split page text at the first resources heading. The section runs to the end of the page. */
export function splitAtResources(text: string): ResourcesSplit {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === RESOURCES_HEADING);
  if (start === -1) return { body: text, resources: "" };
  return {
    body: lines.slice(0, start).join("\n").trimEnd(),
    resources: lines.slice(start).join("\n"),
  };
}

/** Author text placed above the resources section the page holds now. */
export function aboveResources(authorText: string, currentPageText: string): string {
  const body = splitAtResources(authorText).body.trimEnd();
  return joinAtResources(body, splitAtResources(currentPageText).resources);
}

/**
 * The page text without the resources lines that name this page, kept apart from a child page
 * line. A host writes a page id with or without dashes.
 */
export function withoutResourceLink(text: string, pageId: string): string {
  const { body, resources } = splitAtResources(text);
  if (!resources) return text;
  const id = pageId.replaceAll("-", "");
  const [heading = RESOURCES_HEADING, ...lines] = resources.split("\n");
  const kept = lines.filter((line) => isChildPageLine(line) || !namesPage(line, id));
  return joinAtResources(body, [heading, ...kept].join("\n"));
}

/** True when a resources section names this page, as a link or as a child page. */
export function resourcesNamePage(text: string, pageId: string): boolean {
  const id = pageId.replaceAll("-", "");
  return splitAtResources(text)
    .resources.split("\n")
    .some((line) => namesPage(line, id));
}

function joinAtResources(body: string, resources: string): string {
  if (!resources) return body;
  return body ? `${body}\n\n${resources}` : resources;
}

function namesPage(line: string, dashlessId: string): boolean {
  return line.replaceAll("-", "").includes(dashlessId);
}

function isChildPageLine(line: string): boolean {
  return line.trimStart().startsWith("<page ");
}
