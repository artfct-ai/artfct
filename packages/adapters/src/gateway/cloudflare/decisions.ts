import type { BaseCloudflare } from "cloudflare/client";
import { workerdFetch } from "../../workerd-fetch";
import { askModelsInOrder } from "../models-in-order";
import type {
  Choice,
  ChoiceQuestion,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionsModels,
  DecisionState,
  YesNoQuestion,
} from "../types";

/** The decisions model a deployment on Cloudflare gets when its config names none. */
export const CLOUDFLARE_DEFAULT_DECISIONS_MODEL = "@cf/cloudflare/clef";

/** Milliseconds one attempt may take. A decisions model answers in well under a second. */
const TIMEOUT_MS = 3000;

/** Retries after the first attempt, so one decisions model gets three attempts before the next takes over. */
const MAX_RETRIES = 2;

/**
 * The account, the gateway that logs the call, a token with `Workers AI - Read` rights, and the
 * Workers AI models to try in order. `fetch` is a seam for tests.
 */
export type CloudflareDecisionsOptions = {
  accountId: string;
  gatewayId: string;
  token: string;
  models: DecisionsModels;
  fetch?: typeof fetch;
};

type ClefQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> };

type ClefRun = {
  result: {
    answers: Record<string, ClefAnswer>;
    usage: { input_tokens: number; output_tokens: number };
  };
};

/**
 * `Decisions` over the Workers AI run endpoint, logged by the AI Gateway. Workers AI reports no
 * cost. The SDK loads on the first call.
 */
export class CloudflareDecisions implements Decisions {
  private client: Promise<BaseCloudflare> | null = null;

  constructor(private readonly options: CloudflareDecisionsOptions) {}

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
      const result = await this.run(model, { state, questions: asked }, modelSignal);
      return {
        ...clefAnswers(result.answers, yesNoNames, choiceNames),
        usage: {
          model,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cost_usd: 0,
        },
      };
    });
  }

  private async run(
    model: string,
    input: { state: DecisionState; questions: Record<string, ClefQuestion> },
    signal: AbortSignal,
  ): Promise<ClefRun["result"]> {
    const cloudflare = await this.cloudflare();
    const { result } = await cloudflare.post<ClefRun>(
      `/accounts/${this.options.accountId}/ai/run/${model}`,
      { body: { model: runSelector(model), ...input }, signal },
    );
    return result;
  }

  private cloudflare(): Promise<BaseCloudflare> {
    this.client ??= import("cloudflare/client").then(
      ({ BaseCloudflare: Client }) =>
        new Client({
          apiToken: this.options.token,
          defaultHeaders: { "cf-aig-gateway-id": this.options.gatewayId },
          timeout: TIMEOUT_MS,
          maxRetries: MAX_RETRIES,
          fetch: workerdFetch(this.options.fetch),
        }),
    );
    return this.client;
  }
}

/**
 * The `model` field a Clef run takes: the last segment of the model id, such as `clef` for
 * `@cf/cloudflare/clef`.
 */
function runSelector(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

/** The probabilities and picks of one run, or a throw when an asked question has none. */
function clefAnswers<YesNoName extends string, ChoiceName extends string>(
  answers: Record<string, ClefAnswer>,
  yesNoNames: YesNoName[],
  choiceNames: ChoiceName[],
): Omit<DecisionAnswers<YesNoName, ChoiceName>, "usage"> {
  const probabilities = {} as Record<YesNoName, number>;
  for (const name of yesNoNames) {
    const answer = answers[name];
    if (answer?.type !== "noul") throw new Error(`decisions: no yes-or-no answer for ${name}`);
    probabilities[name] = answer.noul;
  }
  const choices = {} as Record<ChoiceName, Choice>;
  for (const name of choiceNames) {
    const answer = answers[name];
    const probability = answer?.type === "choice" ? answer.probabilities[answer.choice] : undefined;
    if (answer?.type !== "choice" || probability === undefined) {
      throw new Error(`decisions: no choice for ${name}`);
    }
    choices[name] = { option: answer.choice, probability };
  }
  return { probabilities, choices };
}

function choiceQuestion(question: ChoiceQuestion): ClefQuestion {
  return { type: "choice", instructions: question.instructions, criteria: question.options };
}

function noulQuestion(question: YesNoQuestion): ClefQuestion {
  return {
    type: "noul",
    instructions: question.instructions,
    criteria: { true: question.yes, false: question.no },
  };
}
