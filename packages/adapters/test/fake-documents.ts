import { planPageTextUpdate, type PageTextEdit } from "../src/documents/page-text-update";
import { textHoldsPassage } from "../src/documents/passage";
import type {
  PageCommentRef,
  DocumentPage,
  Documents,
  DocumentsUser,
  FetchedComment,
  HeldComment,
  PageNesting,
  PageTextChange,
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
  /**
   * The page every `page` call answers with. Without it, a page the host holds answers with a
   * revision that each change of its text bumps.
   */
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

/** The user the credential acts as when the answers name none. */
const FAKE_SELF: DocumentsUser = { id: "self", name: "artfct" };

/** The most edits the fake takes in one update, the way Notion limits them. */
const FAKE_EDITS_MAX = 100;

/** One line of a page. A line keeps its id until an edit covers it, like a Notion block. */
type FakeLine = { id: number; text: string };

/**
 * A person's comment on a page, on one line or on the page as a whole when `lineId` is null. It
 * opens its own discussion unless `discussionId` names the discussion it replies in, and it
 * mentions the document user when `mentionsSelf` is true.
 */
export type FakePersonComment = {
  id: string;
  pageId: string;
  lineId: number | null;
  authorName: string;
  text: string;
  discussionId?: string;
  mentionsSelf?: boolean;
};

/** What happened to comments and lines on the host, in order. */
export type FakeHostEvent =
  | { kind: "reply"; commentId: string; text: string }
  | { kind: "lines_removed"; pageId: string; lineIds: number[] };

/**
 * An in-memory `Documents` that answers from `DocumentsAnswers` and records every call. It holds
 * each page as lines with ids, and an update replaces only the lines its edits cover.
 */

/**
 * How the host takes comments at the moment. `takes` posts what it can. `drops_inline` leaves
 * every passage comment unposted, the way a block the host will not comment on does.
 * `inline_throws` fails each passage call, and `down` fails every comment call.
 */
export type DocumentsCommenting = "takes" | "drops_inline" | "inline_throws" | "down";

/** A comment the fake host took. */
export type PostedComment = { pageId: string; passage: string | null; text: string };

export class FakeDocuments implements Documents {
  readonly nesting: PageNesting | null;
  /** Every reply and every line removal, in order. */
  readonly events: FakeHostEvent[] = [];
  private readonly log: CallLog<DocumentsMethod>;
  private readonly pageLines = new Map<string, FakeLine[]>();
  private readonly pageTitles = new Map<string, string>();
  private readonly pageRevisions = new Map<string, number>();
  private readonly acknowledged = new Set<string>();
  private readonly held: HeldComment[];
  private readonly personComments: FakePersonComment[] = [];
  private readonly failNextCalls = new Set<DocumentsMethod>();
  private lineSeq = 0;
  private pageSeq = 0;
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
    return this.pageLines
      .get(pageId)
      ?.map((line) => line.text)
      .join("\n");
  }

  /** The ids of the lines of a page, in order. Empty for a page the host does not hold. */
  lineIds(pageId: string): number[] {
    return (this.pageLines.get(pageId) ?? []).map((line) => line.id);
  }

  /** The revision of a page the host holds, without recording a call. Null for any other page. */
  pageRevision(pageId: string): string | null {
    const revision = this.pageRevisions.get(pageId);
    return revision === undefined ? null : String(revision);
  }

  /** The title of a page the host created, as it holds it now. Undefined for any other page. */
  pageTitle(pageId: string): string | undefined {
    return this.pageTitles.get(pageId);
  }

  /** Put a page on the host with this text, as a person would have made it. */
  seedPage(pageId: string, text: string): void {
    this.setPageLines(pageId, this.newLines(text));
  }

  /** Hold new lines for a page, and bump its revision when its text changed. */
  private setPageLines(pageId: string, lines: FakeLine[]): void {
    const before = this.pageText(pageId);
    this.pageLines.set(pageId, lines);
    if (this.pageText(pageId) === before) return;
    this.pageRevisions.set(pageId, (this.pageRevisions.get(pageId) ?? 0) + 1);
  }

  /** A person comments on a line of a page, or on the whole page when `lineId` is null. */
  addPersonComment(comment: FakePersonComment): void {
    this.personComments.push(comment);
  }

  /** The person comments on the host, open or not. */
  get allPersonComments(): readonly FakePersonComment[] {
    return this.personComments;
  }

  /** True when the comment was acknowledged. */
  isAcknowledged(commentId: string): boolean {
    return this.acknowledged.has(commentId);
  }

  /** The next call of `method` fails before it changes anything. */
  failNext(method: DocumentsMethod): void {
    this.failNextCalls.add(method);
  }

  get calls(): RecordedCall<DocumentsMethod>[] {
    return this.log.calls;
  }

  argsOf(method: DocumentsMethod): unknown[][] {
    return this.log.argsOf(method);
  }

  async page(pageId: string): Promise<DocumentPage | null> {
    this.record("page", pageId);
    if (this.answers.document !== undefined) return this.answers.document;
    const revision = this.pageRevision(pageId);
    return revision === null
      ? null
      : { id: pageId, contentId: null, url: fakePageUrl(pageId), revision };
  }

  async pageFromUrl(url: string): Promise<{ page_id: string } | null> {
    this.record("pageFromUrl", url);
    const pageId = this.answers.pages?.[url];
    return pageId ? { page_id: pageId } : null;
  }

  async createPage(title: string, text: string, parent: string): Promise<DocumentPage> {
    this.record("createPage", title, text, parent);
    return this.addPage(title, text, parent);
  }

  private addPage(title: string, text: string, parent: string): DocumentPage {
    this.pageSeq += 1;
    const id = `page-${this.pageSeq}`;
    this.setPageLines(id, this.newLines(text));
    this.pageTitles.set(id, title);
    this.showChild(parent, id, title);
    return {
      id,
      contentId: null,
      url: fakePageUrl(id),
      revision: String(this.pageRevisions.get(id)),
    };
  }

  /** A nesting host lists a child page at the end of its parent, the way Notion does. */
  private showChild(parentId: string, childId: string, title: string): void {
    const parentLines = this.pageLines.get(parentId);
    if (!this.answers.nests || !parentLines) return;
    const childLine = this.newLine(`<page url="${fakePageUrl(childId)}">${title}</page>`);
    this.setPageLines(parentId, [...parentLines, childLine]);
  }

  private fakeNesting(): PageNesting {
    return {
      createRootPage: async (title, text, pageParent) => {
        this.record("createRootPage", title, text, pageParent);
        return this.addPage(title, text, pageParent);
      },
      movePage: async (pageId, parentPageId) => {
        this.record("movePage", pageId, parentPageId);
        this.showChild(parentPageId, pageId, pageId);
      },
      appendToPage: async (pageId, text) => {
        this.record("appendToPage", pageId, text);
        if (!this.pageLines.has(pageId)) throw new Error(`appendToPage: no page ${pageId}`);
        this.appendLines(pageId, text);
      },
      renamePage: async (pageId, title) => {
        this.record("renamePage", pageId, title);
        if (!this.pageLines.has(pageId))
          throw new Error(`renamePage: the host does not hold page ${pageId}`);
        this.pageTitles.set(pageId, title);
      },
    };
  }

  async readPageContent(pageId: string): Promise<string> {
    this.record("readPageContent", pageId);
    const text = this.pageText(pageId);
    if (text === undefined) throw new Error(`readPageContent: no page ${pageId}`);
    return text;
  }

  /** Applies the edits the change plans, all of them or not one, the way Notion takes one update. */
  async updatePageContent(pageId: string, change: PageTextChange): Promise<void> {
    this.record("updatePageContent", pageId, change);
    const lines = this.pageLines.get(pageId);
    if (!lines) throw new Error(`updatePageContent: no page ${pageId}`);
    const update = planPageTextUpdate(change, FAKE_EDITS_MAX);
    const updated =
      "whole" in update ? this.newLines(update.whole) : this.editedLines(lines, update.edits);
    const kept = new Set(updated.map((line) => line.id));
    const removed = lines.filter((line) => !kept.has(line.id)).map((line) => line.id);
    this.setPageLines(pageId, updated);
    if (removed.length) this.events.push({ kind: "lines_removed", pageId, lineIds: removed });
  }

  private editedLines(lines: FakeLine[], edits: PageTextEdit[]): FakeLine[] {
    return edits.reduce((current, edit) => this.editLines(current, edit), lines);
  }

  /** Replace the lines one edit covers with new lines. Lines outside it keep their ids. */
  private editLines(lines: FakeLine[], edit: PageTextEdit): FakeLine[] {
    const text = lines.map((line) => line.text).join("\n");
    const start = text.indexOf(edit.find);
    if (!edit.find || start === -1 || text.indexOf(edit.find, start + 1) !== -1) {
      throw new Error(`updatePageContent: an edit does not match the page once: ${edit.find}`);
    }
    const end = start + edit.find.length;
    const spans = lineSpans(lines);
    const nextTexts = (text.slice(0, start) + edit.replace + text.slice(end)).split("\n");
    const keepable = Math.min(lines.length, nextTexts.length);
    let keptBefore = 0;
    while (
      keptBefore < keepable &&
      spans[keptBefore]!.end <= start &&
      nextTexts[keptBefore] === lines[keptBefore]!.text
    ) {
      keptBefore += 1;
    }
    let keptAfter = 0;
    while (
      keptBefore + keptAfter < keepable &&
      spans[lines.length - 1 - keptAfter]!.start >= end &&
      nextTexts[nextTexts.length - 1 - keptAfter] === lines[lines.length - 1 - keptAfter]!.text
    ) {
      keptAfter += 1;
    }
    const middle = nextTexts.slice(keptBefore, nextTexts.length - keptAfter);
    return [
      ...lines.slice(0, keptBefore),
      ...middle.map((lineText) => this.newLine(lineText)),
      ...lines.slice(lines.length - keptAfter),
    ];
  }

  async pageRemoved(url: string): Promise<boolean> {
    this.record("pageRemoved", url);
    return this.answers.removedPages?.includes(url) ?? false;
  }

  async comment(pageId: string, text: string): Promise<void> {
    this.record("comment", pageId, text);
    if (this.commenting === "down") throw new Error("comment: the host is down");
    this.postedComments.push({ pageId, passage: null, text });
  }

  /** A passage comment posts when the page text holds its passage and the host takes it. */
  async commentOnPassages(pageId: string, comments: PassageComment[]): Promise<PassageComment[]> {
    this.record("commentOnPassages", pageId, comments);
    if (this.commenting === "inline_throws" || this.commenting === "down") {
      throw new Error("commentOnPassages: the host is down");
    }
    if (this.commenting === "drops_inline") return comments;
    const pageText = this.pageText(pageId) ?? "";
    const unposted = comments.filter((comment) => !textHoldsPassage(pageText, comment.passage));
    for (const comment of comments) {
      if (!unposted.includes(comment)) this.postedComments.push({ pageId, ...comment });
    }
    return unposted;
  }

  /**
   * Mark the discussion of the comment read, the way the Notion eyes reply does: every comment in
   * that discussion now is acknowledged, and a later one is held again.
   */
  async acknowledgeComment(comment: PageCommentRef): Promise<void> {
    this.record("acknowledgeComment", comment);
    const discussion = this.discussionOf(comment.commentId);
    this.acknowledged.add(comment.commentId);
    for (const held of this.held) {
      if (held.id === discussion) this.acknowledged.add(held.id);
    }
    for (const person of this.personComments) {
      if (this.discussionOf(person.id) === discussion) this.acknowledged.add(person.id);
    }
  }

  private discussionOf(commentId: string): string {
    const person = this.personComments.find((listed) => listed.id === commentId);
    return person?.discussionId ?? commentId;
  }

  /** A reply to a person comment whose line is gone fails, the way a deleted block's would. */
  async replyToComment(comment: PageCommentRef, text: string): Promise<void> {
    this.record("replyToComment", comment, text);
    const person = this.personComments.find((listed) => listed.id === comment.commentId);
    if (person && !this.isOpen(person)) {
      throw new Error(`replyToComment: comment ${comment.commentId} is gone`);
    }
    this.events.push({ kind: "reply", commentId: comment.commentId, text });
  }

  async fetchComment(commentId: string): Promise<FetchedComment | null> {
    this.record("fetchComment", commentId);
    const listed = this.answers.comments;
    if (listed && commentId in listed) return listed[commentId] ?? null;
    const person = this.personComments.find((comment) => comment.id === commentId);
    if (!person) return { text: "", author: null, mentions: [] };
    const self = this.answers.self ?? FAKE_SELF;
    return {
      text: person.text,
      author: { id: `person-${person.authorName}`, email: null },
      mentions: person.mentionsSelf ? [self.id] : [],
    };
  }

  async heldComments(pageId: string): Promise<HeldComment[]> {
    this.record("heldComments", pageId);
    return this.heldNow();
  }

  /**
   * The comments held now, without recording a call: the fixed and added held comments, then
   * each open person comment, minus the acknowledged ones.
   */
  heldNow(): HeldComment[] {
    const open = this.personComments
      .filter((comment) => this.isOpen(comment))
      .map((comment) => ({ id: comment.id, author_name: comment.authorName, text: comment.text }));
    return [...this.held, ...open].filter((comment) => !this.acknowledged.has(comment.id));
  }

  /** A person leaves a comment the host holds, as one that does not mention the bot. */
  holdComment(comment: HeldComment): void {
    this.held.push(comment);
  }

  async self(): Promise<DocumentsUser> {
    this.record("self");
    return this.answers.self ?? FAKE_SELF;
  }

  async userEmail(userId: string): Promise<string | null> {
    this.record("userEmail", userId);
    return this.answers.emails?.[userId] ?? null;
  }

  /** A comment is open while the line it is on is on its page. */
  private isOpen(comment: FakePersonComment): boolean {
    if (comment.lineId === null) return true;
    return this.lineIds(comment.pageId).includes(comment.lineId);
  }

  private record(method: DocumentsMethod, ...args: unknown[]): void {
    this.log.record(method, ...args);
    if (this.failNextCalls.delete(method)) throw new Error(`${method}: host outage`);
  }

  /** Text added at the end of a page. An empty page takes it as its whole text. */
  private appendLines(pageId: string, text: string): void {
    const lines = this.pageLines.get(pageId) ?? [];
    const isEmpty = lines.length === 1 && lines[0]?.text === "";
    this.setPageLines(pageId, [...(isEmpty ? [] : lines), ...this.newLines(text)]);
  }

  private newLines(text: string): FakeLine[] {
    return text.split("\n").map((lineText) => this.newLine(lineText));
  }

  private newLine(text: string): FakeLine {
    this.lineSeq += 1;
    return { id: this.lineSeq, text };
  }
}

/** Where each line starts and ends in the page text, its line break left out. */
function lineSpans(lines: FakeLine[]): Array<{ start: number; end: number }> {
  let offset = 0;
  return lines.map((line) => {
    const span = { start: offset, end: offset + line.text.length };
    offset = span.end + 1;
    return span;
  });
}

function fakePageUrl(pageId: string): string {
  return `https://docs.test/${pageId}`;
}
