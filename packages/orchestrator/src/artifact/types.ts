import type { HeldComment } from "@artfct-ai/adapters/docs/types";
import type { HostInstructions } from "@artfct-ai/adapters/instructions";
import type {
  CheckFailure,
  CommentRef,
  CommitChecks,
  Permissions,
} from "@artfct-ai/adapters/code/types";
import type { McpServer } from "@artfct-ai/adapters/mcp";
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";

/** What an artifact points at, as fields. */
export type ArtifactRef =
  | { kind: "pull"; repo: string; number: number }
  | { kind: "page"; page_id: string }
  | { kind: "issues" };

/** An artifact ref that names a pull request. */
export type PullRef = Extract<ArtifactRef, { kind: "pull" }>;

/** Where an artifact lives: what it points at, and the link a human opens. */
export type ArtifactTarget = { ref: ArtifactRef; url: string };

/** One thing said about an artifact, with where it applies when it applies somewhere. */
export type Finding = { location?: string; body: string };

/**
 * What a reviewer said about one revision. Read back from the host. The revision is null when
 * the host could not say.
 */
export type Review = {
  kind: "review";
  revision: string | null;
  blocking: boolean;
  /** What the reviewer said about the artifact as a whole. Empty when it said nothing. */
  summary: string;
  findings: Finding[];
};

/**
 * What a refiner run filed on its artifact: a findings reviewer's review, or a judge's ruling.
 * Kept on the refiner run's row until its segment settles.
 */
export type RefinerResult =
  | Review
  | { kind: "ruling"; revision: string | null; ruling: "approved" }
  | { kind: "ruling"; revision: string | null; ruling: "rejected"; reason: string };

/** A human message about an artifact, on its way to becoming a prompt for the author. */
export type Feedback = {
  from: Actor;
  /** True when access did not check who wrote part of it: an App's review, or held page comments. */
  unchecked: boolean;
  body: string;
  findings: Finding[];
  /** The comments the kind acknowledges on to show the feedback was read. */
  handles: FeedbackHandle[];
};

/** One comment the feedback came in, in the terms of the artifact kind that read it. */
export type FeedbackHandle =
  | { kind: "pull"; comment: CommentRef }
  | { kind: "page"; comment_id: string };

/**
 * How an artifact reaches the humans. `ready` is the healthy close. `blocked` says what went
 * wrong.
 */
export type ArtifactClose = { close: "ready" } | { close: "blocked"; reason: string };

/** One inbound event as a change to the artifact it is about. */
export type ArtifactChange =
  | { change: "opened"; target: ArtifactTarget }
  | { change: "feedback"; feedback: Feedback }
  | { change: "comment_held" }
  | { change: "mentioned"; from: Actor; page_id: string; comment_id: string; body: string }
  | { change: "ready" }
  | { change: "accepted" }
  | { change: "closed" }
  | { change: "checks" };

/** What `change` needs besides the event: the artifact it may be about, and the seen-event table. */
export type ChangeInput = {
  event: InboundEvent;
  target: ArtifactTarget | null;
  /** Take a host action for this event. False when another webhook of it was handled already. */
  claim: (id: string) => boolean;
};

/** Where a kind looks for a review: the time the reviewer started, and the turn text it ended with. */
export type ReviewInput = { since: string; turnText: string };

/** How a kind's artifacts are reviewed. Absent on a kind with no reviewer. */
export interface ReviewSupport {
  /** What the artifact says it is right now. Null when the host cannot say. A review about another revision is stale. */
  revision(ref: ArtifactRef): Promise<string | null>;
  /** The newest review this reviewer filed for this turn. Null when it filed none. */
  postedReview(ref: ArtifactRef, input: ReviewInput): Promise<Review | null>;
  /** What a reviewer sandbox may do. Null when the credential cannot be narrowed. */
  reviewerCredential: Permissions | null;
  /** Where the author answers a finding it does not act on, in this host's own terms. */
  replyInstructions: string;
  /**
   * Post why a judge entry rejected the artifact, as a top level comment on it. Never throws.
   * Null on a kind with no such place, and the thread carries the rejection.
   */
  postRejection: ((ref: ArtifactRef, text: string) => Promise<void>) | null;
}

/**
 * What the host says about one revision: its checks, or a base branch it does not merge with.
 * `merge_unknown` is a host that has not worked the merge out yet.
 */
export type ArtifactChecks =
  | CommitChecks
  | { state: "conflicted"; base: string }
  | { state: "merge_unknown" };

/** How the host checks a kind's artifacts. Absent on a kind whose host runs no checks. */
export interface ChecksSupport {
  /** What the host says about one revision. */
  read(ref: ArtifactRef, revision: string): Promise<ArtifactChecks>;
  /** The prompt that sends a conflict with the base branch back to the task that pushed the revision. */
  conflictPrompt(ref: ArtifactRef, base: string): string;
  /** The prompt that sends failed checks back to the task that pushed the revision. */
  failurePrompt(ref: ArtifactRef, failures: CheckFailure[]): string;
}

/** How a kind reads its held comments from the host. Absent on a kind that holds none. */
export interface HeldCommentSupport {
  /** The held comments of a page, as the host shows them now. */
  read(pageId: string): Promise<HeldComment[]>;
}

/** The host instructions of a kind, and how a review of it is filed. */
export type ArtifactInstructions = HostInstructions & { report: string };

/** One thing an agent does with an artifact. A role is told the actions it takes. */
export type ArtifactAction = keyof ArtifactInstructions;

/** Everything that depends on the kind of artifact a stage produces. */
export interface Artifact {
  /** The first artifact of this kind that a link in the text names. */
  detect(text: string): Promise<ArtifactTarget | null>;
  /**
   * The artifact the host holds open on a branch, for an author that printed no link. Absent on
   * a kind that does not live on a branch.
   */
  openOnBranch?(branch: string): Promise<ArtifactTarget | null>;
  /** Where ingress routes events about the artifact. Null when the ref names no routed object. */
  binding(ref: ArtifactRef): Binding | null;
  /** How an agent of any role works with this kind on its host. */
  instructions: ArtifactInstructions;
  /** What the author may do with repositories other than the one it works in. */
  repositoryInstructions(): string;
  /** The MCP server the author and the reviewer work through, on the task's credential. */
  mcp(credential: string | null): McpServer | null;
  /** What the humans hear when the artifact reaches them in good order. */
  readyMessage(url: string): Promise<string>;
  /** What the host still owes the artifact, for the refusal to complete a task without it. */
  readyInstructions(): string;
  review?: ReviewSupport;
  checks?: ChecksSupport;
  heldComments?: HeldCommentSupport;
  /** What the page parent names on this host, for the plan. Absent on a kind that is not a page. */
  pageParentHint?: string;
  /** One inbound event as a change, or null when it changes nothing. */
  change(input: ChangeInput): Promise<ArtifactChange | null>;
  /** Show on the host that the comments feedback came in were read. Never throws. */
  acknowledge(handles: FeedbackHandle[], ref: ArtifactRef): Promise<void>;
  /**
   * The branch a job commits to when it continues this artifact. Null when the host no longer
   * holds it open. Absent on a kind that does not live on a branch.
   */
  branch?(ref: ArtifactRef): Promise<string | null>;
  /** Live check that the host accepted the artifact, for a missed webhook. */
  accepted?(ref: ArtifactRef): Promise<boolean>;
  /** Live check that the host removed the artifact, for a missed webhook. */
  removed?(target: ArtifactTarget): Promise<boolean>;
  /** What the orchestrator agent is shown when it reads the artifact. */
  describe(target: ArtifactTarget): Promise<string>;
}
