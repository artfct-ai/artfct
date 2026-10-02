import type { PlanEntry } from "@agentclientprotocol/sdk";
import type { TaskStatus } from "@artfct-ai/contracts/types";
import type {
  BoardFormat,
  BoardInput,
  BoardRender,
  BoardWork,
  RefinerPhaseView,
  TodoSnapshot,
} from "./types";

/** How many harness todo entries a board lists before it folds the rest into `+N more`. */
export const BOARD_MAX_ENTRIES = 10;

/** The longest note or entry text the board prints. */
const MAX_TEXT_LENGTH = 200;

const EMPTY_TODO_LINE = "no todo list reported by the harness yet";
const WORKING_SUFFIX = " ← working";
const SEPARATOR = " · ";
const READY_FOR_HUMANS = "Ready for Humans";
const FOLLOW_UPS = "follow-ups";
const CLOSED_LABEL = "complete";
const PAUSED_LABEL = "paused";

/**
 * Render one task board: the harness todo list, the phases of its artifact, and the task
 * lifecycle. Pure. The stamp sits off the body, so an unchanged board hashes the same.
 */
export function renderBoard(input: BoardInput, format: BoardFormat): BoardRender {
  const header = bold(headerText(input), format);
  const rest: string[] = [];
  if (input.note !== null && !heldByHumans(input)) {
    rest.push(`note: ${boardText(input.note)}`);
  }
  rest.push("", ...checklistLines(input, format));
  return {
    body: [header, ...rest].join("\n"),
    text: [header, stampLine(input), ...rest].join("\n"),
  };
}

/** The short lifecycle word a reader sees for a task status. */
export function lifecycleLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
    case "provisioning":
      return "starting";
    case "working":
      return "working";
    case "in_review":
      return "in review";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled task status ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Entries the harness has not completed. Zero when the harness reported no todos. */
export function openEntryCount(todos: TodoSnapshot | null): number {
  if (todos === null) {
    return 0;
  }
  return todos.entries.filter((entry) => entry.status !== "completed").length;
}

/** True while the humans hold the artifact, handed over or accepted, and no follow-up is in progress. */
function heldByHumans(input: BoardInput): boolean {
  if (input.follow_up === "in_progress") return false;
  return input.artifact_status === "ready" || input.artifact_status === "accepted";
}

function isClosed(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** The word a header shows for what the task works on. */
export function boardWorkWord(work: BoardWork): string {
  return "stage" in work ? work.stage : work.phase;
}

/** The workflow, the stage, the ticket, then what the task is doing. */
function headerText(input: BoardInput): string {
  const { task } = input;
  const parts = [task.workflow_name, boardWorkWord(task.work)];
  if (task.ticket_key !== null) parts.push(task.ticket_key);
  parts.push(lifecycleText(input));
  return parts.join(SEPARATOR);
}

function lifecycleText(input: BoardInput): string {
  if (heldByHumans(input) && input.task.status !== "failed" && input.task.status !== "cancelled") {
    return CLOSED_LABEL;
  }
  if (input.task.paused && !isClosed(input.task.status)) return PAUSED_LABEL;
  const label = lifecycleLabel(input.task.status);
  const open = openEntryCount(input.todos);
  if (!isClosed(input.task.status) || open === 0) {
    return label;
  }
  return `${label}, ${open} ${open === 1 ? "item" : "items"} still open`;
}

/** The job number, then the two times. The only clock on the board. */
function stampLine(input: BoardInput): string {
  return [
    `Job ${input.task.number}`,
    `started ${clock(Date.parse(input.task.started_at))}`,
    `updated ${clock(input.now)} UTC`,
  ].join(SEPARATOR);
}

/**
 * The harness list, the follow-up line, then the phases and the humans line. The fallback line
 * only when the task has none of them.
 */
function checklistLines(input: BoardInput, format: BoardFormat): string[] {
  const harness = harnessLines(input.todos, format);
  const followUp = followUpLine(input.follow_up, format);
  const phases = refinerBoardLines(input.refiners, format);
  const humans = humansLine(input.refiners, format);
  if (harness.length === 0 && followUp.length === 0 && phases.length === 0) {
    return [EMPTY_TODO_LINE];
  }
  return [...harness, ...followUp, ...phases, ...humans];
}

/** What the harness reported, folded past the cap. */
function harnessLines(todos: TodoSnapshot | null, format: BoardFormat): string[] {
  const entries = todos?.entries ?? [];
  if (entries.length === 0) return [];
  const shown = entries.slice(0, BOARD_MAX_ENTRIES).map((entry) => entryLine(entry, format));
  const hidden = entries.length - shown.length;
  return hidden > 0 ? [...shown, `+${hidden} more`] : shown;
}

/** The one line for the follow-ups of the artifact the humans hold. None before the first. */
function followUpLine(status: BoardInput["follow_up"], format: BoardFormat): string[] {
  if (status === null) return [];
  return [entryLine(derivedEntry(FOLLOW_UPS, status), format)];
}

/** One checklist line per phase the stage declares, review then polish. */
function refinerBoardLines(refiners: BoardInput["refiners"], format: BoardFormat): string[] {
  if (!refiners) return [];
  return refiners.phases.map((view) => phaseLine(view, format));
}

/** The open phase says its run and what its refiner is doing. */
function phaseLine(view: RefinerPhaseView, format: BoardFormat): string {
  if (view.status !== "in_progress") {
    return entryLine(derivedEntry(view.phase, view.status), format);
  }
  return `${checkbox(false, format)} ${view.phase} ← run ${view.run}${SEPARATOR}${openPhaseWord(view)}`;
}

/** What the board says about the refiner that holds a phase open. */
function openPhaseWord(view: Extract<RefinerPhaseView, { status: "in_progress" }>): string {
  if (view.ruling === "awaited") return "waiting for your ruling";
  if (view.ruling === "rejected") return "rejected, now with the author";
  if (view.refiner_status !== "done") return lifecycleLabel(view.refiner_status);
  return view.phase === "review" ? "left findings, now with the author" : "handing the artifact on";
}

/** The one line for the artifact's handover to the humans. Render owns it, not the refiner list. */
function humansLine(refiners: BoardInput["refiners"], format: BoardFormat): string[] {
  if (!refiners) return [];
  return [entryLine(derivedEntry(READY_FOR_HUMANS, refiners.humans), format)];
}

function derivedEntry(content: string, status: PlanEntry["status"]): PlanEntry {
  return { content, priority: "medium", status };
}

function entryLine(entry: PlanEntry, format: BoardFormat): string {
  const suffix = entry.status === "in_progress" ? WORKING_SUFFIX : "";
  return `${checkbox(entry.status === "completed", format)} ${boardText(entry.content)}${suffix}`;
}

function checkbox(completed: boolean, format: BoardFormat): string {
  switch (format) {
    case "markdown":
      return completed ? "- [x]" : "- [ ]";
    case "chat":
      return completed ? "☑" : "☐";
    default:
      return unhandledFormat(format);
  }
}

function bold(text: string, format: BoardFormat): string {
  switch (format) {
    case "markdown":
      return `**${text}**`;
    case "chat":
      return `*${text}*`;
    default:
      return unhandledFormat(format);
  }
}

function unhandledFormat(format: never): never {
  throw new Error(`unhandled board format ${JSON.stringify(format)}`);
}

/** What a board message says once the board moved on and the message could not be deleted. */
export function boardMovedText(permalink: string): string {
  return `This board moved to the [end of the thread](${permalink}).`;
}

/** One line of board text: links removed, whitespace collapsed, cut to length. */
export function boardText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "(link removed)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function clock(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
