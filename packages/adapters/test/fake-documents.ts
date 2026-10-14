import { textHoldsPassage } from "../src/documents/passage";
import type {
  PageCommentRef,
  DocumentPage,
  Documents,
  DocumentsUser,
  FetchedComment,
  HeldComment,
  PageNesting,
  PassageComment,
} from "../src/documents/types";
import { CallLog, type RecordedCall } from "./calls";

/** Fixed answers for a `FakeDocuments`. */
export type DocumentsAnswers = {
  /**
   * Comments by id. Null is a comment the host no longer holds. An id not listed answers an
   * empty comment without an author.
   */
  comments?: Record<string, FetchedComment | null>;
  /** The comments `heldComments` answers with at first, until they are acknowledged. */
  held?: HeldComment[];
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
  /** The host nests pages the way Notion does: a child page shows at the end of its parent. */
  nests?: boolean;
};

/** Methods a `FakeDocuments` records. */
export type DocumentsMethod = Exclude<keyof Documents, "nesting"> | keyof PageNesting;

/**
 * How the host takes comments at the moment. `takes` posts what it can. `drops_inline` leaves
 * every passage comment unposted, the way a block the host will not comment on does.
 * `inline_throws` fails each passage call, and `down` fails every comment call.
 */
export type DocumentsCommenting = "takes" | "drops_inline" | "inline_throws" | "down";

/** A comment the fake host took. */
export type PostedComment = { pageId: string; passage: string | null; text: string };

/** An in-memory `Documents` that answers from `DocumentsAnswers` and records every call. */
export class FakeDocuments implements Documents {
  readonly nesting: PageNesting | null;
  private readonly log: CallLog<DocumentsMethod>;
  private readonly pageTexts = new Map<string, string>();
  private readonly pageTitles = new Map<string, string>();
  private readonly acknowledged = new Set<string>();
  private readonly held: HeldComment[];
  /** How the host takes comments now. A test changes it between calls. */
  commenting: DocumentsCommenting = "takes";
  /** Every comment the host took, oldest first. `passage` is set on a comment on a block. */
  readonly postedComments: PostedComment[] = [];

  constructor(private readonly answers: DocumentsAnswers = {}) {
    this.log = new CallLog(answers.failing ?? false);
    this.held = [...(answers.held ?? [])];
    this.nesting = answers.nests ? this.fakeNesting() : null;
  }

  /** The text of a page as the host holds it now. Undefined for a page it does not hold. */
  pageText(pageId: string): string | undefined {
    return this.pageTexts.get(pageId);
  }

  /** The title of a page the host created, as it holds it now. Undefined for any other page. */
  pageTitle(pageId: string): string | undefined {
    return this.pageTitles.get(pageId);
  }

  /** Put a page on the host with this text, as a person would have made it. */
  seedPage(pageId: string, text: string): void {
    this.pageTexts.set(pageId, text);
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
    return this.addPage(title, text, parent);
  }

  private addPage(title: string, text: string, parent: string): DocumentPage {
    const id = `page-${this.pageTexts.size + 1}`;
    this.pageTexts.set(id, text);
    this.pageTitles.set(id, title);
    this.showChild(parent, id, title);
    return { id, contentId: null, url: fakePageUrl(id), revision: "1" };
  }

  /** A nesting host lists a child page at the end of its parent, the way Notion does. */
  private showChild(parentId: string, childId: string, title: string): void {
    const parentText = this.pageTexts.get(parentId);
    if (!this.answers.nests || parentText === undefined) return;
    this.pageTexts.set(
      parentId,
      `${parentText}\n<page url="${fakePageUrl(childId)}">${title}</page>`,
    );
  }

  private fakeNesting(): PageNesting {
    return {
      createRootPage: async (title, text, pageParent) => {
        this.log.record("createRootPage", title, text, pageParent);
        return this.addPage(title, text, pageParent);
      },
      movePage: async (pageId, parentPageId) => {
        this.log.record("movePage", pageId, parentPageId);
        this.showChild(parentPageId, pageId, pageId);
      },
      appendToPage: async (pageId, text) => {
        this.log.record("appendToPage", pageId, text);
        const current = this.pageTexts.get(pageId);
        if (current === undefined) throw new Error(`appendToPage: no page ${pageId}`);
        this.pageTexts.set(pageId, current ? `${current}\n${text}` : text);
      },
      renamePage: async (pageId, title) => {
        this.log.record("renamePage", pageId, title);
        if (!this.pageTexts.has(pageId))
          throw new Error(`renamePage: the host does not hold page ${pageId}`);
        this.pageTitles.set(pageId, title);
      },
    };
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
    if (this.commenting === "down") throw new Error("comment: the host is down");
    this.postedComments.push({ pageId, passage: null, text });
  }

  /** A passage comment posts when the page text holds its passage and the host takes it. */
  async commentOnPassages(pageId: string, comments: PassageComment[]): Promise<PassageComment[]> {
    this.log.record("commentOnPassages", pageId, comments);
    if (this.commenting === "inline_throws" || this.commenting === "down") {
      throw new Error("commentOnPassages: the host is down");
    }
    if (this.commenting === "drops_inline") return comments;
    const pageText = this.pageTexts.get(pageId) ?? "";
    const unposted = comments.filter((comment) => !textHoldsPassage(pageText, comment.passage));
    for (const comment of comments) {
      if (!unposted.includes(comment)) this.postedComments.push({ pageId, ...comment });
    }
    return unposted;
  }

  async acknowledgeComment(comment: PageCommentRef): Promise<void> {
    this.log.record("acknowledgeComment", comment);
    this.acknowledged.add(comment.commentId);
  }

  async fetchComment(commentId: string): Promise<FetchedComment | null> {
    this.log.record("fetchComment", commentId);
    const listed = this.answers.comments;
    if (listed && commentId in listed) return listed[commentId] ?? null;
    return { text: "", author: null, mentions: [] };
  }

  async heldComments(pageId: string): Promise<HeldComment[]> {
    this.log.record("heldComments", pageId);
    return this.heldNow();
  }

  /** The comments held now, without recording a call. */
  heldNow(): HeldComment[] {
    return this.held.filter((comment) => !this.acknowledged.has(comment.id));
  }

  /** A person leaves a comment the host holds, as one that does not mention the bot. */
  holdComment(comment: HeldComment): void {
    this.held.push(comment);
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

function fakePageUrl(pageId: string): string {
  return `https://docs.test/${pageId}`;
}
