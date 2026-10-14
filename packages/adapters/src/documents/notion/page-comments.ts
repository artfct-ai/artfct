import { collectPaginatedAPI, type Client, type CommentObjectResponse } from "@notionhq/client";
import pLimit from "p-limit";
import { NOTION_REQUESTS_IN_FLIGHT, notionPageBlocks } from "./page-blocks";

/**
 * Every open comment on a page: the page's own, then each block's, in page order. Notion lists
 * an inline comment only under the block it sits on, so every block is listed.
 */
export async function notionPageComments(
  client: Client,
  pageId: string,
): Promise<CommentObjectResponse[]> {
  const limit = pLimit(NOTION_REQUESTS_IN_FLIGHT);
  const blocks = await notionPageBlocks(client, limit, pageId);
  const lists = await Promise.all(
    [pageId, ...blocks.map((block) => block.id)].map((blockId) =>
      limit(() => collectPaginatedAPI(client.comments.list, { block_id: blockId })),
    ),
  );
  return lists.flat();
}
