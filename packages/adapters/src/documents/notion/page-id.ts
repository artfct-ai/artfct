const PAGE_ID = /([0-9a-f]{32})(?:[?#/]|$)/;
const NOTION_URL = /^https:\/\/(?:[\w-]+\.)?notion\.(?:com|so|site)\//;

/**
 * The 32 hex character form of a Notion page id. Takes an id with or without dashes, or a
 * page URL that ends with one. Null when the text holds no page id.
 */
export function notionPageId(idOrUrl: string): string | null {
  return PAGE_ID.exec(idOrUrl.replace(/-/g, ""))?.[1] ?? null;
}

/** The page a Notion URL names. Null for any URL of another host or with no page id. */
export function notionPageFromUrl(url: string): { page_id: string } | null {
  if (!NOTION_URL.test(url)) return null;
  const pageId = notionPageId(url);
  return pageId ? { page_id: pageId } : null;
}
