/** What a bounded run ended with: its own result, or the deadline. */
export type Bounded<Result> = { kind: "done"; result: Result } | { kind: "timed_out" };

/**
 * Run `work` under an abort signal that fires at the deadline, and return only once the work
 * has stopped. A throw after the deadline fired is the deadline's.
 */
export async function runUnderDeadline<Result>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<Result>,
): Promise<Bounded<Result>> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`deadline of ${timeoutMs} ms passed`)),
    timeoutMs,
  );
  try {
    return { kind: "done", result: await work(controller.signal) };
  } catch (error) {
    if (controller.signal.aborted) return { kind: "timed_out" };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
