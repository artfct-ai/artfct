/**
 * The model gateway capability: where the orchestrator and the harnesses send model calls.
 * Consumers program against `Gateway`. Cloudflare AI Gateway and OpenRouter implement it. A
 * text model call is a route: URLs and headers. A decisions call has no shared wire format, so
 * the gateway makes it. Spend is counted from the usage every response carries.
 */

/** The model prefix that names an OpenRouter model. Config carries it on every OpenRouter model. */
export const OPENROUTER_PREFIX = "openrouter/";

/** The regions OpenRouter keeps a request inside, from decryption to the model provider. */
export const OPENROUTER_REGIONS = ["eu", "us"] as const;
export type OpenRouterRegion = (typeof OPENROUTER_REGIONS)[number];

/** A JSON value, for request fields a gateway adds to a call. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Metadata attached to every request where the provider can carry it. */
export type GatewayMetadata = { workflow_id: string; task_id?: string; stage?: string };

/** Where a harness looks a model up to price its own usage. */
export type ModelCatalog = { provider: string; model: string };

/**
 * Where one OpenAI-compatible request goes. `headers` is the whole set the request needs.
 * `apiKey` is the one bearer for a client that can send only a key. `fields` ride on the body.
 */
export type CompatRoute = {
  baseUrl: string;
  /** The model name on the wire, which can differ from the configured name. */
  model: string;
  apiKey: string;
  headers: Record<string, string>;
  fields: Record<string, JsonValue>;
  /** Where to price `model`. */
  catalog: ModelCatalog;
};

/** Where Claude Code sends Anthropic API requests. Set as `ANTHROPIC_BASE_URL` in the sandbox. */
export type AnthropicRoute = { baseUrl: string; headers: Record<string, string> };

/** One yes-or-no question, with what counts as yes and what counts as no. */
export type YesNoQuestion = { instructions: string; yes: string; no: string };

/** The state a question reads: named text fields. */
export type DecisionState = Record<string, string>;

/**
 * What one decisions call used, and the decisions model that answered it. A provider that
 * reports no cost costs zero.
 */
export type DecisionsUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

/** The decisions models a deployment names on its gateway, in the order a call tries them. */
export type DecisionsModels = readonly [string, ...string[]];

/** One question answered by one option from a fixed set. `options` maps each option to what it covers. */
export type ChoiceQuestion = { instructions: string; options: Record<string, string> };

/** The option picked for one question, and the probability the model gave it. */
export type Choice = { option: string; probability: number };

/** The questions of one decisions call, by name. A name appears in one map only. */
export type DecisionQuestions<YesNoName extends string, ChoiceName extends string> = {
  yesNo: Record<YesNoName, YesNoQuestion>;
  choices: Record<ChoiceName, ChoiceQuestion>;
};

/** The probability of yes for every yes-or-no question, the pick for every choice question, and what the call used. */
export type DecisionAnswers<YesNoName extends string, ChoiceName extends string> = {
  probabilities: Record<YesNoName, number>;
  choices: Record<ChoiceName, Choice>;
  usage: DecisionsUsage;
};

/** The decisions model on a gateway. It answers narrow judgments with probabilities and generates no text. */
export interface Decisions {
  /** Milliseconds one call may take, every model and retry included. Past it the caller gives up. */
  readonly deadlineMs: number;
  /**
   * Answer every question over the same state in one call. Each decisions model gets its retries,
   * then the next one takes the call. Rejects when every model fails, or with the abort reason as
   * soon as `signal` aborts.
   */
  decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
    signal?: AbortSignal,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>>;
}

/** A model a list names: its id as the config names it, its display name, and its release day. */
export type ListedModel = { id: string; name: string; released: string };

/**
 * A model a gateway carries, or a saved preset that runs one of them. `vendor` is who made the
 * model. A preset's `model` is the id of the model it runs.
 */
export type GatewayModel =
  | ({ kind: "model"; vendor: string } & ListedModel)
  | { kind: "preset"; id: string; name: string; model: string };

/** What the orchestrator asks of a model gateway. */
export interface Gateway {
  /** The route for an OpenAI-compatible request to `model`. Throws when the gateway cannot carry it. */
  compatRoute(model: string, metadata: GatewayMetadata): CompatRoute;
  /** The route for Claude Code, or null when the gateway has no Anthropic endpoint. */
  anthropicRoute(metadata: GatewayMetadata): AnthropicRoute | null;
  /**
   * The decisions model on the gateway, or null when it carries none. `models` names the models
   * to try in order. Unset takes the gateway's default.
   */
  decisions(models?: DecisionsModels): Decisions | null;
  /** Every tool-calling model and preset the gateway carries, or null when it lists none. */
  models(): Promise<GatewayModel[] | null>;
}
