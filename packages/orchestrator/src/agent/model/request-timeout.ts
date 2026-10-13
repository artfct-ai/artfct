import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

/**
 * The model with each generate request dropped after `timeoutMs`, on top of the caller's signal.
 * The timer stops when the request settles, so it does not hold the Durable Object open.
 */
export function withRequestTimeout(model: LanguageModelV4, timeoutMs: number): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ params, model: inner }) => {
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(new DOMException("The model request timed out.", "TimeoutError")),
          timeoutMs,
        );
        const signal = params.abortSignal
          ? AbortSignal.any([params.abortSignal, timeout.signal])
          : timeout.signal;
        try {
          return await inner.doGenerate({ ...params, abortSignal: signal });
        } finally {
          clearTimeout(timer);
        }
      },
    },
  });
}
