import type { OpenRouterCore } from "@openrouter/sdk/core.js";
import { workerdFetch } from "../../workerd-fetch";
import type { DecisionsRequest } from "@openrouter/sdk/models/decisionsrequest.js";
import type { DecisionsResponse } from "@openrouter/sdk/models/decisionsresponse.js";
import type {
  Choice,
  ChoiceQuestion,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
  DecisionsUsage,
  OpenRouterRegion,
  YesNoQuestion,
} from "../types";
import { openRouterOrigin } from "./api-url";

/** TypeSafe's Jev, the one decisions model OpenRouter carries today. */
export const OPENROUTER_DECISIONS_MODEL = "typesafe/jev-1.13";

/** A classifier answers in well under a second. Past this one attempt is dropped. */
const TIMEOUT_MS = 3000;

/** Construction options. `serverUrl` and `fetch` are seams for tests. */
export type OpenRouterDecisionsOptions = {
  apiKey: string;
  region?: OpenRouterRegion;
  serverUrl?: string;
  fetch?: typeof fetch;
};

/** `Decisions` over OpenRouter's Decisions endpoint. The SDK loads on the first call. */
export class OpenRouterDecisions implements Decisions {
  readonly model = OPENROUTER_DECISIONS_MODEL;
  private client: Promise<OpenRouterCore> | null = null;

  constructor(private readonly options: OpenRouterDecisionsOptions) {}

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    signal?.throwIfAborted();
    const yesNoNames = Object.keys(questions.yesNo) as YesNoName[];
    const choiceNames = Object.keys(questions.choices) as ChoiceName[];
    const asked = {
      ...Object.fromEntries(yesNoNames.map((name) => [name, noulQuestion(questions.yesNo[name])])),
      ...Object.fromEntries(
        choiceNames.map((name) => [name, choiceQuestion(questions.choices[name])]),
      ),
    };
    const request = this.request(state, asked, signal);
    const { answers, usage } = await (signal ? settledOrAborted(request, signal) : request);
    const probabilities = {} as Record<YesNoName, number>;
    for (const name of yesNoNames) {
      const answer = answers[name];
      if (answer?.type !== "noul") throw new Error(`decisions: no yes-or-no answer for ${name}`);
      probabilities[name] = answer.noul;
    }
    const choices = {} as Record<ChoiceName, Choice>;
    for (const name of choiceNames) {
      const answer = answers[name];
      if (answer?.type !== "choice") throw new Error(`decisions: no choice for ${name}`);
      choices[name] = {
        option: answer.choice,
        probability: answer.probabilities?.[answer.choice] ?? 0,
      };
    }
    return { probabilities, choices, usage: decisionsUsage(usage) };
  }

  private async request(
    state: DecisionState,
    questions: DecisionsRequest["questions"],
    signal: AbortSignal | undefined,
  ): Promise<DecisionsResponse> {
    const { alphaDecisionsCreate } = await import("@openrouter/sdk/funcs/alphaDecisionsCreate.js");
    const result = await alphaDecisionsCreate(
      await this.core(),
      { decisionsRequest: { model: this.model, state, questions } },
      { serverURL: this.options.serverUrl ?? openRouterOrigin(this.options.region), signal },
    );
    if (!result.ok) throw result.error;
    return result.value;
  }

  private core(): Promise<OpenRouterCore> {
    this.client ??= Promise.all([
      import("@openrouter/sdk/core.js"),
      import("@openrouter/sdk/lib/http.js"),
    ]).then(
      ([{ OpenRouterCore: Core }, { HTTPClient }]) =>
        new Core({
          apiKey: this.options.apiKey,
          httpClient: new HTTPClient({
            fetcher: attemptTimeoutFetch(workerdFetch(this.options.fetch), TIMEOUT_MS),
          }),
        }),
    );
    return this.client;
  }
}

/**
 * Each attempt under its own timeout. The SDK drops its own timeout once a call passes a signal,
 * so the timeout lives here, beside the caller's signal on the request.
 */
function attemptTimeoutFetch(inner: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    return inner(request, { signal });
  };
}

/**
 * The request's own outcome, or the abort reason as soon as `signal` aborts. The SDK waits out
 * a retry backoff before it sees the abort.
 */
function settledOrAborted<Result>(request: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function decisionsUsage(usage: DecisionsResponse["usage"]): DecisionsUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: usage.cost ?? 0,
  };
}

function choiceQuestion(question: ChoiceQuestion) {
  return {
    type: "choice" as const,
    instructions: question.instructions,
    criteria: question.options,
  };
}

function noulQuestion(question: YesNoQuestion) {
  return {
    type: "noul" as const,
    instructions: question.instructions,
    criteria: { true: question.yes, false: question.no },
  };
}
