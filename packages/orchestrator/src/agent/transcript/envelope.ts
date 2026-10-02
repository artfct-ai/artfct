import type { InboundEvent, PullEventDetail } from "@artfct-ai/contracts/inbound";

/** What the workflow already knows when an event is handed to the agent. */
export type EnvelopeContext = {
  /** True for the message that created the workflow. */
  first: boolean;
  /** The job the event is about, with its author task. */
  job: { job_id: string; task_id: string } | null;
  artifact: { kind: string; status: string } | null;
  /** What the deterministic layer already did for this event. */
  notes: string[];
};

const LINKS_LABEL = "Links:";
const SYSTEM_NOTES_LABEL = "What the system already did:";

/**
 * The user message for one inbound event. The first line is a fixed header so a scripted
 * model and tests can read it. The rest is for the real model.
 */
export function eventMessage(event: InboundEvent, context: EnvelopeContext): string {
  const header = [
    `kind=${context.first ? "request" : event.kind}`,
    `job=${context.job?.job_id ?? "none"}`,
    `task=${context.job?.task_id ?? "none"}`,
    `artifact=${context.artifact?.kind ?? "none"}`,
    `status=${context.artifact?.status ?? "none"}`,
    `pull_action=${pullAction(event)}`,
  ].join(" ");
  const lines = [`[event ${header}]`, fromLine(event)];
  if (event.title) lines.push(`Title: ${event.title}`);
  if (event.text.trim()) lines.push("", event.text.trim());
  if (event.links.length) lines.push("", LINKS_LABEL, ...event.links.map((link) => `- ${link}`));
  if (event.pull) lines.push("", pullRequestLine(event.pull, pullAction(event)));
  if (context.notes.length) {
    lines.push("", SYSTEM_NOTES_LABEL, ...context.notes.map((note) => `- ${note}`));
  }
  return lines.join("\n");
}

/** The words the person wrote, read back out of an event message. Empty for a note. */
export function eventBody(message: string): string {
  if (!parseHeader(message)) return "";
  const [, ...blocks] = message.split("\n\n");
  return blocks
    .filter((block) => !block.startsWith(LINKS_LABEL) && !block.startsWith(SYSTEM_NOTES_LABEL))
    .join("\n\n");
}

/** A message from the system itself: harness progress, timers, executed controls. */
export function noteMessage(text: string): string {
  return `[note]\n${text}`;
}

/** The header fields of an event message. Null for notes and free text. */
export function parseHeader(text: string): Record<string, string> | null {
  const match = /^\[event ([^\]]*)\]/.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const pair of match[1]!.split(" ")) {
    const [key, value] = pair.split("=");
    if (key && value !== undefined) fields[key] = value;
  }
  return fields;
}

function pullAction(event: InboundEvent): string {
  if (!event.pull) return "none";
  if (event.pull.action === "closed") return event.pull.merged ? "merged" : "closed";
  return event.pull.action;
}

/** Who the event is from, and the channel it came in on when it has one to reply to. */
function fromLine(event: InboundEvent): string {
  const channel = event.reply_to ? ` via ${event.reply_to.source}` : "";
  return `From: ${actorName(event)}${channel}`;
}

function actorName(event: InboundEvent): string {
  if (!event.actor) return "the system, not a person";
  return event.actor.display_name ?? event.actor.email ?? event.actor.person_id;
}

function pullRequestLine(pull: PullEventDetail, action: string): string {
  if (pull.action === "base_moved") {
    return `Pull requests on ${pull.repo} base ${pull.base} action=base_moved`;
  }
  const parts = [`Pull request: ${pull.repo}#${pull.number} action=${action}`];
  if (pull.conclusion) parts.push(`conclusion=${pull.conclusion}`);
  if (pull.check_names?.length) parts.push(`checks=${pull.check_names.join(",")}`);
  if (pull.reviewer) parts.push(`reviewer=${pull.reviewer}`);
  return parts.join(" ");
}
