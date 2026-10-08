import type { BaseCloudflare } from "cloudflare/client";
import { workerdFetch } from "../../workerd-fetch";
import {
  askModelsInOrder,
  DECISIONS_MODEL_BUDGET_MS,
  decisionsDeadlineMs,
} from "../models-in-order";
import {
  OPENROUTER_PREFIX,
  type Choice,
  type ChoiceQuestion,
  type DecisionAnswers,
  type DecisionQuestions,
  type Decisions,
  type DecisionsModels,
  type DecisionState,
  type DecisionsUsage,
  type OpenRouterRegion,
  type YesNoQuestion,
} from "../types";
import { askOpenRouterDecisions } from "./openrouter-decisions";
import type { ClefAnswer, ClefQuestion } from "./types";

/** The prefix that names a Workers AI model, as the gateway's OpenAI-compatible endpoint names it. */
export const WORKERS_AI_PREFIX = "workers-ai/";

/** Milliseconds one attempt may take. A decisions model answers in well under a second. */
const TIMEOUT_MS = 3000;

/** Retries after the first attempt, so one decisions model gets three attempts before the next takes over. */
const MAX_RETRIES = 2;

/**
 * The account, the gateway that logs a Workers AI call, a token with `Workers AI - Read` rights,
 * and the models to try in order. An `openrouter/` model goes to OpenRouter on `openRouterKey`,
 * inside `openRouterRegion` when one is set. `fetch` is a seam for tests.
 */
export type CloudflareDecisionsOptions = {
  accountId: string;
  gatewayId: string;
  token: string;
  models: DecisionsModels;
  openRouterKey?: string;
  openRouterRegion?: OpenRouterRegion;
  fetch?: typeof fetch;
};

/** Where one configured decisions model runs: Workers AI or OpenRouter, by its name there. */
type DecisionsRoute = { kind: "workers_ai"; model: string } | { kind: "openrouter"; model: string };

/** The answers of one model with what it used. */
type ModelAnswers = { answers: Record<string, ClefAnswer>; usage: DecisionsUsage };

type ClefRun = {
  result: {
    answers: Record<string, ClefAnswer>;
    usage: { input_tokens: number; output_tokens: number };
  };
};

/**
 * `Decisions` over the Workers AI run endpoint, logged by the AI Gateway, and over OpenRouter's
 * decisions endpoint for an `openrouter/` model. Workers AI reports no cost. Each SDK loads on
 * its first call.
 */
export class CloudflareDecisions implements Decisions {
  private client: Promise<BaseCloudflare> | null = null;

  constructor(private readonly options: CloudflareDecisionsOptions) {}

  get deadlineMs(): number {
    return decisionsDeadlineMs(this.options.models, DECISIONS_MODEL_BUDGET_MS);
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
    const inOrder = { models: this.options.models, budgetMs: DECISIONS_MODEL_BUDGET_MS, signal };
    return askModelsInOrder(inOrder, async (model, modelSignal) => {
      const input = { state, questions: asked };
      const { answers, usage } = await this.ask(decisionsRoute(model), input, modelSignal);
      return { ...clefAnswers(answers, yesNoNames, choiceNames), usage };
    });
  }

  private async ask(
    route: DecisionsRoute,
    input: { state: DecisionState; questions: Record<string, ClefQuestion> },
    signal: AbortSignal,
  ): Promise<ModelAnswers> {
    switch (route.kind) {
      case "workers_ai":
        return this.run(route.model, input, signal);
      case "openrouter":
        return askOpenRouterDecisions({
          apiKey: this.openRouterKey(route.model),
          region: this.options.openRouterRegion,
          request: { model: route.model, ...input },
          signal,
          fetch: this.options.fetch,
        });
      default: {
        const unreachable: never = route;
        throw new Error(`unhandled decisions route ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private async run(
    model: string,
    input: { state: DecisionState; questions: Record<string, ClefQuestion> },
    signal: AbortSignal,
  ): Promise<ModelAnswers> {
    const cloudflare = await this.cloudflare();
    const { result } = await cloudflare.post<ClefRun>(
      `/accounts/${this.options.accountId}/ai/run/${model}`,
      { body: { model: runSelector(model), ...input }, signal },
    );
    return {
      answers: result.answers,
      usage: {
        model,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cost_usd: 0,
      },
    };
  }

  private openRouterKey(model: string): string {
    const key = this.options.openRouterKey;
    if (!key) {
      throw new Error(`decisions model ${model} runs on OpenRouter and needs an OpenRouter key.`);
    }
    return key;
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
 * Where a configured decisions model runs. Throws for a model on any other provider, so the
 * next model takes the call.
 */
export function decisionsRoute(model: string): DecisionsRoute {
  if (model.startsWith(WORKERS_AI_PREFIX)) {
    return { kind: "workers_ai", model: model.slice(WORKERS_AI_PREFIX.length) };
  }
  if (model.startsWith(OPENROUTER_PREFIX)) {
    return { kind: "openrouter", model: model.slice(OPENROUTER_PREFIX.length) };
  }
  throw new Error(
    `decisions model ${model} is neither a ${WORKERS_AI_PREFIX} nor an ${OPENROUTER_PREFIX} model.`,
  );
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
