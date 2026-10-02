import { prettifyError, ZodError } from "zod";

/** The text a person reads for an error, with its causes and one line per schema issue. */
export function describeError(error: unknown): string {
  if (error instanceof ZodError) return prettifyError(error);
  if (!(error instanceof Error)) return String(error);
  if (error.cause === undefined) return error.message;
  return `${error.message}\n${describeError(error.cause)}`;
}
