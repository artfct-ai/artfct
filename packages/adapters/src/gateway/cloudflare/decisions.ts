import type { BaseCloudflare } from "cloudflare/client";
import { workerdFetch } from "../../workerd-fetch";
import type {
  Choice,
  ChoiceQuestion,
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
  YesNoQuestion,
} from "../types";

const CLEF_SELECTOR = "clef";

/** Cloudflare's Clef on Workers AI, the larger of its two decisions models. */
export const CLOUDFLARE_DECISIONS_MODEL = `@cf/cloudflare/${CLEF_SELECTOR}`;

/** A classifier answers in well under a second. Past this the caller goes on without it. */
const TIMEOUT_MS = 3000;

/**
 * The account, the gateway that logs the call, and a token with `Workers AI - Read` rights.
 * `fetch` is a seam for tests.
 */
export type CloudflareDecisionsOptions = {
  accountId: string;
  gatewayId: string;
  token: string;
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
  readonly model = CLOUDFLARE_DECISIONS_MODEL;
  private client: Promise<BaseCloudflare> | null = null;

  constructor(private readonly options: CloudflareDecisionsOptions) {}

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    const yesNoNames = Object.keys(questions.yesNo) as YesNoName[];
    const choiceNames = Object.keys(questions.choices) as ChoiceName[];
    const { answers, usage } = await this.run(
      state,
      {
        ...Object.fromEntries(
          yesNoNames.map((name) => [name, noulQuestion(questions.yesNo[name])]),
        ),
        ...Object.fromEntries(
          choiceNames.map((name) => [name, choiceQuestion(questions.choices[name])]),
        ),
      },
      signal,
    );
    const probabilities = {} as Record<YesNoName, number>;
    for (const name of yesNoNames) {
      const answer = answers[name];
      if (answer?.type !== "noul") throw new Error(`decisions: no yes-or-no answer for ${name}`);
      probabilities[name] = answer.noul;
    }
    const choices = {} as Record<ChoiceName, Choice>;
    for (const name of choiceNames) {
      const answer = answers[name];
      const probability =
        answer?.type === "choice" ? answer.probabilities[answer.choice] : undefined;
      if (answer?.type !== "choice" || probability === undefined) {
        throw new Error(`decisions: no choice for ${name}`);
      }
      choices[name] = { option: answer.choice, probability };
    }
    return {
      probabilities,
      choices,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: 0,
      },
    };
  }

  private async run(
    state: DecisionState,
    questions: Record<string, ClefQuestion>,
    signal: AbortSignal | undefined,
  ): Promise<ClefRun["result"]> {
    const cloudflare = await this.cloudflare();
    const { result } = await cloudflare.post<ClefRun>(
      `/accounts/${this.options.accountId}/ai/run/${this.model}`,
      { body: { model: CLEF_SELECTOR, state, questions }, signal },
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
          maxRetries: 0,
          fetch: workerdFetch(this.options.fetch),
        }),
    );
    return this.client;
  }
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
