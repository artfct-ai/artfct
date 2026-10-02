import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { noteMessage } from "../../agent/transcript/envelope";
import { parseControl } from "./control-words";
import { applyControlWord } from "./controls";
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
      return { notes: [], wake: "message" };
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
 * Text a person wrote. A leading control word runs here when one job clearly owns it.
 * Anything else goes to the agent. A start with no actor is a tracker session to adopt. Any
 * other text with no actor has no person behind it and is dropped.
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

async function adoptSession(workflow: WorkflowRuntime, event: InboundEvent): Promise<"handled"> {
  const text = `Tracking this issue here. Workflow ${workflow.state.workflow_id} is working on it.`;
  if (event.reply_to) await workflow.post({ type: "info", text }, event.reply_to);
  const issue = event.reply_to?.source === "tracker" ? event.reply_to.issue_id : "the issue";
  await workflow.tellAgent(
    noteMessage(`The tracker opened an agent session on ${issue}. It is a reply channel now.`),
    "none",
  );
  return "handled";
}

async function executeControl(workflow: WorkflowRuntime, event: InboundEvent): Promise<"handled"> {
  const leftAlone = await applyControlWord(workflow, event);
  const who = event.actor?.display_name ?? event.actor?.email ?? "someone";
  const outcome = leftAlone ? `The system left it alone: ${leftAlone}.` : "The system executed it.";
  await workflow.tellAgent(
    noteMessage(`${who} sent the control word "${event.control}". ${outcome}`),
    "none",
  );
  return "handled";
}
