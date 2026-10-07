import type { HeldComment } from "@artfct-ai/adapters/documents/types";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ArtifactChange, ArtifactTarget, Feedback } from "../../artifact/types";
import { screenText, type Screened } from "../../decisions/screen";
import { feedbackText } from "../../prompts/review-prompt";
import { recordArtifact } from "../artifact";
import { cancelRefinerRunOf, cancelTask } from "../lifecycle";
import { promptTask } from "../task/harness/prompt-queue";
import { isTaskFinished } from "../store/state";
import type { ArtifactRow, TaskRow } from "../store/tasks";
import { jobsForEvent, noMatchingJobNote } from "../inbound/lookup";
import type { Applied, Wake, WorkflowRuntime } from "../types";
import { settleChecks } from "./checks-recheck";
import { settleRefinersForAuthor } from "./loop";
import { feedbackRoute } from "./feedback-route";
import { heldCommentFindings, heldCommentHandles } from "./held-comments";
import { markArtifactReady } from "./outcome";

/**
 * Apply one inbound event to every artifact it may be about, as the artifact's own kind
 * reads it. A job with no author task yet has no artifact, so the event skips it. "handled"
 * when every change was one the agent does not hear about.
 */
export async function applyArtifactEvent(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<Applied | "handled"> {
  const jobs = jobsForEvent(workflow, event);
  if (!jobs.length) return noMatchingJobNote(workflow);
  const applied: Applied[] = [];
  let handled = false;
  for (const job of jobs) {
    const task = workflow.store.authorTask(job.job_id);
    if (!task) continue;
    const artifact = workflow.store.artifact(job.job_id);
    const change = await changeFor(workflow, task, artifact, event);
    if (!change) continue;
    const result = await applyChange(workflow, task, artifact, change);
    if (result === "handled") handled = true;
    else applied.push(result);
  }
  if (!applied.length) {
    return handled ? "handled" : { notes: [`${event.kind}: nothing to record.`], wake: "none" };
  }
  return {
    notes: applied.flatMap((result) => result.notes),
    wake: applied.map((result) => result.wake).reduce(strongerWake),
  };
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
    claim: (id) => workflow.store.markEventSeen({ id, kind: event.kind }),
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

async function applyChange(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
  change: ArtifactChange,
): Promise<Applied | "handled"> {
  switch (change.change) {
    case "opened":
      return onOpened(workflow, task, artifact, change.target);
    case "feedback":
      return onFeedback(workflow, task, artifact, change.feedback);
    case "comment_held":
      workflow.log(task.task_id, "a page comment waits for a mention");
      return "handled";
    case "mentioned":
      return onMentioned(workflow, task, artifact, change);
    case "ready":
      return onHostReady(workflow, task, artifact);
    case "accepted":
      return onAccepted(workflow, task, artifact);
    case "closed":
      return onClosed(workflow, task);
    case "checks":
      return onChecks(workflow, task);
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
    case "too_large":
      return `${reviewed}. It is too large to screen. ${told}`;
    default: {
      const unreachable: never = screened;
      throw new Error(`unhandled screen outcome ${String(unreachable)}`);
    }
  }
}

/**
 * A person posted about the artifact. Unchecked feedback passes the screen first, and one it
 * does not admit goes to nobody. Then mark it read on the host. What only the author can act
 * on goes to the author, a remark that asks for nothing goes nowhere, and the rest is the agent's.
 */
async function onFeedback(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
  feedback: Feedback,
): Promise<Applied> {
  const who = feedback.from.display_name ?? feedback.from.email ?? "A reviewer";
  const count = feedback.findings.length;
  const left = count ? ` and left ${count} comment${count === 1 ? "" : "s"}` : "";
  const wrote = `${who} reviewed the artifact of job ${task.job_id}${left}`;
  const reviewed = `${wrote}. The system marked it read on the host`;
  const said = feedbackText(who, feedback);
  workflow.log(task.task_id, `${who} reviewed`);
  if (feedback.unchecked) {
    const screened = await screenText(workflow, `feedback on job ${task.job_id}`, said);
    if (screened !== "admitted") {
      return { notes: [unadmittedFeedbackNote(wrote, screened)], wake: "human" };
    }
  }
  if (artifact) {
    await workflow.artifact(artifact.kind).acknowledge(feedback.handles, artifact.ref);
  }
  if (isTaskFinished(task.status)) {
    const dead = `That task is ${task.status}, so nothing can be sent to it.`;
    return { notes: [`${reviewed} and sent it to nobody. ${dead}`, said], wake: "human" };
  }
  const route = await feedbackRoute(workflow, task.task_id, said);
  switch (route) {
    case "author":
      await promptTask(workflow, task, said);
      return { notes: [`${reviewed} and sent it whole to the author.`, said], wake: "none" };
    case "nobody":
      return {
        notes: [`${reviewed}. It asks for nothing, so nobody was sent it.`, said],
        wake: "none",
      };
    case "agent":
      return { notes: [`${reviewed} and sent it to nobody.`, said], wake: "human" };
    default: {
      const unreachable: never = route;
      throw new Error(`unhandled feedback route ${String(unreachable)}`);
    }
  }
}

/**
 * A person mentioned the document user in a comment on the page. The held comments the host
 * shows and this one go out as one feedback. When the host cannot be read, they all stay held.
 */
async function onMentioned(
  workflow: WorkflowRuntime,
  task: TaskRow,
  artifact: ArtifactRow | null,
  change: Extract<ArtifactChange, { change: "mentioned" }>,
): Promise<Applied> {
  const who = change.from.display_name ?? change.from.email ?? "A person";
  const kind = workflow.stageForTask(task).artifact;
  const held = await heldBesidesMention(workflow, task, change);
  if (!held) {
    return {
      notes: [
        `${who} asked on the page for the held comments of job ${task.job_id} to go to the author, but the host could not be read. They stay held, with that comment. Call send_held_comments to try again.`,
      ],
      wake: "human",
    };
  }
  const feedback: Feedback = {
    from: change.from,
    unchecked: held.length > 0,
    body: change.body,
    findings: heldCommentFindings(held),
    handles: [...heldCommentHandles(held), { kind: "page", comment_id: change.comment_id }],
  };
  if (!feedback.body && !feedback.findings.length) {
    if (artifact) await workflow.artifact(kind).acknowledge(feedback.handles, artifact.ref);
    return {
      notes: [
        `${who} mentioned you on the page of job ${task.job_id}. No comments are held and the comment says nothing else, so nothing was sent.`,
      ],
      wake: "none",
    };
  }
  return onFeedback(workflow, task, artifact, feedback);
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

/** The host closed the artifact without accepting it. The job has nothing left to produce. */
async function onClosed(workflow: WorkflowRuntime, task: TaskRow): Promise<Applied> {
  workflow.store.advanceArtifact(task.job_id, ["drafted", "ready"], "removed");
  await cancelTask(workflow, task, "the artifact was closed without being accepted");
  return {
    notes: [
      `The artifact of job ${task.job_id} was closed without being accepted. The job is cancelled and its sandbox destroyed. Ask whether to retry on a new branch or abandon.`,
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
      `A check reported on the artifact of job ${task.job_id}, or its base branch moved. The system reads the checks and the merge, and sends a failure or a conflict to the task that pushed the revision. Nothing to do.`,
    ],
    wake: "none",
  };
}
