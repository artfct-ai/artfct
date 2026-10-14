import {
  collectPaginatedAPI,
  isFullBlock,
  type BlockObjectResponse,
  type Client,
} from "@notionhq/client";
import type { LimitFunction } from "p-limit";

/** Requests in flight at once while a page is read. Notion allows short bursts over its rate. */
export const NOTION_REQUESTS_IN_FLIGHT = 8;

/** Block types that hold another page. Their blocks belong to that page. */
const NOTION_OTHER_PAGE_BLOCKS = new Set(["child_page", "child_database"]);

/**
 * The blocks of a page, nested ones included, in page order. The blocks of a child page or a
 * child database belong to that page and are left out. `limit` bounds the requests in flight.
 */
export async function notionPageBlocks(
  client: Client,
  limit: LimitFunction,
  blockId: string,
): Promise<BlockObjectResponse[]> {
  const children = await limit(() =>
    collectPaginatedAPI(client.blocks.children.list, { block_id: blockId }),
  );
  const ownBlocks = children
    .filter(isFullBlock)
    .filter((block) => !NOTION_OTHER_PAGE_BLOCKS.has(block.type));
  const nested = await Promise.all(
    ownBlocks.map(async (block) =>
      block.has_children ? notionPageBlocks(client, limit, block.id) : [],
    ),
  );
  return ownBlocks.flatMap((block, index) => [block, ...(nested[index] ?? [])]);
}
