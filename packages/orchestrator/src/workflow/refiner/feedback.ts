import type { HeldComment } from "@artfct-ai/adapters/documents/types";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { pageCommentLabel } from "../../artifact/page-comment-label";
import type { ArtifactChange, ArtifactTarget, Feedback, Finding } from "../../artifact/types";
import { screenText, type Screened } from "../../decisions/screen";
import { feedbackText } from "../../prompts/review-prompt";
import { recordArtifact } from "../artifact";
import { cancelRefinerRunOf, cancelTask } from "../lifecycle";
import { promptTask } from "../task/harness/prompt-queue";
import { isTaskFinished, isWorkflowFinished } from "../store/state";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import { jobsForEvent, noMatchingJobNote } from "../inbound/lookup";
import type { Applied, Wake, WorkflowRuntime } from "../types";
import { settleChecks } from "./checks-recheck";
import { settleRefinersForAuthor } from "./loop";
import { feedbackRoute } from "./feedback-route";
import { heldCommentFindings, markHeldCommentsRead } from "./held-comments";
import { markArtifactReady } from "./outcome";

/**
 * What one job made of the event. Notes that route a feedback land when the agent gets them, so
 * `landsUnder` is the key their landing marks seen. Null when the change landed already.
 */
type JobApplied = { applied: Applied; landsUnder: string | null };

/**
 * Apply one inbound event to every artifact it may be about, as the artifact's own kind
 * reads it. A job with no author task yet has no artifact, so the event skips it. An ended
 * workflow ignores it. "handled" when every change was one the agent does not hear about.
 */
export async function applyArtifactEvent(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<Applied | "handled"> {
  const jobs = jobsForEvent(workflow, event);
  if (!jobs.length) return noMatchingJobNote(workflow);
  const results: JobApplied[] = [];
  let handled = false;
  for (const job of jobs) {
    const author = workflow.store.authorTask(job.job_id);
    if (!author) continue;
    const change = await changeFor(workflow, author, workflow.store.artifact(job.job_id), event);
    if (!change) continue;
    if (isWorkflowFinished(workflow.store.requireWorkflowRow().status)) return "handled";
    const task = workflow.store.requireTask(author.task_id);
    const result = await applyChange(workflow, task, workflow.store.artifact(job.job_id), change);
    if (result === "handled") handled = true;
    else results.push(result);
  }
  const applied = landNotes(workflow, results);
  if (!applied.length) {
    if (handled || results.length) return "handled";
    return { notes: [`${event.kind}: nothing to record.`], wake: "none" };
  }
  return {
    notes: applied.flatMap((result) => result.notes),
    wake: applied.map((result) => result.wake).reduce(strongerWake),
  };
}

/**
 * Mark seen each feedback whose notes route it, as the notes land. The caller hands the notes to
 * the agent before its next await. Notes of a feedback another delivery routed are dropped.
 */
function landNotes(workflow: WorkflowRuntime, results: JobApplied[]): Applied[] {
  return results.flatMap(({ applied, landsUnder }) => {
    if (landsUnder === null) return [applied];
    if (routedAlready(workflow, landsUnder)) return [];
    workflow.store.markEventSeen(landsUnder);
    return [applied];
  });
}

/** The seen-event id of one feedback's routing decision on one job. Each job routes it once. */
function feedbackDedupeKey({ dedupeKey, jobId }: { dedupeKey: string; jobId: string }): string {
  return `feedback:${jobId}:${dedupeKey}`;
}

/** True when another delivery of the feedback was routed on its job. */
function routedAlready(workflow: WorkflowRuntime, key: string): boolean {
  if (!workflow.store.eventSeen(key)) return false;
  workflow.log(null, `another delivery of ${key} was routed`);
  return true;
}

function changeFor(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
  event: InboundEvent,
): Promise<ArtifactChange | null> {
  return workflow.artifact(workflow.stageForTask(task).artifact).change({
    event,
    target: artifact ? targetOf(artifact) : null,
  });
}

/** The wake that needs the agent the most. */
function strongerWake(left: Wake, right: Wake): Wake {
  return WAKE_ORDER.indexOf(left) >= WAKE_ORDER.indexOf(right) ? left : right;
}

const WAKE_ORDER: Wake[] = [
  "none",
  "task_result",
  "task_idle",
  "external_state",
  "human",
  "message",
  "blocked",
];

function targetOf(artifact: ArtifactRow): ArtifactTarget {
  return { ref: artifact.ref, url: artifact.external_url };
}

/** A change whose effect landed already. */
function landed(applied: Applied): JobApplied {
  return { applied, landsUnder: null };
}

async function applyChange(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
  change: ArtifactChange,
): Promise<JobApplied | "handled"> {
  switch (change.change) {
    case "opened":
      return landed(await onOpened(workflow, task, artifact, change.target));
    case "feedback": {
      const { feedback } = change;
      const key = feedbackDedupeKey({ dedupeKey: feedback.dedupeKey, jobId: task.job_id });
      if (routedAlready(workflow, key)) return "handled";
      return onFeedback(workflow, { task, artifact, feedback, held: [], key });
    }
    case "comment_held":
      workflow.log(task.task_id, "a page comment waits for a mention");
      return "handled";
    case "mentioned": {
      const key = feedbackDedupeKey({ dedupeKey: change.dedupeKey, jobId: task.job_id });
      if (routedAlready(workflow, key)) return "handled";
      return onMentioned(workflow, { task, artifact, change, key });
    }
    case "ready":
      return landed(await onHostReady(workflow, task, artifact));
    case "accepted":
      return landed(onAccepted(workflow, task, artifact));
    case "closed":
      return landed(await onClosed(workflow, task));
    case "checks":
      return landed(await onChecks(workflow, task));
    default: {
      const unreachable: never = change;
      throw new Error(`unhandled artifact change ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The host opened the artifact before the author printed a link to it. */
async function onOpened(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
  target: ArtifactTarget,
): Promise<Applied> {
  if (artifact) return { notes: ["The artifact is already recorded."], wake: "none" };
  await recordArtifact(workflow, task, target);
  await settleRefinersForAuthor(workflow, workflow.store.requireTask(task.task_id));
  const held = workflow.store.artifact(task.job_id)?.status === "drafted";
  const next = held
    ? "The review has it. The humans hear about it when the review settles."
    : "The humans have it.";
  return {
    notes: [`Recorded ${target.url} as the artifact of job ${task.job_id}. ${next}`],
    wake: "none",
  };
}

/** What the agent hears about feedback the screen did not admit. It never holds the feedback. */
export function unadmittedFeedbackNote(
  reviewed: string,
  screened: Exclude<Screened, "admitted">,
): string {
  const told = "Nobody was sent it and you cannot read it. Tell the humans.";
  switch (screened) {
    case "quarantined":
      return `${reviewed}. The screen quarantined it, because text in it looks written to steer an AI agent. ${told}`;
    case "unchecked":
      return `${reviewed}. The screen could not check it right now, so it is held back. ${told}`;
    case "too_large":
      return `${reviewed}. It is too large to screen. ${told}`;
    default: {
      const unreachable: never = screened;
      throw new Error(`unhandled screen outcome ${String(unreachable)}`);
    }
  }
}

/** One feedback on one job, the comments held on the page besides it, and its seen-event key. */
type FeedbackOnJob = {
  task: TaskRow;
  artifact: ArtifactRow | null;
  feedback: Feedback;
  held: HeldComment[];
  key: string;
};

/**
 * A person posted about the artifact. `held` are the comments held on the page besides it. They
 * are screened with it. Unchecked feedback passes the screen first, and one it does not admit
 * goes to nobody. Then mark it read on the host. What only the author can act on goes to the
 * author with the held comments the host marks read, a remark that asks for nothing goes nowhere,
 * and the rest is the agent's. Held comments that do not go to the author stay held.
 */
async function onFeedback(
  workflow: WorkflowRuntime,
  routing: FeedbackOnJob,
): Promise<JobApplied | "handled"> {
  const { task, artifact, feedback, held, key } = routing;
  const toTheAgent = (applied: Applied): JobApplied => ({ applied, landsUnder: key });
  const who = feedback.from.display_name ?? feedback.from.email ?? "A reviewer";
  const count = feedback.findings.length + held.length;
  const left = count ? ` and left ${count} comment${count === 1 ? "" : "s"}` : "";
  const wrote = `${who} reviewed the artifact of job ${task.job_id}${left}`;
  const said = feedbackText(who, withHeldComments(feedback, held));
  workflow.log(task.task_id, `${who} reviewed`);
  if (feedback.unchecked || held.length) {
    const screened = await screenText(workflow, {
      source: `feedback on job ${task.job_id}`,
      text: said,
    });
    if (screened !== "admitted") {
      return toTheAgent({ notes: [unadmittedFeedbackNote(wrote, screened)], wake: "human" });
    }
  }
  const unmarked = artifact
    ? await workflow.artifact(artifact.kind).acknowledge(feedback.handles, artifact.ref)
    : [];
  const stayHeld = held.length ? " The held comments were not sent. They stay held." : "";
  if (unmarked.length) {
    return toTheAgent({
      notes: [
        `${wrote}. The host did not mark it read, so nobody was sent it.${held.length ? " They stay held." : ""} Tell the humans.`,
        said,
      ],
      wake: "human",
    });
  }
  const reviewed = `${wrote}. The system marked it read on the host`;
  if (isTaskFinished(task.status)) {
    return toTheAgent(
      sentToAFinishedTask(task, `${reviewed} and sent it to nobody.`, said, stayHeld),
    );
  }
  const route = await feedbackRoute(workflow, task.task_id, said);
  switch (route) {
    case "author":
      return sendFeedbackToAuthor(workflow, { ...routing, reviewed, said });
    case "nobody":
      return toTheAgent({
        notes: [`${reviewed}. It asks for nothing, so nobody was sent it.${stayHeld}`, said],
        wake: "none",
      });
    case "agent":
      return toTheAgent({
        notes: [`${reviewed} and sent it to nobody.${stayHeld}`, said],
        wake: "human",
      });
    default: {
      const unreachable: never = route;
      throw new Error(`unhandled feedback route ${String(unreachable)}`);
    }
  }
}

/** What the agent hears about feedback for a task that finished. */
function sentToAFinishedTask(
  task: TaskRow,
  sentNowhere: string,
  said: string,
  stayHeld: string,
): Applied {
  const dead = `That task is ${task.status}, so nothing can be sent to it.${stayHeld}`;
  return { notes: [`${sentNowhere} ${dead}`, said], wake: "human" };
}

/** The feedback with the held comments after its own findings. */
function withHeldComments(feedback: Feedback, held: HeldComment[]): Feedback {
  return { ...feedback, findings: [...feedback.findings, ...heldCommentFindings(held)] };
}

/**
 * Mark the held comments read and send the author the feedback with the ones the host marked.
 * The rest stay held. The prompt lands with the mark of the feedback's key, so a second delivery
 * of it sends nothing.
 */
async function sendFeedbackToAuthor(
  workflow: WorkflowRuntime,
  sending: FeedbackOnJob & { reviewed: string; said: string },
): Promise<JobApplied | "handled"> {
  const { artifact, feedback, held, key, reviewed, said } = sending;
  const carried =
    artifact && held.length ? await markHeldCommentsRead(workflow, artifact, held) : [];
  const task = workflow.store.requireTask(sending.task.task_id);
  if (isTaskFinished(task.status)) {
    const applied = sentToAFinishedTask(task, `${reviewed} and sent it to nobody.`, said, "");
    return { applied, landsUnder: key };
  }
  if (routedAlready(workflow, key)) return "handled";
  workflow.store.markEventSeen(key);
  const who = feedback.from.display_name ?? feedback.from.email ?? "A reviewer";
  await promptTask(workflow, task, feedbackText(who, withHeldComments(feedback, carried)));
  const left = held.length - carried.length;
  const sent = left
    ? `${reviewed} and sent it to the author. The host did not mark ${left} held comment${left === 1 ? "" : "s"} read, so ${left === 1 ? "it was" : "they were"} not sent. They stay held.`
    : `${reviewed} and sent it whole to the author.`;
  return landed({ notes: [sent, said], wake: "none" });
}

/**
 * A person mentioned the document user in a comment on the page. The held comments the host
 * shows go out with this one as one feedback, each labeled with its comment so the author can
 * reply to it. When the host cannot be read, they all stay held. A bare mention with nothing
 * held goes to the agent, which asks the person what they want.
 */
async function onMentioned(
  workflow: WorkflowRuntime,
  mentioned: {
    task: TaskRow;
    artifact: ArtifactRow | null;
    change: Extract<ArtifactChange, { change: "mentioned" }>;
    key: string;
  },
): Promise<JobApplied | "handled"> {
  const { task, artifact, change, key } = mentioned;
  const who = change.from.display_name ?? change.from.email ?? "A person";
  const kind = workflow.stageForTask(task).artifact;
  const held = await heldBesidesMention(workflow, task, change);
  if (!held) {
    const applied: Applied = {
      notes: [
        `${who} asked on the page for the held comments of job ${task.job_id} to go to the author, but the host could not be read. They stay held, with that comment. Call prompt_task on the author to try again. The held comments go with it.`,
      ],
      wake: "human",
    };
    return { applied, landsUnder: key };
  }
  const mention: Finding[] = change.body
    ? [{ location: pageCommentLabel(change.comment_id), body: `${who}: ${change.body}` }]
    : [];
  const feedback: Feedback = {
    dedupeKey: change.dedupeKey,
    from: change.from,
    unchecked: false,
    body: "",
    findings: mention,
    handles: [{ kind: "page", comment_id: change.comment_id }],
  };
  if (!feedback.findings.length && !held.length) {
    if (artifact) await workflow.artifact(kind).acknowledge(feedback.handles, artifact.ref);
    const applied: Applied = {
      notes: [
        `${who} mentioned you on the page of job ${task.job_id}. No comments are held and the comment says nothing else, so nothing was sent. Ask them what they want.`,
      ],
      wake: "human",
    };
    return { applied, landsUnder: key };
  }
  return onFeedback(workflow, { task, artifact, feedback, held, key });
}

/** The held comments on the page other than the mention. Null when the host cannot be read. */
async function heldBesidesMention(
  workflow: WorkflowRuntime,
  task: TaskRow,
  change: Extract<ArtifactChange, { change: "mentioned" }>,
): Promise<HeldComment[] | null> {
  const support = workflow.artifact(workflow.stageForTask(task).artifact).heldComments;
  if (!support) return [];
  try {
    const comments = await support.read(change.page_id);
    return comments.filter((comment) => comment.id !== change.comment_id);
  } catch (error) {
    workflow.log(task.task_id, `held comments unreadable: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** A human took the artifact over on the host. The reviewer has nothing left to say about it. */
async function onHostReady(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
): Promise<Applied> {
  if (!artifact || artifact.status !== "drafted") {
    return { notes: ["The artifact is already with the humans."], wake: "none" };
  }
  await cancelRefinerRunOf(workflow, task.job_id, "a human took the artifact over");
  await markArtifactReady(workflow, task.job_id, { close: "ready" });
  return {
    notes: [
      `A human marked the artifact of job ${task.job_id} ready on the host. Any running review was stopped and the humans have it now.`,
    ],
    wake: "external_state",
  };
}

/** The host closed the artifact the way it closes an accepted one. */
function onAccepted(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
): Applied {
  if (!artifact) return { notes: ["No artifact is recorded for this job."], wake: "none" };
  workflow.store.advanceArtifact(task.job_id, ["drafted", "ready"], "accepted");
  workflow.log(task.task_id, "artifact accepted");
  return {
    notes: [`The artifact of job ${task.job_id} was accepted. Call complete_job for it.`],
    wake: "external_state",
  };
}

/**
 * The host closed the artifact without accepting it. The job has nothing left to produce. A job
 * that completed its issue keeps the issue, so the agent tells the humans instead of retrying.
 */
async function onClosed(workflow: WorkflowRuntime, task: TaskRow): Promise<Applied> {
  workflow.store.advanceArtifact(task.job_id, ["drafted", "ready"], "removed");
  const completed = workflow.store.requireTask(task.task_id).status === "done";
  await cancelTask(workflow, task, "the artifact was closed without being accepted");
  const closed = `The artifact of job ${task.job_id} was closed without being accepted.`;
  const issueKey = workflow.store.requireJob(task.job_id).issue_key;
  if (completed && issueKey) {
    return {
      notes: [
        `${closed} The job completed ${issueKey}, and a job does not start on an issue whose job completed. Tell the humans.`,
      ],
      wake: "external_state",
    };
  }
  return {
    notes: [
      `${closed} The job is cancelled and its sandbox destroyed. Ask whether to retry on a new branch or abandon.`,
    ],
    wake: "external_state",
  };
}

/**
 * A check reported on the host or the base branch moved. The workflow reads the host itself,
 * so no agent turn is needed.
 */
async function onChecks(workflow: WorkflowRuntime, task: TaskRow): Promise<Applied> {
  await settleChecks(workflow, task.job_id);
  return {
    notes: [
      `A check reported on the artifact of job ${task.job_id}, or its base branch moved. The system reads the checks and the merge, and sends a failure or a conflict to the submitter of the revision. Nothing to do.`,
    ],
    wake: "none",
  };
}
