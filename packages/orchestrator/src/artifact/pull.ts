import type { CodeHost, CodeReview, PullRequestReview } from "@artfct-ai/adapters/code/types";
import type { HostInstructions } from "@artfct-ai/adapters/instructions";
import type { McpServer } from "@artfct-ai/adapters/mcp";
import type { InboundEvent, PullDetail } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import { firstClaimedLink } from "./detect";
import { checksFailurePrompt, conflictPrompt } from "./pull-prompts";
import type {
  Artifact,
  ArtifactChange,
  ArtifactChecks,
  ArtifactRef,
  ArtifactTarget,
  ChangeInput,
  FeedbackHandle,
  PullRef,
  Review,
} from "./types";

/** What the pull kind needs from the configured code provider. */
export type PullClients = {
  host: () => CodeHost | null;
  repo: () => string | null;
  /** The pull request a link names, and its canonical URL. Null when the link is not one. */
  readUrl: (url: string) => { repo: string; number: number; url: string } | null;
  /** The canonical URL of a pull request the host already holds. */
  writeUrl: (ref: PullRef) => string;
  review: CodeReview;
  mcp: (credential: string | null) => McpServer | null;
  instructions: HostInstructions;
  /** What the author may do with other repositories in its checkout. */
  notes: string;
  /** How a task inspects a failed check in its sandbox. */
  inspectNote: string;
  log: (line: string) => void;
};

/** Where the author answers a finding on a pull request it does not act on. */
const REPLY_NOTE =
  "Reply on the review comment on the pull request. Never resolve a comment you did not act on.";

/** The reply that shows a person their feedback was read, where the host has no reaction for it. */
export const RELAYED_TEXT = "Relayed to the author.";

/** The pull request an event is about. Null when the event names a base branch instead. */
export function pullDetailOf(event: InboundEvent): PullDetail | null {
  const pull = event.pull;
  return pull && pull.action !== "base_moved" ? pull : null;
}

/** The artifact kind that is a pull request on the configured code host. */
export function pullArtifact(clients: PullClients): Artifact {
  return {
    detect: (text) => detect(clients, text),
    openOnBranch: (branch) => openOnBranch(clients, branch),
    binding: (ref) => binding(ref),
    instructions: { ...clients.instructions, report: reviewReport(clients.review) },
    repositoryInstructions: () => clients.notes,
    mcp: (credential) => clients.mcp(credential),
    readyMessage: async (url) => `The pull request is ready for you: ${url}`,
    readyInstructions: () => "The task completes once it is merged.",
    review: {
      revision: (ref) => headRevision(clients, ref),
      postedReview: (ref, input) => readReview(clients, ref, input.since),
      reviewerCredential: clients.review.permissions,
      replyInstructions: REPLY_NOTE,
      postRejection: (ref, text) => postRejection(clients, ref, text),
    },
    checks: {
      read: (ref, revision) => pullChecks(clients, ref, revision),
      conflictPrompt: (ref, base) => conflictPrompt(pullRefOf(ref), base),
      failurePrompt: (ref, failures) =>
        checksFailurePrompt({ pull: pullRefOf(ref), failures, inspectNote: clients.inspectNote }),
    },
    branch: (ref) => openHeadBranch(clients, ref),
    change: (input) => change(clients, input),
    acknowledge: (handles, ref) => acknowledge(clients, handles, ref),
    accepted: (ref) => accepted(clients, ref),
    removed: (target) => removed(clients, target.ref),
    describe: (target) => describe(clients, target),
  };
}

/** Only a pull request of the workflow's own repository counts. */
async function detect(clients: PullClients, text: string): Promise<ArtifactTarget | null> {
  const repo = clients.repo();
  return firstClaimedLink(text, async (url) => {
    const pull = clients.readUrl(url);
    if (!pull || (repo && pull.repo !== repo)) return null;
    return { url: pull.url, ref: { kind: "pull", repo: pull.repo, number: pull.number } };
  });
}

async function openOnBranch(clients: PullClients, branch: string): Promise<ArtifactTarget | null> {
  const host = clients.host();
  const repo = clients.repo();
  if (!host || !repo) return null;
  try {
    const pull = (await host.pullsForBranch(repo, branch))[0];
    if (!pull) return null;
    return { url: pull.html_url, ref: { kind: "pull", repo, number: pull.number } };
  } catch (error) {
    clients.log(`pull request lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

function binding(ref: ArtifactRef): Binding | null {
  if (ref.kind !== "pull") return null;
  return { source: "code_pull", repo: ref.repo, number: ref.number };
}

function reviewReport(review: CodeReview): string {
  return [
    "Post one review with these calls, in this order:",
    ...review.reportSteps.map((step, index) => `${index + 1}. ${step.split("\n").join("\n   ")}`),
    "",
    review.reportRules,
  ].join("\n");
}

async function postRejection(clients: PullClients, ref: ArtifactRef, text: string): Promise<void> {
  const host = clients.host();
  if (!host || ref.kind !== "pull") return;
  try {
    await host.commentOnPull(ref.repo, ref.number, text);
  } catch (error) {
    clients.log(`rejection comment failed: ${String(error).slice(0, 200)}`);
  }
}

function pullRefOf(ref: ArtifactRef): PullRef {
  if (ref.kind !== "pull") throw new Error(`a pull request artifact holds a ${ref.kind} ref`);
  return ref;
}

/** The host runs no checks on a pull request that conflicts, so the merge is read first. */
async function pullChecks(
  clients: PullClients,
  ref: ArtifactRef,
  revision: string,
): Promise<ArtifactChecks> {
  const host = clients.host();
  if (!host) throw new Error("the code host is not configured");
  const { repo, number } = pullRefOf(ref);
  const pull = await host.getPull(repo, number);
  if (pull.state === "open" && pull.mergeable === null) return { state: "merge_unknown" };
  if (pull.state === "open" && !pull.mergeable) return { state: "conflicted", base: pull.base.ref };
  return host.commitChecks(repo, revision);
}

/** Null for a pull request from a fork, since its branch is not in the repository. */
async function openHeadBranch(clients: PullClients, ref: ArtifactRef): Promise<string | null> {
  const host = clients.host();
  if (!host) throw new Error("the code host is not configured");
  const { repo, number } = pullRefOf(ref);
  const pull = await host.getPull(repo, number);
  return pull.state === "open" && !pull.from_fork ? pull.head.ref : null;
}

async function headRevision(clients: PullClients, ref: ArtifactRef): Promise<string | null> {
  const host = clients.host();
  if (!host || ref.kind !== "pull") return null;
  try {
    return (await host.getPull(ref.repo, ref.number)).head.sha;
  } catch (error) {
    clients.log(`revision lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * The newest review this reviewer filed after `since`. Null when it filed none, when the host
 * cannot be reached, and when the host will not say which login is ours.
 */
async function readReview(
  clients: PullClients,
  ref: ArtifactRef,
  since: string,
): Promise<Review | null> {
  const host = clients.host();
  if (!host || ref.kind !== "pull") return null;
  try {
    const login = await host.reviewerLogin();
    const reviews = await host.pullReviews(ref.repo, ref.number);
    const latest = newestOwnReview(reviews, login, Date.parse(since));
    if (!latest) return null;
    const comments = await host.reviewComments(ref.repo, ref.number, latest.id);
    const body = latest.body ?? "";
    return {
      kind: "review",
      revision: latest.commit_id ?? (await host.getPull(ref.repo, ref.number)).head.sha,
      blocking: clients.review.blocking(latest.state, body),
      summary: body.trim(),
      findings: comments.map((comment) => ({
        location: commentLocation(comment),
        body: comment.body,
      })),
    };
  } catch (error) {
    clients.log(`review lookup failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

function commentLocation(comment: { path: string; line: number | null }): string {
  return comment.line === null ? comment.path : `${comment.path}:${comment.line}`;
}

/** The newest review this client authored since the reviewer run started. */
function newestOwnReview(
  reviews: PullRequestReview[],
  login: string,
  sinceMs: number,
): PullRequestReview | null {
  const ours = reviews.filter(
    (review) =>
      review.user?.login === login &&
      review.submitted_at !== null &&
      Date.parse(review.submitted_at) >= sinceMs,
  );
  if (!ours.length) return null;
  return ours.reduce((newest, review) => (review.id >= newest.id ? review : newest));
}

async function change(clients: PullClients, input: ChangeInput): Promise<ArtifactChange | null> {
  const { event } = input;
  if (namesAnotherPull(input)) return null;
  switch (event.kind) {
    case "pr_event":
      return pullRequestChange(clients, input);
    case "ci_event":
      return checksChange(input);
    case "feedback":
      return reviewChange(clients, input);
    default:
      return null;
  }
}

function namesAnotherPull(input: ChangeInput): boolean {
  const detail = pullDetailOf(input.event);
  const ref = input.target?.ref;
  if (!detail || !ref || ref.kind !== "pull") return false;
  return ref.repo !== detail.repo || ref.number !== detail.number;
}

async function pullRequestChange(
  clients: PullClients,
  input: ChangeInput,
): Promise<ArtifactChange | null> {
  const detail = input.event.pull;
  if (!detail) return null;
  if (detail.action === "base_moved") return checksChange(input);
  switch (detail.action) {
    case "opened":
      return input.target
        ? null
        : {
            change: "opened",
            target: { url: pullUrl(clients, detail), ref: refOf(detail) },
          };
    case "ready_for_review":
      return { change: "ready" };
    case "closed":
      return detail.merged ? { change: "accepted" } : { change: "closed" };
    default:
      return null;
  }
}

function pullUrl(clients: PullClients, detail: PullDetail): string {
  return clients.writeUrl({ kind: "pull", repo: detail.repo, number: detail.number });
}

function refOf(detail: PullDetail): PullRef {
  return { kind: "pull", repo: detail.repo, number: detail.number };
}

/** A check reported or the base branch moved. The workflow reads the checks of the head itself. */
function checksChange(input: ChangeInput): ArtifactChange | null {
  return input.target ? { change: "checks" } : null;
}

/**
 * A reviewer wrote on the pull request. The whole review is read back from the host, and only
 * the webhook that read it whole claims the review id.
 */
async function reviewChange(
  clients: PullClients,
  input: ChangeInput,
): Promise<ArtifactChange | null> {
  const { event } = input;
  const detail = pullDetailOf(event);
  const from = event.actor;
  if (!detail || !from) return null;
  const whole = detail.review_id ? await readWholeReview(clients, detail) : null;
  if (whole && !input.claim(reviewKey(detail))) {
    clients.log(`another webhook of ${reviewKey(detail)} was handled already`);
    return null;
  }
  const body = (whole?.body || event.text).trim();
  const comments = whole?.comments ?? detail.comments ?? [];
  if (!body && !comments.length) return null;
  const findings = comments.map((comment) => ({
    location: [comment.path, comment.line].filter(Boolean).join(":") || undefined,
    body: comment.body,
  }));
  const handles = acknowledgementHandles(detail, comments);
  const unchecked = detail.reviewer_is_app === true;
  return { change: "feedback", feedback: { from, unchecked, body, findings, handles } };
}

/** The key that makes every webhook naming one submitted review a single event. */
function reviewKey(detail: PullDetail): string {
  return `code:review:${detail.repo}#${detail.number}:${detail.review_id}`;
}

/** One review as the host has it. Null when it cannot be asked or does not know it yet. */
async function readWholeReview(
  clients: PullClients,
  detail: PullDetail,
): Promise<{ body: string; comments: ReviewComment[] } | null> {
  const host = clients.host();
  if (!host || !detail.review_id) return null;
  try {
    const reviews = await host.pullReviews(detail.repo, detail.number);
    const review = reviews.find((row) => row.id === detail.review_id);
    if (!review) return null;
    const comments = await host.reviewComments(detail.repo, detail.number, detail.review_id);
    const whole = {
      body: review.body ?? "",
      comments: comments.map((comment) => ({
        id: comment.id,
        path: comment.path,
        line: comment.line ?? comment.original_line ?? undefined,
        body: comment.body,
      })),
    };
    return standsForTheReview(whole, detail) ? whole : null;
  } catch (error) {
    clients.log(`review comments unavailable: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** One inline comment as the event and the host both carry it. */
type ReviewComment = { id?: number; path?: string; line?: number; body: string };

/**
 * True when the host's answer can stand for the whole review: it says something, and it holds
 * at least as many comments as the webhook in hand.
 */
function standsForTheReview(
  whole: { body: string; comments: ReviewComment[] },
  detail: PullDetail,
): boolean {
  if (!whole.body.trim() && !whole.comments.length) return false;
  return whole.comments.length >= (detail.comments?.length ?? 0);
}

/** What to react on so the reviewer sees its feedback was read, in the host's own terms. */
function acknowledgementHandles(detail: PullDetail, comments: ReviewComment[]): FeedbackHandle[] {
  if (detail.comment_id !== undefined) {
    return [{ kind: "pull", comment: { kind: "issue", id: detail.comment_id } }];
  }
  return comments.flatMap((comment): FeedbackHandle[] =>
    comment.id === undefined ? [] : [{ kind: "pull", comment: { kind: "review", id: comment.id } }],
  );
}

/**
 * Show on the pull request that feedback left there was read. A review with no comment to
 * react to gets one reply instead.
 */
async function acknowledge(
  clients: PullClients,
  handles: FeedbackHandle[],
  ref: ArtifactRef,
): Promise<void> {
  const host = clients.host();
  if (!host || ref.kind !== "pull") return;
  try {
    for (const handle of handles) {
      if (handle.kind === "pull") await host.reactToComment(ref.repo, handle.comment, "eyes");
    }
    if (!handles.length) await host.commentOnPull(ref.repo, ref.number, RELAYED_TEXT);
  } catch (error) {
    clients.log(`pull request acknowledgement failed: ${String(error).slice(0, 200)}`);
  }
}

async function removed(clients: PullClients, ref: ArtifactRef): Promise<boolean> {
  const host = clients.host();
  if (!host || ref.kind !== "pull") return false;
  try {
    const pull = await host.getPull(ref.repo, ref.number);
    return pull.state === "closed" && !pull.merged;
  } catch (error) {
    clients.log(`removal check failed: ${String(error).slice(0, 200)}`);
    return false;
  }
}

async function accepted(clients: PullClients, ref: ArtifactRef): Promise<boolean> {
  const host = clients.host();
  if (!host || ref.kind !== "pull") return false;
  try {
    return (await host.getPull(ref.repo, ref.number)).merged;
  } catch (error) {
    clients.log(`merge check failed: ${String(error).slice(0, 200)}`);
    return false;
  }
}

async function describe(clients: PullClients, target: ArtifactTarget): Promise<string> {
  const { ref, url } = target;
  if (ref.kind !== "pull") return `That task produced no pull request.`;
  const host = clients.host();
  if (!host) return `The code host is not configured. The pull request is ${url}.`;
  try {
    const pull = await host.getPull(ref.repo, ref.number);
    return [
      `${pull.title} (${pull.state}${pull.merged ? ", merged" : ""})`,
      `Head ${pull.head.ref} -> ${pull.base.ref}. Mergeable: ${String(pull.mergeable)}.`,
      await checksText(host, ref.repo, pull.head.sha),
    ].join("\n");
  } catch (error) {
    return `The code host lookup failed: ${String(error).slice(0, 300)}`;
  }
}

/** The check runs on the head commit, as lines. A refusal to read them is said as such. */
async function checksText(host: CodeHost, repo: string, sha: string): Promise<string> {
  try {
    const checks = await host.checkRunsForRef(repo, sha);
    if (!checks.length) return "No checks reported.";
    return `Checks:\n${checks.map((check) => `- ${check.name}: ${check.conclusion ?? "pending"}`).join("\n")}`;
  } catch (error) {
    return `Checks could not be read: ${String(error).slice(0, 200)}`;
  }
}
