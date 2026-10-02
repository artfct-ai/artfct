import type {
  PageCommentRef,
  DocumentComment,
  DocumentPage,
  Documents,
  DocumentsUser,
  FetchedComment,
  HeldComment,
} from "../src/docs/types";
import { CallLog, type RecordedCall } from "./calls";

/** Fixed answers for a `FakeDocuments`. */
export type DocumentsAnswers = {
  /**
   * Comments by id. Null is a comment the host no longer holds. An id not listed answers an
   * empty comment without an author.
   */
  comments?: Record<string, FetchedComment | null>;
  /** The comments every `heldComments` call answers with, until they are acknowledged. */
  held?: HeldComment[];
  /** The comments every `comments` call answers with, before the `since` filter. */
  pageComments?: DocumentComment[];
  /** The page every `document` call answers with. */
  document?: DocumentPage | null;
  /** Page id by page URL. A URL not listed resolves to null. */
  pages?: Record<string, string>;
  /** URLs of the pages the host removed. */
  removedPages?: string[];
  /** Person email by user id. */
  emails?: Record<string, string>;
  /** The user the credential acts as. */
  self?: DocumentsUser;
  /** Every call fails. */
  failing?: boolean;
};

/** Methods a `FakeDocuments` records. */
export type DocumentsMethod = keyof Documents;

/** An in-memory `Documents` that answers from `DocumentsAnswers` and records every call. */
export class FakeDocuments implements Documents {
  private readonly log: CallLog<DocumentsMethod>;
  private readonly pageTexts = new Map<string, string>();
  private readonly acknowledged = new Set<string>();

  constructor(private readonly answers: DocumentsAnswers = {}) {
    this.log = new CallLog(answers.failing ?? false);
  }

  get calls(): RecordedCall<DocumentsMethod>[] {
    return this.log.calls;
  }

  argsOf(method: DocumentsMethod): unknown[][] {
    return this.log.argsOf(method);
  }

  async page(pageId: string): Promise<DocumentPage | null> {
    this.log.record("page", pageId);
    return this.answers.document ?? null;
  }

  async pageFromUrl(url: string): Promise<{ page_id: string } | null> {
    this.log.record("pageFromUrl", url);
    const pageId = this.answers.pages?.[url];
    return pageId ? { page_id: pageId } : null;
  }

  async createPage(title: string, text: string, parent: string): Promise<DocumentPage> {
    this.log.record("createPage", title, text, parent);
    const id = `page-${this.pageTexts.size + 1}`;
    this.pageTexts.set(id, text);
    return { id, contentId: null, url: `https://docs.test/${id}`, revision: "1" };
  }

  async readPageContent(pageId: string): Promise<string> {
    this.log.record("readPageContent", pageId);
    const text = this.pageTexts.get(pageId);
    if (text === undefined) throw new Error(`readPageContent: no page ${pageId}`);
    return text;
  }

  async updatePageContent(pageId: string, text: string): Promise<void> {
    this.log.record("updatePageContent", pageId, text);
    if (!this.pageTexts.has(pageId)) throw new Error(`updatePageContent: no page ${pageId}`);
    this.pageTexts.set(pageId, text);
  }

  async pageRemoved(url: string): Promise<boolean> {
    this.log.record("pageRemoved", url);
    return this.answers.removedPages?.includes(url) ?? false;
  }

  async comment(pageId: string, text: string): Promise<void> {
    this.log.record("comment", pageId, text);
  }

  async acknowledgeComment(comment: PageCommentRef): Promise<void> {
    this.log.record("acknowledgeComment", comment);
    this.acknowledged.add(comment.commentId);
  }

  async comments(pageId: string, since: string): Promise<DocumentComment[]> {
    this.log.record("comments", pageId, since);
    const sinceMs = Date.parse(since);
    return (this.answers.pageComments ?? []).filter(
      (comment) => Date.parse(comment.created_at) >= sinceMs,
    );
  }

  async fetchComment(commentId: string): Promise<FetchedComment | null> {
    this.log.record("fetchComment", commentId);
    const listed = this.answers.comments;
    if (listed && commentId in listed) return listed[commentId] ?? null;
    return { text: "", author: null, mentions: [] };
  }

  async heldComments(pageId: string): Promise<HeldComment[]> {
    this.log.record("heldComments", pageId);
    return (this.answers.held ?? []).filter((comment) => !this.acknowledged.has(comment.id));
  }

  async self(): Promise<DocumentsUser> {
    this.log.record("self");
    return this.answers.self ?? { id: "self", name: "artfct" };
  }

  async userEmail(userId: string): Promise<string | null> {
    this.log.record("userEmail", userId);
    return this.answers.emails?.[userId] ?? null;
  }
}
