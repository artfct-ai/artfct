import {
  collectPaginatedAPI,
  isFullBlock,
  type Client,
  type CommentObjectResponse,
} from "@notionhq/client";
import pLimit, { type LimitFunction } from "p-limit";

/** Requests in flight at once while a page is read. Notion allows short bursts over its rate. */
const NOTION_REQUESTS_IN_FLIGHT = 8;

/** Block types that hold another page. Their comments belong to that page. */
const NOTION_OTHER_PAGE_BLOCKS = new Set(["child_page", "child_database"]);

/**
 * Every open comment on a page: the page's own, then each block's, in page order. Notion lists
 * an inline comment only under the block it sits on, so every block is listed.
 */
export async function notionPageComments(
  client: Client,
  pageId: string,
): Promise<CommentObjectResponse[]> {
  const limit = pLimit(NOTION_REQUESTS_IN_FLIGHT);
  const blockIds = await notionDescendantBlockIds(client, limit, pageId);
  const lists = await Promise.all(
    [pageId, ...blockIds].map((blockId) =>
      limit(() => collectPaginatedAPI(client.comments.list, { block_id: blockId })),
    ),
  );
  return lists.flat();
}

/** The ids of the blocks under a block, nested ones included, in page order. */
async function notionDescendantBlockIds(
  client: Client,
  limit: LimitFunction,
  blockId: string,
): Promise<string[]> {
  const children = await limit(() =>
    collectPaginatedAPI(client.blocks.children.list, { block_id: blockId }),
  );
  const ownBlocks = children
    .filter(isFullBlock)
    .filter((block) => !NOTION_OTHER_PAGE_BLOCKS.has(block.type));
  const nested = await Promise.all(
    ownBlocks.map(async (block) =>
      block.has_children ? notionDescendantBlockIds(client, limit, block.id) : [],
    ),
  );
  return ownBlocks.flatMap((block, index) => [block.id, ...(nested[index] ?? [])]);
}
