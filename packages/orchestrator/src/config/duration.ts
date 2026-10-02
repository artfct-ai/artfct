import { z } from "zod";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/;
const MILLISECONDS_PER_UNIT: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration into milliseconds. A number is seconds.
 * A string takes an optional unit suffix (ms, s, m, h, d) and defaults to seconds.
 * Returns null when the text is not a duration or the result is not positive.
 */
export function parseDuration(value: string | number): number | null {
  const milliseconds = toMilliseconds(value);
  return milliseconds !== null && milliseconds > 0 ? milliseconds : null;
}

function toMilliseconds(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value * 1000 : null;
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match || !match[1]) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = MILLISECONDS_PER_UNIT[unit] ?? 1000;
  return Math.round(amount * multiplier);
}

/** Config field that accepts a positive duration (see `parseDuration`) and yields milliseconds. */
export const Duration = z.union([z.number(), z.string()]).transform((value, context) => {
  const milliseconds = parseDuration(value);
  if (milliseconds === null) {
    context.addIssue({ code: "custom", message: `invalid duration: ${value}` });
    return z.NEVER;
  }
  return milliseconds;
});
