import {
  APIErrorCode,
  Client,
  isFullComment,
  isFullPage,
  isNotionClientError,
  type PageObjectResponse,
} from "@notionhq/client";
import { workerdFetch } from "../../workerd-fetch";
import { NOTION_ACKNOWLEDGEMENT, notionCommentText, notionHeldComments } from "./held-comments";
import { notionMentionedUserIds } from "./mentions";
import { notionPageComments } from "./page-comments";
import { notionPageFromUrl, notionPageId } from "./page-id";
import type {
  PageCommentRef,
  DocumentComment,
  DocumentPage,
  Documents,
  DocumentsUser,
  FetchedComment,
  HeldComment,
} from "../types";

/** Construction options. `baseUrl` and `fetch` are seams for tests. */
export type NotionOptions = { baseUrl?: string; fetch?: typeof fetch };

/** `Documents` over the Notion API for an integration token. */
export class NotionDocuments implements Documents {
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

  /** Replace the page body with markdown text. */
  async updatePageContent(pageId: string, text: string): Promise<void> {
    await this.client.pages.updateMarkdown({
      page_id: pageId,
      type: "replace_content",
      replace_content: { new_str: text },
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
      rich_text: [{ type: "text", text: { content: text } }],
    });
  }

  /**
   * Notion has no reactions, so an eyes reply joins the discussion of the comment. Notion keys
   * the discussion apart from the comment.
   */
  async acknowledgeComment(comment: PageCommentRef): Promise<void> {
    const found = await this.client.comments.retrieve({ comment_id: comment.commentId });
    if (!isFullComment(found))
      throw new Error(`notion: comment ${comment.commentId} is unreadable`);
    await this.client.comments.create({
      discussion_id: found.discussion_id,
      rich_text: [{ type: "text", text: { content: NOTION_ACKNOWLEDGEMENT } }],
    });
  }

  /** Comments on a page, oldest first. The author carries no email: Notion sends a partial user. */
  async comments(pageId: string, since: string): Promise<DocumentComment[]> {
    const listed = await this.client.comments.list({ block_id: pageId });
    const sinceMs = Date.parse(since);
    return listed.results
      .filter((comment) => Date.parse(comment.created_time) >= sinceMs)
      .map((comment) => ({
        id: comment.id,
        created_at: comment.created_time,
        text: notionCommentText(comment),
        author: { id: comment.created_by.id, email: null },
      }))
      .toSorted((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
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

function notionDocumentPage(page: PageObjectResponse): DocumentPage {
  return { id: page.id, contentId: null, url: page.url, revision: page.last_edited_time };
}
