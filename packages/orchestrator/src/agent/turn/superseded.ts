/** What a storage call says once a deploy or a storage error has reset the Durable Object. */
const SUPERSEDED_PATTERN =
  /reset because its code was updated|this script has been upgraded|Durable Object storage caused object to be reset/i;

/** Thrown by the turn when a tool or a callback found the isolate superseded. */
export class SupersededIsolateError extends Error {
  constructor(cause: unknown) {
    super("The Durable Object was reset under this turn. The new instance owns it.", {
      cause,
    });
    this.name = "SupersededIsolateError";
  }
}

/** True when the error, or any error in its cause chain, says the isolate was superseded. */
export function isSupersededIsolate(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof SupersededIsolateError) return true;
    if (SUPERSEDED_PATTERN.test(messageOf(current))) return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** The first error among the step's tool results that means the isolate was superseded. */
export function supersededToolError(parts: Array<{ type: string; error?: unknown }>): unknown {
  const part = parts.find(
    (candidate) => candidate.type === "tool-error" && isSupersededIsolate(candidate.error),
  );
  return part?.error ?? null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}
