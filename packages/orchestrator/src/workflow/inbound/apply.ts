import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { noteMessage } from "../../agent/transcript/envelope";
import { parseControl } from "./control-words";
import { applyControlWord, stopAuthor, type StopOutcome } from "./controls";
import { authorsToStopInSession, runningAuthorInSession } from "./job-session";
import { promptTask } from "../task/harness/prompt-queue";
import { applyArtifactEvent } from "../refiner/feedback";
import type { Applied, WorkflowRuntime } from "../types";

/**
 * The deterministic layer. Records what the host says about an artifact and executes explicit
 * control words. Returns notes for the agent, or "handled" when no agent turn is needed.
 */
export async function applyEvent(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<Applied | "handled"> {
  switch (event.kind) {
    case "status":
      return (await forwardToRunningAuthor(workflow, event)) ?? { notes: [], wake: "message" };
    case "stop":
      return stopSessionAuthors(workflow, event);
    case "control":
      return executeControl(workflow, event);
    case "start":
    case "prompt":
      return onHumanText(workflow, event);
    case "feedback":
    case "pr_event":
    case "ci_event":
      return applyArtifactEvent(workflow, event);
    default: {
      const unreachable: never = event.kind;
      throw new Error(`unhandled event kind ${String(unreachable)}`);
    }
  }
}

/**
 * Text a person wrote. A reply in a job session whose author runs goes to that author. A leading
 * control word runs here when one job clearly owns it. Anything else goes to the agent. A start
 * with no actor is a tracker session to adopt. Any other text with no actor has no person behind
 * it and is dropped.
 */
async function onHumanText(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<Applied | "handled"> {
  if (!event.actor) {
    if (event.kind === "start") return adoptSession(workflow, event);
    workflow.log(null, `${event.kind} with no person behind it, dropped`);
    return "handled";
  }
  if (event.kind === "prompt") {
    const forwarded = await forwardToRunningAuthor(workflow, event);
    if (forwarded) return forwarded;
  }
  const parsed = parseControl(event.text);
  if (!parsed) return { notes: [], wake: "message" };
  const active = workflow.store.activeAuthorAndResearcherTasks().length;
  if (parsed.control !== "cancel" && active !== 1) return { notes: [], wake: "message" };
  return executeControl(workflow, {
    ...event,
    kind: "control",
    control: parsed.control,
    text: parsed.rest,
  });
}

/** A session nobody opened becomes a reply target. The orchestrator does not post in it. */
async function adoptSession(workflow: WorkflowRuntime, event: InboundEvent): Promise<"handled"> {
  const issue = event.reply_to?.source === "tracker" ? event.reply_to.issue_id : "the issue";
  await workflow.tellAgent(
    noteMessage(`The tracker opened an agent session on ${issue}. It is a reply channel now.`),
    "none",
  );
  return "handled";
}

/**
 * Run a control word and tell the agent. When it posted nothing for a person who waits for an
 * answer, the agent gets a turn to answer them.
 */
async function executeControl(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<Applied | "handled"> {
  const postedBefore = workflow.store.postedCount();
  const leftAlone = await applyControlWord(workflow, event);
  const outcome = leftAlone ? `The system left it alone: ${leftAlone}.` : "The system executed it.";
  const note = `${personName(event)} sent the control word "${event.control}". ${outcome}`;
  if (event.reply_to && workflow.store.postedCount() === postedBefore) {
    return { notes: [`${note} Nothing was posted about it. Answer them.`], wake: "message" };
  }
  await workflow.tellAgent(noteMessage(note), "none");
  return "handled";
}

/**
 * A reply in a job session whose author runs goes to that author as a prompt. Nothing is posted.
 * Null when the event is not a person's reply in such a session.
 */
async function forwardToRunningAuthor(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<Applied | null> {
  if (!event.actor || event.reply_to?.source !== "tracker") return null;
  const author = runningAuthorInSession(workflow, event.reply_to);
  if (!author) return null;
  await promptTask(workflow, author, event.text);
  workflow.log(author.task_id, "a reply in its job session reached the author");
  const note = `The author ${author.task_id} got this message as a prompt. Nothing was posted.`;
  return { notes: [note], wake: "none" };
}

const STOP_NOTES: Record<StopOutcome, string> = {
  cancelled: "Its prompt turn was cancelled.",
  ended: "The turn its sandbox was resuming was ended.",
  idle: "No prompt turn ran.",
};

/**
 * A stop in a job session ends the turn of each author there and drops their queued prompts.
 * Their session feed ends with the stopped reply. The tasks, the jobs, and the workflow keep
 * running.
 */
export async function stopSessionAuthors(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): Promise<Applied | "handled"> {
  const authors =
    event.actor && event.reply_to?.source === "tracker"
      ? authorsToStopInSession(workflow, event.reply_to)
      : [];
  if (authors.length === 0) {
    workflow.log(null, "stop ignored: no author works in its job session");
    return "handled";
  }
  const notes: string[] = [];
  for (const author of authors) {
    const outcome = await stopAuthor(workflow, author);
    workflow.log(author.task_id, `stop: ${outcome}`);
    notes.push(
      `${personName(event)} pressed Stop in the job session of ${author.task_id}. ${STOP_NOTES[outcome]} Its queued prompts were dropped. Do not prompt it again until a person asks.`,
    );
  }
  return { notes, wake: "none" };
}

function personName(event: InboundEvent): string {
  return event.actor?.display_name ?? event.actor?.email ?? "someone";
}
