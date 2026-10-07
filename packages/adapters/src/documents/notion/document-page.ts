import type { PageObjectResponse } from "@notionhq/client";
import { notionPageId } from "./page-id";
import type { DocumentPage } from "../types";

/**
 * A Notion page as a `DocumentPage`. The id takes the dashless form a page URL carries, which
 * is how comment webhooks key the page.
 */
export function notionDocumentPage(page: PageObjectResponse): DocumentPage {
  const id = notionPageId(page.id) ?? page.id;
  return { id, contentId: null, url: page.url, revision: page.last_edited_time };
}
