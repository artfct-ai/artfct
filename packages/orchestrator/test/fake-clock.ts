import { vi } from "vitest";

/**
 * Run `work` on a fake clock that jumps to the next timer only once the work waits on nothing
 * else. Returns how far the clock moved before the work ended.
 */
export async function elapsedOnAFakeClock(work: () => Promise<void>): Promise<number> {
  vi.useFakeTimers();
  try {
    const started = Date.now();
    const progress = { settled: false };
    const running = work();
    running.then(
      () => (progress.settled = true),
      () => (progress.settled = true),
    );
    while (!progress.settled) await vi.advanceTimersToNextTimerAsync();
    await running;
    return Date.now() - started;
  } finally {
    vi.useRealTimers();
  }
}
