import {
  APIErrorCode,
  Client,
  collectPaginatedAPI,
  isFullBlock,
  isFullComment,
  isFullPage,
  isNotionClientError,
  type CommentObjectResponse,
} from "@notionhq/client";
import pLimit from "p-limit";
import { workerdFetch } from "../../workerd-fetch";
import { planPageTextUpdate } from "../page-text-update";
import { textHoldsPassage } from "../passage";
import { notionBlockText } from "./block-text";
import { notionDocumentPage } from "./document-page";
import { NOTION_ACKNOWLEDGEMENT, notionCommentText, notionHeldComments } from "./held-comments";
import { notionMentionedUserIds } from "./mentions";
import { notionPageComments } from "./page-comments";
import { notionPageFromUrl, notionPageId } from "./page-id";
import { NOTION_REQUESTS_IN_FLIGHT, notionPageBlocks } from "./page-blocks";
import { NotionPageNesting } from "./page-nesting";
import { notionRichText } from "./rich-text";
import type {
  PageCommentRef,
  DocumentPage,
  Documents,
  DocumentsUser,
  FetchedComment,
  HeldComment,
  PageTextChange,
  PassageComment,
} from "../types";

/** The most search-and-replace edits Notion takes in one page markdown update. */
const NOTION_CONTENT_UPDATES_MAX = 100;

/** Construction options. `baseUrl` and `fetch` are seams for tests. */
export type NotionOptions = { baseUrl?: string; fetch?: typeof fetch };

/** `Documents` over the Notion API for an integration token. */
export class NotionDocuments implements Documents {
  readonly nesting: NotionPageNesting;
  private readonly client: Client;

  /**
   * The SDK refuses a token where `WorkerGlobalScope` exists, which it reads as a browser worker.
   * workerd defines that global, so the client opts out. A Worker is a server.
   */
  constructor(token: string, options: NotionOptions = {}) {
    this.client = new Client({
      auth: token,
      baseUrl: options.baseUrl,
      fetch: workerdFetch(options.fetch),
      dangerouslyAllowBrowser: true,
    });
    this.nesting = new NotionPageNesting(this.client);
  }

  /** One page by id. Notion has no slug lookup. A page the integration cannot read reads as null. */
  async document(idOrSlug: string): Promise<DocumentPage | null> {
    const page = await this.client.pages.retrieve({ page_id: idOrSlug });
    return isFullPage(page) ? notionDocumentPage(page) : null;
  }

  /** Notion keys comments by the page id, so this is the retrieve `document` does. */
  async page(pageId: string): Promise<DocumentPage | null> {
    return this.document(pageId);
  }

  /** Notion writes the page id into the URL, so no lookup is needed. */
  async pageFromUrl(url: string): Promise<{ page_id: string } | null> {
    return notionPageFromUrl(url);
  }

  /** Create a page under the page `parent`, given as a page id or a page URL. */
  async createPage(title: string, text: string, parent: string): Promise<DocumentPage> {
    const parentId = notionPageId(parent);
    if (!parentId) throw new Error(`notion: "${parent}" does not name a page`);
    const page = await this.client.pages.create({
      parent: { page_id: parentId },
      properties: { title: { title: [{ text: { content: title } }] } },
      markdown: text,
    });
    if (!isFullPage(page)) throw new Error(`notion: page "${title}" is unreadable after create`);
    return notionDocumentPage(page);
  }

  /** The page body as Notion markdown. */
  async readPageContent(pageId: string): Promise<string> {
    const page = await this.client.pages.retrieveMarkdown({ page_id: pageId });
    if (page.truncated) throw new Error(`notion: page ${pageId} is too long to read whole`);
    return page.markdown;
  }

  /**
   * Search-and-replace edits on the lines that changed, in one request, so Notion keeps every
   * other block and the comments on it. A page without text gets the whole new text.
   */
  async updatePageContent(pageId: string, change: PageTextChange): Promise<void> {
    const update = planPageTextUpdate(change, NOTION_CONTENT_UPDATES_MAX);
    if ("whole" in update) {
      await this.client.pages.updateMarkdown({
        page_id: pageId,
        type: "replace_content",
        replace_content: { new_str: update.whole },
      });
      return;
    }
    if (!update.edits.length) return;
    await this.client.pages.updateMarkdown({
      page_id: pageId,
      type: "update_content",
      update_content: {
        content_updates: update.edits.map((edit) => ({
          old_str: edit.find,
          new_str: edit.replace,
        })),
      },
    });
  }

  /** A page in the trash, or one Notion no longer finds, is removed. */
  async pageRemoved(url: string): Promise<boolean> {
    const named = notionPageFromUrl(url);
    if (!named) return false;
    try {
      const page = await this.client.pages.retrieve({ page_id: named.page_id });
      return isFullPage(page) && page.in_trash;
    } catch (error) {
      if (isNotionClientError(error) && error.code === APIErrorCode.ObjectNotFound) return true;
      throw error;
    }
  }

  async comment(pageId: string, text: string): Promise<void> {
    await this.client.comments.create({
      parent: { page_id: pageId },
      rich_text: notionRichText(text),
    });
  }

  /**
   * Notion anchors a comment to a whole block, never to a range of text in it. Each comment goes
   * on the first block in page order whose text holds its passage. A block Notion will not
   * comment on leaves its comment unposted.
   */
  async commentOnPassages(pageId: string, comments: PassageComment[]): Promise<PassageComment[]> {
    const blocks = await notionPageBlocks(this.client, pLimit(NOTION_REQUESTS_IN_FLIGHT), pageId);
    const unposted: PassageComment[] = [];
    for (const comment of comments) {
      const block = blocks.find((candidate) =>
        textHoldsPassage(notionBlockText(candidate), comment.passage),
      );
      if (!block || !(await this.commentOnBlock(block.id, comment.text))) unposted.push(comment);
    }
    return unposted;
  }

  /** True when Notion took the comment on the block. */
  private async commentOnBlock(blockId: string, text: string): Promise<boolean> {
    try {
      await this.client.comments.create({
        parent: { block_id: blockId },
        rich_text: notionRichText(text),
      });
      return true;
    } catch (error) {
      if (isNotionClientError(error)) return false;
      throw error;
    }
  }

  /**
   * Notion does not have reactions, so an eyes reply joins the comment thread of the comment. It
   * marks the earliest held comment there, so it is posted only when that is this comment.
   */
  async acknowledgeComment(comment: PageCommentRef): Promise<boolean> {
    const found = await this.readComment(comment.commentId);
    const [self, listed] = await Promise.all([
      this.self(),
      collectPaginatedAPI(this.client.comments.list, { block_id: notionCommentParentId(found) }),
    ]);
    const commentThread = listed.filter(
      (listedComment) => listedComment.discussion_id === found.discussion_id,
    );
    if (notionHeldComments(commentThread, self.id)[0]?.id !== comment.commentId) return false;
    await this.client.comments.create({
      discussion_id: found.discussion_id,
      rich_text: notionRichText(NOTION_ACKNOWLEDGEMENT),
    });
    return true;
  }

  /** A reply joins the comment thread of the comment. Notion keys it apart from the comment. */
  async replyToComment(comment: PageCommentRef, text: string): Promise<void> {
    const found = await this.readComment(comment.commentId);
    await this.client.comments.create({
      discussion_id: found.discussion_id,
      rich_text: notionRichText(text),
    });
  }

  private async readComment(commentId: string): Promise<CommentObjectResponse> {
    const found = await this.client.comments.retrieve({ comment_id: commentId });
    if (!isFullComment(found)) throw new Error(`notion: comment ${commentId} is unreadable`);
    return found;
  }

  /**
   * An edit replaces every block whose text it covers, and those blocks take their comments with
   * them. A comment on the page itself stays.
   */
  async commentsOnRemovedLines(
    _pageId: string,
    change: PageTextChange,
    commentIds: string[],
  ): Promise<string[]> {
    if (!commentIds.length) return [];
    const update = planPageTextUpdate(change, NOTION_CONTENT_UPDATES_MAX);
    const removed: string[] = [];
    for (const commentId of commentIds) {
      const found = await this.readComment(commentId);
      if (found.parent.type !== "block_id") continue;
      const block = await this.client.blocks.retrieve({ block_id: found.parent.block_id });
      if (!isFullBlock(block)) continue;
      const text = notionBlockText(block);
      const rewritten =
        "whole" in update || update.edits.some((edit) => textHoldsPassage(edit.find, text));
      if (rewritten) removed.push(commentId);
    }
    return removed;
  }

  /**
   * One comment by id. A comment the integration cannot read reads as empty. A comment Notion
   * no longer returns, such as a deleted one, reads as null.
   */
  async fetchComment(commentId: string): Promise<FetchedComment | null> {
    const comment = await this.client.comments
      .retrieve({ comment_id: commentId })
      .catch((error: unknown) => {
        if (isNotionClientError(error) && error.code === APIErrorCode.ObjectNotFound) return null;
        throw error;
      });
    if (!comment) return null;
    if (!isFullComment(comment)) return { text: "", author: null, mentions: [] };
    return {
      text: notionCommentText(comment),
      author: { id: comment.created_by.id, email: null },
      mentions: notionMentionedUserIds(comment.rich_text),
    };
  }

  /**
   * Notion lists a page's own comments by the page id and an inline comment only by its block
   * id, so this reads the page and every block on it. An acknowledgement is a reply.
   */
  async heldComments(pageId: string): Promise<HeldComment[]> {
    const [self, comments] = await Promise.all([
      this.self(),
      notionPageComments(this.client, pageId),
    ]);
    return notionHeldComments(comments, self.id);
  }

  /** The bot user the integration token acts as, under the connection's name. */
  async self(): Promise<DocumentsUser> {
    const user = await this.client.users.me({});
    return { id: user.id, name: user.name };
  }

  async userEmail(userId: string): Promise<string | null> {
    const user = await this.client.users.retrieve({ user_id: userId });
    if (user.type !== "person") return null;
    return user.person.email ?? null;
  }
}

/** The block or page Notion lists a comment under. */
function notionCommentParentId(comment: CommentObjectResponse): string {
  return comment.parent.type === "block_id" ? comment.parent.block_id : comment.parent.page_id;
}
