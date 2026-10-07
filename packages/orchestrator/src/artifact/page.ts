import type {
  PageCommentRef,
  DocumentComment,
  DocumentPage,
  DocumentsUser,
  FetchedComment,
  HeldComment,
} from "@artfct-ai/adapters/documents/types";
import type { PageInstructions } from "@artfct-ai/adapters/instructions";
import type { McpServer } from "@artfct-ai/adapters/mcp";
import type { Binding } from "@artfct-ai/contracts/sources";
import { firstClaimedLink } from "./detect";
import { parseReview, reviewInstructions } from "./review-text";
import type {
  Artifact,
  ArtifactChange,
  ArtifactRef,
  ArtifactTarget,
  ChangeInput,
  FeedbackHandle,
  Review,
} from "./types";

/** Where the author answers a finding on a page it does not act on. */
const REPLY_NOTE = "Reply on the comment on the page.";

/** What the page kind needs from the configured document provider. */
export type PageClients = {
  /** The page a link names. Null when the link is not one of this host's pages. */
  readUrl: (url: string) => Promise<{ page_id: string } | null>;
  /** The page as the host has it now. Null when the host has no such page. */
  page: (pageId: string) => Promise<DocumentPage | null>;
  /** True when the host says the page a link names is deleted or in the trash. */
  removed: (url: string) => Promise<boolean>;
  /** Comments on a page made at or after an ISO time, oldest first. */
  comments: (pageId: string, since: string) => Promise<DocumentComment[]>;
  /** One comment by id. Null when the host no longer holds it open. */
  fetchComment: (commentId: string) => Promise<FetchedComment | null>;
  /** The held comments of a page, read from the host. */
  heldComments: (pageId: string) => Promise<HeldComment[]>;
  /** The user the document credential acts as. Null when the host will not say. */
  self: () => Promise<DocumentsUser | null>;
  /** Add a plain text comment to a page. */
  comment: (pageId: string, text: string) => Promise<void>;
  /** Mark a comment as read, in the host's own way. */
  acknowledgeComment: (comment: PageCommentRef) => Promise<void>;
  instructions: PageInstructions;
  /** What the page parent names on this host. */
  pageParentHint: string;
  mcp: (credential: string | null) => McpServer | null;
  /** What the author may do with other repositories in its checkout. */
  notes: string;
  log: (line: string) => void;
};

/** The artifact kind that is a page on the configured document host. */
export function pageArtifact(clients: PageClients): Artifact {
  return {
    detect: (text) => detect(clients, text),
    binding: (ref) => binding(ref),
    instructions: {
      ...clients.instructions,
      report: [
        clients.instructions.report,
        reviewInstructions("Post one comment on the page in this shape:"),
      ].join("\n\n"),
    },
    repositoryInstructions: () => clients.notes,
    mcp: (credential) => clients.mcp(credential),
    readyMessage: (url) => readyMessage(clients, url),
    readyInstructions: () => "",
    review: {
      revision: (ref) => pageRevision(clients, ref),
      postedReview: (ref, input) => readReview(clients, ref, input.since),
      reviewerCredential: null,
      replyInstructions: REPLY_NOTE,
      postRejection: (ref, text) => postRejection(clients, ref, text),
    },
    heldComments: { read: (pageId) => clients.heldComments(pageId) },
    pageParentHint: clients.pageParentHint,
    change: (input) => commentChange(clients, input),
    acknowledge: (handles, ref) => acknowledge(clients, handles, ref),
    removed: (target) => removed(clients, target.url),
    describe: async (target) => describe(target),
  };
}

async function detect(clients: PageClients, text: string): Promise<ArtifactTarget | null> {
  return firstClaimedLink(text, async (url) => {
    const page = await clients.readUrl(url);
    return page ? { url, ref: { kind: "page", page_id: page.page_id } } : null;
  });
}

function binding(ref: ArtifactRef): Binding | null {
  if (ref.kind !== "page") return null;
  return { source: "documents_page", external_id: ref.page_id };
}

async function postRejection(clients: PageClients, ref: ArtifactRef, text: string): Promise<void> {
  if (ref.kind !== "page") return;
  try {
    await clients.comment(ref.page_id, text);
  } catch (error) {
    clients.log(`rejection comment failed: ${String(error).slice(0, 200)}`);
  }
}

/** What the page says it is now. Null when the host cannot be reached or has no such page. */
async function pageRevision(clients: PageClients, ref: ArtifactRef): Promise<string | null> {
  if (ref.kind !== "page") return null;
  try {
    return (await clients.page(ref.page_id))?.revision ?? null;
  } catch (error) {
    clients.log(`page revision lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * The newest review this reviewer filed on the page after `since`. Null when it filed none,
 * when the host cannot be reached, and when the host will not say which user is ours.
 */
async function readReview(
  clients: PageClients,
  ref: ArtifactRef,
  since: string,
): Promise<Review | null> {
  if (ref.kind !== "page") return null;
  try {
    const self = await clients.self();
    if (!self) return null;
    const comments = await clients.comments(ref.page_id, since);
    const parsed = newestOwnReview(comments, self.id);
    if (!parsed) return null;
    return { kind: "review", revision: await pageRevision(clients, ref), ...parsed };
  } catch (error) {
    clients.log(`page review lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** The newest comment this client wrote that reads as a review. Comments arrive oldest first. */
function newestOwnReview(comments: DocumentComment[], selfId: string) {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]!;
    if (comment.author?.id !== selfId) continue;
    const parsed = parseReview(comment.text);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * A person commented on this page. A comment that mentions the document user sends the held
 * comments. Any other comment waits on the page. The document user's own comments change nothing.
 */
async function commentChange(
  clients: PageClients,
  input: ChangeInput,
): Promise<ArtifactChange | null> {
  const { event, target } = input;
  const detail = event.page;
  const from = event.actor;
  if (!detail || !from) return null;
  if (target?.ref.kind !== "page" || target.ref.page_id !== detail.page_id) return null;
  const body = event.text.trim();
  if (!body) return null;
  const held: ArtifactChange = { change: "comment_held" };
  const found = await lookupComment(clients, detail.comment_id);
  if (!found) return held;
  const { self, comment } = found;
  if (!comment || comment.author?.id === self.id) return null;
  if (!comment.mentions.includes(self.id)) return held;
  return {
    change: "mentioned",
    from,
    page_id: detail.page_id,
    comment_id: detail.comment_id,
    body: withoutMention(body, self.name),
  };
}

/** The comment and the document user. Null when the host cannot say, and the comment waits. */
async function lookupComment(
  clients: PageClients,
  commentId: string,
): Promise<{ self: DocumentsUser; comment: FetchedComment | null } | null> {
  try {
    const [self, comment] = await Promise.all([clients.self(), clients.fetchComment(commentId)]);
    return self ? { self, comment } : null;
  } catch (error) {
    clients.log(`page comment lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** The comment text without the mentions of the document user, which only asked to send. */
export function withoutMention(text: string, name: string | null): string {
  if (!name) return text;
  return text.split(`@${name}`).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The handover line, then how feedback on the page reaches the author. It names the document
 * user as a mention shows it, when the host says.
 */
async function readyMessage(clients: PageClients, url: string): Promise<string> {
  const name = await selfName(clients);
  const how = name
    ? `Comment on the page. Your comments wait until a comment mentions @${name}. Then the author gets them all and revises. You can also ask for that in this thread.`
    : "Comment on the page. Your comments wait until you ask in this thread. Then the author gets them all and revises.";
  return `The document is ready for you: ${url}\n${how}`;
}

async function selfName(clients: PageClients): Promise<string | null> {
  try {
    return (await clients.self())?.name ?? null;
  } catch (error) {
    clients.log(`document user lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Show on the page that feedback left there was read: each comment it came in is acknowledged. */
async function acknowledge(
  clients: PageClients,
  handles: FeedbackHandle[],
  ref: ArtifactRef,
): Promise<void> {
  if (ref.kind !== "page") return;
  try {
    for (const handle of handles) {
      if (handle.kind !== "page") continue;
      await clients.acknowledgeComment({ pageId: ref.page_id, commentId: handle.comment_id });
    }
  } catch (error) {
    clients.log(`page acknowledgement failed: ${String(error).slice(0, 200)}`);
  }
}

function describe(target: ArtifactTarget): string {
  const { ref, url } = target;
  if (ref.kind !== "page") return "That task produced no page.";
  return `Page ${ref.page_id} at ${url}. Open it to read what it says.`;
}

async function removed(clients: PageClients, url: string): Promise<boolean> {
  try {
    return await clients.removed(url);
  } catch (error) {
    clients.log(`removal check failed: ${String(error).slice(0, 200)}`);
    return false;
  }
}
