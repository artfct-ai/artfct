import type { DigestInput, TodoSnapshot, TaskCounters } from "../../board/types";
import { boardWorkWord } from "../../board/render";
import { taskCostText } from "../../cost";

/** The digest never exceeds this many characters. The `last` line gives way first. */
export const DIGEST_MAX_CHARS = 500;

const SEPARATOR = " · ";
const ELLIPSIS = "…";
const LAST_PREFIX = 'last: "';
const LAST_SUFFIX = '"';
const MAX_FAILED_TOOL_NAMES = 5;
const MAX_TODO_STEP_CHARS = 80;
const MAX_NOTE_CHARS = 160;

/**
 * The fixed-shape summary of one task that the orchestrator model reads after a harness turn.
 * Built from stored records only.
 */
export function taskDigest(input: DigestInput): string {
  const head = headLines(input);
  const tail = tailLines(input.task, input.now);
  return [...head, ...lastLines(input.last, lastBudget(input)), ...tail].join("\n");
}

/** Characters left for the `last` text once every other line of the digest is written. */
export function lastBudget(input: DigestInput): number {
  const { task } = input;
  const head = headLines(input).join("\n").length;
  const tail = tailLines(task, input.now).join("\n").length;
  const newlinesAroundLast = 2;
  return (
    DIGEST_MAX_CHARS - head - tail - LAST_PREFIX.length - LAST_SUFFIX.length - newlinesAroundLast
  );
}

function headLines(input: DigestInput): string[] {
  const { task } = input;
  const lifecycle = task.status.replaceAll("_", " ");
  return [
    `[task ${task.task_id}${SEPARATOR}${task.workflow_name}${SEPARATOR}${boardWorkWord(task.work)}${SEPARATOR}${lifecycle}]`,
    `result: ${resultText(input.artifact)}`,
    `todos: ${todoText(input.todos)}`,
    `tools: ${toolsText(input.counters)}`,
    ...noteLines(input.note),
  ];
}

function tailLines(task: DigestInput["task"], now: number): string[] {
  return [`cost: ${taskCostText(task.cost_usd)}${SEPARATOR}${elapsedText(task.started_at, now)}`];
}

function resultText(artifact: DigestInput["artifact"]): string {
  if (!artifact) return "none yet";
  return `${artifact.kind} ${artifact.external_url} status=${artifact.status}`;
}

function todoText(todos: TodoSnapshot | null): string {
  const entries = todos?.entries ?? [];
  if (entries.length === 0) return "none reported by the harness";
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const progress = `${completed}/${entries.length} done`;
  if (completed === entries.length) return `${progress}${SEPARATOR}all done`;
  const current = entries.find((entry) => entry.status === "in_progress");
  if (!current) return progress;
  return `${progress}${SEPARATOR}now "${clipHead(collapse(current.content), MAX_TODO_STEP_CHARS)}"`;
}

function toolsText(counters: TaskCounters): string {
  if (counters.tool_calls === 0) return "none since the last turn";
  const calls = `${counters.tool_calls} since the last turn`;
  if (counters.tool_failures <= 0) return calls;
  const names = uniqueNames(counters.failed_tools).slice(0, MAX_FAILED_TOOL_NAMES);
  const named = names.length > 0 ? ` (${names.join(", ")})` : "";
  return `${calls}, ${counters.tool_failures} failed${named}`;
}

function noteLines(note: string | null): string[] {
  const text = note ? collapse(note) : "";
  return text ? [`note: ${clipHead(text, MAX_NOTE_CHARS)}`] : [];
}

/** The `last` line, or nothing when the turn text is empty or no room is left for it. */
function lastLines(last: string | null, budget: number): string[] {
  const text = last ? collapse(last) : "";
  if (!text || budget <= 0) return [];
  return [`${LAST_PREFIX}${clipTail(text, budget)}${LAST_SUFFIX}`];
}

function elapsedText(startedAt: string, now: number): string {
  const elapsedMs = now - Date.parse(startedAt);
  const minutes = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs / 60_000) : 0;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

/** Newlines and the whitespace around them become one space. */
export function collapse(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** Cut the text to `max` characters, keeping the start and ending in an ellipsis. */
export function clipHead(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
}

/** Cut the text to `max` characters, keeping the end and starting with an ellipsis. */
function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${ELLIPSIS}${text.slice(text.length - Math.max(0, max - ELLIPSIS.length))}`;
}
