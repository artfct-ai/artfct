/**
 * Linear documents over the official `@linear/sdk`. Linear provides two capabilities, so this
 * file is the documents half and `../../tracker/linear/tracker.ts` is the work tracker half.
 * Both take the same token.
 */
import type { Document } from "@linear/sdk";
import {
  LINEAR_ACKNOWLEDGEMENT_EMOJI,
  LINEAR_DOCUMENT_COMMENTS_QUERY,
  linearHeldComments,
  type LinearDocumentComment,
  type LinearDocumentCommentsData,
} from "./held-comments";
import { linearMentionedUserIds } from "./mentions";
import { isGoneError, LinearSdk, type LinearOptions, type TokenSource } from "./sdk";
import { linearDocumentSlugFromUrl } from "./url";
import type {
  PageCommentRef,
  DocumentComment,
  DocumentPage,
  Documents,
  DocumentsUser,
  FetchedComment,
  HeldComment,
} from "../types";

/** A document by the content id its comments hang on, reached through one of those comments. */
const PAGE_BY_CONTENT_ID_QUERY = `query PageByContentId($contentId: ID!) {
  comments(first: 1, filter: { documentContent: { id: { eq: $contentId } } }) {
    nodes { documentContent { id updatedAt document { id url } } }
  }
}`;

/** One comment with the body data its mentions live in, which the SDK comment fragment leaves out. */
const COMMENT_WITH_BODY_DATA_QUERY = `query CommentWithBodyData($id: String!) {
  comment(id: $id) { id body bodyData resolvedAt user { id email } }
}`;

type CommentWithBodyDataData = {
  comment: {
    id: string;
    body: string;
    bodyData: string;
    resolvedAt: string | null;
    user: { id: string; email: string | null } | null;
  };
};

/** Documents asked for per request while looking for a content id. */
const DOCUMENT_SCAN_PAGE_SIZE = 100;

type PageByContentIdData = {
  comments: {
    nodes: Array<{
      documentContent: {
        id: string;
        updatedAt: string;
        document: { id: string; url: string } | null;
      } | null;
    }>;
  };
};

/**
 * `Documents` over Linear. A page is a Linear document, and a comment inside one is bound to
 * the document's content id, which is what its webhooks carry.
 */
export class LinearDocuments implements Documents {
  private readonly sdk: LinearSdk;

  constructor(token: string | TokenSource, options: LinearOptions = {}) {
    this.sdk = new LinearSdk(token, options);
  }

  /** A document by id or URL slug. An unknown one reads as null. */
  async document(idOrSlug: string): Promise<DocumentPage | null> {
    const client = await this.sdk.client();
    try {
      return linearDocumentPage(await client.document(idOrSlug));
    } catch (error) {
      if (isGoneError(error)) return null;
      throw error;
    }
  }

  /**
   * A document by the content id `pageFromUrl` returns, with that record's revision. Null until
   * the page has a comment, which is how the query reaches the document.
   */
  async page(pageId: string): Promise<DocumentPage | null> {
    const client = await this.sdk.client();
    const response = await client.client.rawRequest<PageByContentIdData, Record<string, unknown>>(
      PAGE_BY_CONTENT_ID_QUERY,
      { contentId: pageId },
    );
    const content = response.data?.comments.nodes[0]?.documentContent;
    if (!content?.document) return null;
    return {
      id: content.document.id,
      contentId: content.id,
      url: content.document.url,
      revision: new Date(content.updatedAt).toISOString(),
    };
  }

  /** The document a URL names, by its content id. Null when the URL names no Linear document. */
  async pageFromUrl(url: string): Promise<{ page_id: string } | null> {
    const slug = linearDocumentSlugFromUrl(url);
    if (!slug) return null;
    const document = await this.document(slug);
    return document?.contentId ? { page_id: document.contentId } : null;
  }

  /** Create a document in the Linear project `parent`. */
  async createPage(title: string, text: string, parent: string): Promise<DocumentPage> {
    const client = await this.sdk.client();
    const payload = await client.createDocument({ title, content: text, projectId: parent });
    const document = await payload.document;
    if (!document) throw new Error(`linear: document "${title}" was not created`);
    return linearDocumentPage(document);
  }

  /** The markdown content of the document with this content id. */
  async readPageContent(pageId: string): Promise<string> {
    const document = await this.documentByContentId(pageId);
    return document.content ?? "";
  }

  /** Replace the content of the document with this content id. */
  async updatePageContent(pageId: string, text: string): Promise<void> {
    const document = await this.documentByContentId(pageId);
    const client = await this.sdk.client();
    await client.updateDocument(document.id, { content: text });
  }

  /** The document whose content has this id. */
  private async documentByContentId(contentId: string): Promise<Document> {
    const client = await this.sdk.client();
    let after: string | undefined;
    for (;;) {
      const connection = await client.documents({ first: DOCUMENT_SCAN_PAGE_SIZE, after });
      const found = connection.nodes.find((document) => document.documentContentId === contentId);
      if (found) return found;
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor)
        throw new Error(`linear: no document has content ${contentId}`);
      after = connection.pageInfo.endCursor;
    }
  }

  /** A document in the trash, or one Linear no longer finds, is removed. */
  async pageRemoved(url: string): Promise<boolean> {
    const slug = linearDocumentSlugFromUrl(url);
    if (!slug) return false;
    const client = await this.sdk.client();
    try {
      return (await client.document(slug)).trashed === true;
    } catch (error) {
      if (isGoneError(error)) return true;
      throw error;
    }
  }

  /** Comment inside a document. The page id is the document content id its webhooks carry. */
  async comment(pageId: string, text: string): Promise<void> {
    const client = await this.sdk.client();
    await client.createComment({ documentContentId: pageId, body: text });
  }

  /** An eyes reaction on the comment. Linear finds the comment by its id alone. */
  async acknowledgeComment(comment: PageCommentRef): Promise<void> {
    const client = await this.sdk.client();
    await client.createReaction({
      commentId: comment.commentId,
      emoji: LINEAR_ACKNOWLEDGEMENT_EMOJI,
    });
  }

  /** Comments inside a document, oldest first. The author carries no email: only its id is read. */
  async comments(pageId: string, since: string): Promise<DocumentComment[]> {
    const client = await this.sdk.client();
    const connection = await client.comments({
      filter: {
        documentContent: { id: { eq: pageId } },
        createdAt: { gte: new Date(since) },
      },
    });
    return connection.nodes
      .map((comment) => ({
        id: comment.id,
        created_at: comment.createdAt.toISOString(),
        text: comment.body,
        author: comment.userId ? { id: comment.userId, email: null } : null,
      }))
      .toSorted((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  }

  /** One comment by id. A deleted comment and a resolved thread read as null. */
  async fetchComment(commentId: string): Promise<FetchedComment | null> {
    const client = await this.sdk.client();
    const response = await client.client
      .rawRequest<CommentWithBodyDataData, Record<string, unknown>>(COMMENT_WITH_BODY_DATA_QUERY, {
        id: commentId,
      })
      .catch((error: unknown) => {
        if (isGoneError(error)) return null;
        throw error;
      });
    const comment = response?.data?.comment;
    if (!comment || comment.resolvedAt) return null;
    const user = comment.user;
    return {
      text: comment.body,
      author: user ? { id: user.id, email: user.email ?? null } : null,
      mentions: linearMentionedUserIds(comment.bodyData),
    };
  }

  /** Inline comments hang on the same content id. An acknowledgement is an eyes reaction. */
  async heldComments(pageId: string): Promise<HeldComment[]> {
    const [self, comments] = await Promise.all([this.self(), this.documentComments(pageId)]);
    return linearHeldComments(comments, self.id);
  }

  private async documentComments(contentId: string): Promise<LinearDocumentComment[]> {
    const client = await this.sdk.client();
    const comments: LinearDocumentComment[] = [];
    let after: string | null = null;
    for (;;) {
      const variables: Record<string, unknown> = { contentId, after };
      const response = await client.client.rawRequest<
        LinearDocumentCommentsData,
        Record<string, unknown>
      >(LINEAR_DOCUMENT_COMMENTS_QUERY, variables);
      const connection = response.data?.comments;
      if (!connection) throw new Error(`linear: comments of content ${contentId} are unreadable`);
      comments.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) return comments;
      after = connection.pageInfo.endCursor;
    }
  }

  /**
   * The user the token acts as, which for an installed app is its app user. A mention shows
   * its display name.
   */
  async self(): Promise<DocumentsUser> {
    const client = await this.sdk.client();
    const viewer = await client.viewer;
    return { id: viewer.id, name: viewer.displayName };
  }

  async userEmail(userId: string): Promise<string | null> {
    const client = await this.sdk.client();
    const user = await client.user(userId);
    return user.email ?? null;
  }
}

function linearDocumentPage(document: Document): DocumentPage {
  return {
    id: document.id,
    contentId: document.documentContentId ?? null,
    url: document.url,
    revision: document.updatedAt.toISOString(),
  };
}
