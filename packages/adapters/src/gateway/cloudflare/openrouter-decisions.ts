import type { RetryConfig } from "@openrouter/sdk/lib/retries.js";
import type { DecisionsRequest } from "@openrouter/sdk/models/decisionsrequest.js";
import type { DecisionsResponse } from "@openrouter/sdk/models/decisionsresponse.js";
import { workerdFetch } from "../../workerd-fetch";
import type { DecisionState, DecisionsUsage, OpenRouterRegion } from "../types";
import type { ClefAnswer, ClefQuestion } from "./types";

/** Milliseconds one attempt may take. A decisions model answers in well under a second. */
const TIMEOUT_MS = 3000;

/** How long one decisions model keeps retrying a server error or a timeout before the next takes over. */
const RETRIES: RetryConfig = {
  strategy: "backoff",
  backoff: { initialInterval: 500, maxInterval: 2000, exponent: 1.5, maxElapsedTime: 6000 },
  retryConnectionErrors: true,
};

/** One call to OpenRouter's decisions endpoint for one model, named as OpenRouter knows it. */
export type OpenRouterDecisionsCall = {
  apiKey: string;
  region: OpenRouterRegion | undefined;
  request: { model: string; state: DecisionState; questions: Record<string, ClefQuestion> };
  signal: AbortSignal;
  fetch: typeof fetch | undefined;
};

/** Ask one model on OpenRouter's decisions endpoint. The SDK loads on the first call. */
export async function askOpenRouterDecisions({
  apiKey,
  region,
  request,
  signal,
  fetch,
}: OpenRouterDecisionsCall): Promise<{
  answers: Record<string, ClefAnswer>;
  usage: DecisionsUsage;
}> {
  const [{ alphaDecisionsCreate }, { OpenRouterCore }, { HTTPClient }] = await Promise.all([
    import("@openrouter/sdk/funcs/alphaDecisionsCreate.js"),
    import("@openrouter/sdk/core.js"),
    import("@openrouter/sdk/lib/http.js"),
  ]);
  const core = new OpenRouterCore({
    apiKey,
    httpClient: new HTTPClient({ fetcher: attemptTimeoutFetch(workerdFetch(fetch), TIMEOUT_MS) }),
  });
  const decisionsRequest: DecisionsRequest = request;
  const result = await alphaDecisionsCreate(
    core,
    { decisionsRequest },
    { serverURL: openRouterOrigin(region), signal, retries: RETRIES },
  );
  if (!result.ok) throw result.error;
  return {
    answers: clefAnswersOf(result.value.answers),
    usage: openRouterUsage(result.value),
  };
}

/** The OpenRouter host: the global one, or the one that keeps a request inside `region`. */
function openRouterOrigin(region: OpenRouterRegion | undefined): string {
  return region ? `https://${region}.openrouter.ai` : "https://openrouter.ai";
}

/** A fetch that aborts each attempt after `timeoutMs`, alongside the caller's signal. */
function attemptTimeoutFetch(inner: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    return inner(request, { signal });
  };
}

function clefAnswersOf(answers: DecisionsResponse["answers"]): Record<string, ClefAnswer> {
  const read: Record<string, ClefAnswer> = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type === "noul" && "noul" in answer) {
      read[name] = { type: "noul", noul: answer.noul };
    }
    if (answer.type === "choice" && "choice" in answer) {
      read[name] = {
        type: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities ?? {},
      };
    }
  }
  return read;
}

function openRouterUsage({ model, usage }: DecisionsResponse): DecisionsUsage {
  return {
    model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: usage.cost ?? 0,
  };
}
