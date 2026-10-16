/**
 * The documents capability: pages, comments on them, and the people who wrote them. Consumers
 * program against `Documents`. Notion and Linear both implement it.
 */
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ExternalUser } from "@artfct-ai/contracts/types";

/** Resolves a document host user to a person the orchestrator trusts, or to null. */
type DocumentsActorResolver = (user: ExternalUser) => Promise<Actor | null>;

/** A normalized event ready to deliver, or the reason the webhook is ignored. */
export type DocumentsInbound = { event: InboundEvent } | { ignore: string };

/** What a document host webhook mapper needs besides the payload. */
export type DocumentsInboundContext = {
  resolveActor: DocumentsActorResolver;
  /** The host itself. A webhook carries comment ids, so the body is read back through it. */
  documents: Documents;
};

/** A comment body and its author. `author` is null when the host sends no author. */
type CommentBody = {
  text: string;
  author: { id: string; email: string | null } | null;
};

/** One comment read by its id. `mentions` holds the host ids of the users it mentions. */
export type FetchedComment = CommentBody & { mentions: string[] };

/**
 * A comment a person wrote on a page that this credential has not acknowledged. `author_name`
 * is the name the host shows for its author, null when the host shows none.
 */
export type HeldComment = { id: string; author_name: string | null; text: string };

/** The user a document credential acts as. `name` is the name a person types to mention it. */
export type DocumentsUser = { id: string; name: string | null };

/**
 * One page. `contentId` is the id a comment inside the page is bound to, null when the host
 * keys comments by the page id. `revision` is an opaque string compared for equality.
 */
export type DocumentPage = {
  id: string;
  contentId: string | null;
  url: string;
  revision: string;
};

/** One comment on a page, by the page id and the comment id. */
export type PageCommentRef = { pageId: string; commentId: string };

/** A change to the text of a page: the text the writer read, and the text it wrote from it. */
export type PageTextChange = { before: string; after: string };

/** A comment for the block of a page that holds `passage`, words quoted from the page. */
export type PassageComment = { passage: string; text: string };

/** What a document host whose pages hold other pages does with that tree. */
export interface PageNesting {
  /** Create the root page of a workflow under its page parent, a page or a database. */
  createRootPage(title: string, text: string, pageParent: string): Promise<DocumentPage>;
  /** Move a page under another page. It goes at the end of its new parent. */
  movePage(pageId: string, parentPageId: string): Promise<void>;
  /** Add markdown text at the end of a page. */
  appendToPage(pageId: string, text: string): Promise<void>;
  /** Set the title of a page, a child page or a row of a database. */
  renamePage(pageId: string, title: string): Promise<void>;
}

/** What the orchestrator and ingress ask of a document host. */
export interface Documents {
  /** The page tree of a host whose pages hold other pages. Null on a host where they do not. */
  readonly nesting: PageNesting | null;
  /** One page by the id this host's `pageFromUrl` returned. Null when the host has no such page. */
  page(pageId: string): Promise<DocumentPage | null>;
  /**
   * The page a URL names, keyed the way this host's comment webhooks key it. Null when the
   * URL is not one of this host's pages.
   */
  pageFromUrl(url: string): Promise<{ page_id: string } | null>;
  /** Create a page under `parent`, the host's id for the place that holds new pages. */
  createPage(title: string, text: string, parent: string): Promise<DocumentPage>;
  /** The markdown text of a page, by the id this host's `pageFromUrl` returns. */
  readPageContent(pageId: string): Promise<string>;
  /**
   * Change the text of a page from `before` to `after`, by the id `pageFromUrl` returns. Only
   * the parts that differ are written, so the rest of the page and its comments stay in place.
   */
  updatePageContent(pageId: string, change: PageTextChange): Promise<void>;
  /** True when the host says the page a URL names is deleted or in the trash. */
  pageRemoved(url: string): Promise<boolean>;
  /** Add a plain text comment to a page. */
  comment(pageId: string, text: string): Promise<void>;
  /**
   * Mark a held comment read, in the host's own way. False when the host cannot mark it alone:
   * it is not held, or an earlier comment of its comment thread is held.
   */
  acknowledgeComment(comment: PageCommentRef): Promise<boolean>;
  /** Reply to a comment in its comment thread, with plain text. */
  replyToComment(comment: PageCommentRef, text: string): Promise<void>;
  /**
   * The comments among `commentIds` that writing `change` to the page would remove, because the
   * host rewrites the block they sit on. Read before the change is written. It changes nothing.
   */
  commentsOnRemovedLines(
    pageId: string,
    change: PageTextChange,
    commentIds: string[],
  ): Promise<string[]>;
  /**
   * Add each comment on the block of the page that holds its passage. Returns the comments it
   * did not post, a subset of `comments`: the page does not hold the passage, or the host did not
   * take the comment on that block. Throws when the page cannot be read.
   */
  commentOnPassages(pageId: string, comments: PassageComment[]): Promise<PassageComment[]>;
  /**
   * One comment by id. Webhooks carry only the comment id. Null when the host no longer holds
   * the comment open, because it was deleted or resolved.
   */
  fetchComment(commentId: string): Promise<FetchedComment | null>;
  /**
   * The held comments of a page, inline ones included, read from the host each call. The
   * comments this credential wrote are never held.
   */
  heldComments(pageId: string): Promise<HeldComment[]>;
  /** The user this credential acts as. */
  self(): Promise<DocumentsUser>;
  /** Email of a person user, or null for bots and hidden emails. */
  userEmail(userId: string): Promise<string | null>;
}
