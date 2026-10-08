import type { DecisionsModels } from "./types";

/**
 * Milliseconds one decisions model may take, retries included, before the next model takes over.
 * It caps a retry delay the provider asks for.
 */
export const DECISIONS_MODEL_BUDGET_MS = 12_000;

/**
 * The most questions one decisions call asks, since every model in order takes the same call.
 * Clef and Clef Flash take at most 64. Jev documents no limit.
 */
export const DECISIONS_MAX_QUESTIONS = 64;

/** Milliseconds one call over `models` may take: the budget of each model in turn. */
export function decisionsDeadlineMs(models: DecisionsModels, budgetMs: number): number {
  return budgetMs * models.length;
}

/** The decisions models a call tries in order, how long each may take, and the caller's signal. */
export type ModelsInOrder = {
  models: DecisionsModels;
  budgetMs: number;
  signal: AbortSignal | undefined;
};

/**
 * Ask each decisions model in order until one answers. A model that fails, or runs past its
 * budget, hands the call to the next. Rejects when every model fails, or with the abort reason as
 * soon as `signal` aborts.
 */
export async function askModelsInOrder<Answer>(
  { models, budgetMs, signal }: ModelsInOrder,
  ask: (model: string, modelSignal: AbortSignal) => Promise<Answer>,
): Promise<Answer> {
  const failures: string[] = [];
  for (const model of models) {
    signal?.throwIfAborted();
    const budget = new AbortController();
    const timer = setTimeout(
      () => budget.abort(new Error(`${model} ran past ${budgetMs} ms`)),
      budgetMs,
    );
    const modelSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
    try {
      return await settledOrAborted(ask(model, modelSignal), modelSignal);
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(`${model} failed: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`every decisions model failed. ${failures.join(". ")}`);
}

/** Settles as the request does, or rejects with the abort reason as soon as `signal` aborts. */
function settledOrAborted<Result>(request: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
