import type { OpenRouterCore } from "@openrouter/sdk/core.js";
import type { RetryConfig } from "@openrouter/sdk/lib/retries.js";
import { workerdFetch } from "../../workerd-fetch";
import type { DecisionsRequest } from "@openrouter/sdk/models/decisionsrequest.js";
import type { DecisionsResponse } from "@openrouter/sdk/models/decisionsresponse.js";
import { askModelsInOrder, decisionsDeadlineMs } from "../models-in-order";
import type {
  Choice,
  ChoiceQuestion,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionsModels,
  DecisionState,
  DecisionsUsage,
  OpenRouterRegion,
  YesNoQuestion,
} from "../types";
import { openRouterOrigin } from "./api-url";

/** The decisions model a deployment on OpenRouter gets when its config names none. */
export const OPENROUTER_DEFAULT_DECISIONS_MODEL = "typesafe/jev-1.13";

/** Milliseconds one attempt may take. A decisions model answers in well under a second. */
const TIMEOUT_MS = 3000;

/** How long one decisions model keeps retrying a server error or a timeout before the next takes over. */
const RETRIES: RetryConfig = {
  strategy: "backoff",
  backoff: { initialInterval: 500, maxInterval: 2000, exponent: 1.5, maxElapsedTime: 6000 },
  retryConnectionErrors: true,
};

/** Construction options. `serverUrl` and `fetch` are seams for tests. */
export type OpenRouterDecisionsOptions = {
  apiKey: string;
  models: DecisionsModels;
  region?: OpenRouterRegion;
  serverUrl?: string;
  fetch?: typeof fetch;
};

/** `Decisions` over OpenRouter's Decisions endpoint. The SDK loads on the first call. */
export class OpenRouterDecisions implements Decisions {
  private client: Promise<OpenRouterCore> | null = null;

  constructor(private readonly options: OpenRouterDecisionsOptions) {}

  get deadlineMs(): number {
    return decisionsDeadlineMs(this.options.models);
  }

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    const yesNoNames = Object.keys(questions.yesNo) as YesNoName[];
    const choiceNames = Object.keys(questions.choices) as ChoiceName[];
    const asked = {
      ...Object.fromEntries(yesNoNames.map((name) => [name, noulQuestion(questions.yesNo[name])])),
      ...Object.fromEntries(
        choiceNames.map((name) => [name, choiceQuestion(questions.choices[name])]),
      ),
    };
    return askModelsInOrder(this.options.models, signal, async (model, modelSignal) => {
      const response = await this.request({ model, state, questions: asked }, modelSignal);
      return decisionAnswers(response, yesNoNames, choiceNames);
    });
  }

  private async request(
    decisionsRequest: DecisionsRequest,
    signal: AbortSignal,
  ): Promise<DecisionsResponse> {
    const { alphaDecisionsCreate } = await import("@openrouter/sdk/funcs/alphaDecisionsCreate.js");
    const result = await alphaDecisionsCreate(
      await this.core(),
      { decisionsRequest },
      {
        serverURL: this.options.serverUrl ?? openRouterOrigin(this.options.region),
        signal,
        retries: RETRIES,
      },
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

/** A fetch that aborts each attempt after `timeoutMs`, alongside the caller's signal. */
function attemptTimeoutFetch(inner: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    return inner(request, { signal });
  };
}

/** The answers of one response, or a throw when an asked question has none. */
function decisionAnswers<YesNoName extends string, ChoiceName extends string>(
  { answers, model, usage }: DecisionsResponse,
  yesNoNames: YesNoName[],
  choiceNames: ChoiceName[],
): DecisionAnswers<YesNoName, ChoiceName> {
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
  return { probabilities, choices, usage: decisionsUsage(model, usage) };
}

function decisionsUsage(model: string, usage: DecisionsResponse["usage"]): DecisionsUsage {
  return {
    model,
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
