import { jest } from "bun:test";

/** Advances fake timers by `ms`, draining microtasks between firings. `bun:test` has no equivalent. */
export async function advanceTimersAsync(ms: number): Promise<void> {
  await drainMicrotasks();
  for (let elapsed = 0; elapsed < ms;) {
    const step = jest.getTimerCount() === 0 ? ms - elapsed : 1;
    jest.advanceTimersByTime(step);
    elapsed += step;
    await drainMicrotasks();
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let round = 0; round < 8; round++) await Promise.resolve();
}
