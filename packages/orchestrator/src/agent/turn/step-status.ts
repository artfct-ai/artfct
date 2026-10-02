/** One tool call of a finished step, as the turn reports it. */
export type StepCall = { toolName: string };

/** The chat host cuts a status title past this many characters. */
const MAX_CHARS = 200;

/**
 * The line the humans see while a turn runs: which step ended and what it called, as words.
 * Null for a step that called nothing.
 */
export function stepStatus(step: number, calls: StepCall[]): string | null {
  const names = [...new Set(calls.map((call) => call.toolName.replaceAll("_", " ")))];
  if (!names.length) return null;
  return `Step ${step}: ${names.join(", ")}`.slice(0, MAX_CHARS);
}
