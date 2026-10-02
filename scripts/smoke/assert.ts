/**
 * Assertion helpers for the smoke log. A pass prints an `ok` line. A failure throws with the
 * actual value so the entry script can print `SMOKE FAILED` and exit non-zero.
 */

/** Short JSON rendering of a value for log and error lines. */
export function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Throws unless `condition` is truthy. `actual` is added to the failure message when given. */
export function assert(condition: unknown, message: string, actual?: unknown): asserts condition {
  if (!condition) {
    const detail = actual === undefined ? "" : ` (actual: ${show(actual)})`;
    throw new Error(`assertion failed: ${message}${detail}`);
  }
  console.log(`  ok  ${message}`);
}

/** Throws unless `actual` equals `expected` by value. The message names both. */
export function assertEqual<T>(actual: T, expected: T, message: string): void {
  const equal = Object.is(actual, expected) || show(actual) === show(expected);
  if (!equal) {
    throw new Error(
      `assertion failed: ${message}: expected ${show(expected)}, actual ${show(actual)}`,
    );
  }
  console.log(`  ok  ${message}: ${show(expected)}`);
}
