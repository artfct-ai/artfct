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

/** A classifier answers in well under a second. Past this the caller goes on without it. */
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
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    const yesNoNames = Object.keys(questions.yesNo) as YesNoName[];
    const choiceNames = Object.keys(questions.choices) as ChoiceName[];
    const { answers, usage } = await this.request(state, {
      ...Object.fromEntries(yesNoNames.map((name) => [name, noulQuestion(questions.yesNo[name])])),
      ...Object.fromEntries(
        choiceNames.map((name) => [name, choiceQuestion(questions.choices[name])]),
      ),
    });
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
  ): Promise<DecisionsResponse> {
    const { alphaDecisionsCreate } = await import("@openrouter/sdk/funcs/alphaDecisionsCreate.js");
    const result = await alphaDecisionsCreate(
      await this.core(),
      { decisionsRequest: { model: this.model, state, questions } },
      { serverURL: this.options.serverUrl ?? openRouterOrigin(this.options.region) },
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
          timeoutMs: TIMEOUT_MS,
          httpClient: new HTTPClient({ fetcher: workerdFetch(this.options.fetch) }),
        }),
    );
    return this.client;
  }
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
