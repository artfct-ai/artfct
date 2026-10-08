import type { ChoiceQuestion, GatewayModel, ListedModel } from "@artfct-ai/adapters/gateway/types";
import { HARNESSES, type Harness, type HarnessModels } from "@artfct-ai/adapters/harness/types";
import type { WorkflowRuntime } from "../../workflow/types";

/**
 * The harness and model a person's message names for the work, resolved to a model the harness
 * runs. It replaces the stage's pair for the author of the job it starts.
 */
export type RequestedRuntime = { harness: Harness; model: string };

/**
 * What a message that names a model comes to: the requested runtime, or the models closest to
 * what it named when none is clearly it.
 */
export type RuntimeRequest =
  | { kind: "resolved"; runtime: RequestedRuntime }
  | { kind: "unresolved"; closest: string[] };

/** The `purpose` a requested runtime records its decisions usage under. */
export const REQUESTED_RUNTIME_PURPOSE = "requested_runtime";

/** The harness that runs any model the gateway carries. */
export const GATEWAY_HARNESS: Harness = "opencode";

/** A model a message may name, and the harness that runs it. */
export type ModelCandidate = ListedModel & { harness: Harness };

/** A saved gateway preset, and the model it runs. */
export type ModelPreset = Extract<GatewayModel, { kind: "preset" }>;

/** Every model and preset a requested runtime resolves against. */
export type ModelSources = { models: ModelCandidate[]; presets: ModelPreset[] };

/** One option of the choice question: a model id and what the decisions model reads about it. */
export type ModelOffer = { id: string; description: string };

/** The most options one choice question offers. The decisions model takes up to 255. */
const MAX_OFFERS = 40;

/** How many close models an unresolved request names. */
const MAX_CLOSEST = 5;

/** The option that says the message names none of the offered models. */
const NO_MODEL = "none";

/** A segment of a model id that is a version, such as `5`, `5.3`, `v4.1`, or `20251001`. */
const VERSION_SEGMENT = /^v?\d+(\.\d+)*$/;

/** The question that picks the named model from the offers. */
const MODEL_INSTRUCTIONS =
  "Which model in this list does `message` refer to? A family name alone, such as opus, glm, or gemini flash, refers to that family's option, and a vendor name alone refers to its newest general model.";

/**
 * Every harness's own models and the gateway's. A gateway model from a vendor a harness runs by
 * its own ids is left to that harness.
 */
export function modelSources(
  own: { harness: Harness; list: HarnessModels | null }[],
  gateway: GatewayModel[] | null,
): ModelSources {
  const ownVendors = new Set(own.flatMap(({ list }) => (list ? [list.vendor] : [])));
  const ownModels = own.flatMap(({ harness, list }) =>
    list ? list.models.map((model) => ({ ...model, harness })) : [],
  );
  const gatewayModels = (gateway ?? []).flatMap((model) =>
    model.kind === "model" && !ownVendors.has(model.vendor)
      ? [{ id: model.id, name: model.name, released: model.released, harness: GATEWAY_HARNESS }]
      : [],
  );
  const presets = (gateway ?? []).flatMap((model) => (model.kind === "preset" ? [model] : []));
  return { models: [...ownModels, ...gatewayModels], presets };
}

/** The id of a model with its version segments left out, so every release of a family shares it. */
export function modelFamily(id: string): string {
  return id
    .split("/")
    .map((part) =>
      part
        .split("-")
        .filter((segment) => !VERSION_SEGMENT.test(segment))
        .join("-"),
    )
    .join("/");
}

/**
 * The models and presets whose names share a word with the message, most shared words first.
 * A message with no version number is offered only the newest release of each family.
 */
export function modelOffers(message: string, sources: ModelSources): ModelOffer[] {
  const said = nameWords(message);
  const versioned = /\d/.test(message);
  const newest = newestOfEachFamily(sources.models);
  const models = sources.models
    .filter((model) => versioned || newest.has(model.id))
    .map((model) => ({
      offer: { id: model.id, description: `${model.name}, released ${model.released}` },
      shared: sharedWords(said, `${model.id} ${model.name}`),
      released: model.released,
    }));
  const presets = sources.presets.map((preset) => ({
    offer: {
      id: preset.id,
      description: `${preset.name}, a saved preset that runs ${preset.model}`,
    },
    shared: sharedWords(said, `${preset.id} ${preset.name} ${preset.model}`),
    released: "",
  }));
  return [...models, ...presets]
    .filter((entry) => entry.shared > 0)
    .toSorted(
      (left, right) => right.shared - left.shared || right.released.localeCompare(left.released),
    )
    .slice(0, MAX_OFFERS)
    .map((entry) => entry.offer);
}

/** The requested runtime for a picked model id. A preset replaces the model it runs. */
export function runtimeForModel(id: string, sources: ModelSources): RequestedRuntime | null {
  const preset = sources.presets.find((candidate) => candidate.model === id || candidate.id === id);
  if (preset) return { harness: GATEWAY_HARNESS, model: preset.id };
  const model = sources.models.find((candidate) => candidate.id === id);
  return model ? { harness: model.harness, model: model.id } : null;
}

/**
 * Resolve the model a person's message names against every harness's models and the gateway's.
 * Never throws. A list or a decision that fails leaves the request unresolved.
 */
export async function requestedRuntime(
  workflow: WorkflowRuntime,
  message: string,
  signal?: AbortSignal,
): Promise<RuntimeRequest> {
  const sources = await loadModelSources(workflow);
  const request = await chooseRequestedRuntime(workflow, { message, sources, signal });
  const outcome =
    request.kind === "resolved"
      ? `${request.runtime.model} on ${request.runtime.harness}`
      : `unresolved, closest ${request.closest.join(", ") || "none"}`;
  workflow.log(null, `requested runtime ${outcome}`);
  return request;
}

/** The message to read, the models it may name, and the abort signal of the turn that reads it. */
export type RuntimeChoice = { message: string; sources: ModelSources; signal?: AbortSignal };

/** Ask the decisions model which offered model the message names. */
export async function chooseRequestedRuntime(
  workflow: WorkflowRuntime,
  { message, sources, signal }: RuntimeChoice,
): Promise<RuntimeRequest> {
  const offers = modelOffers(message, sources);
  const closest = offers.slice(0, MAX_CLOSEST).map((offer) => offer.id);
  const decisions = workflow.decisions();
  if (!decisions || offers.length === 0) return { kind: "unresolved", closest };
  const question: ChoiceQuestion = {
    instructions: MODEL_INSTRUCTIONS,
    options: {
      ...Object.fromEntries(offers.map((offer) => [offer.id, offer.description])),
      [NO_MODEL]:
        "The message refers to no model in this list, or to none of them more than to the others.",
    },
  };
  try {
    const { choices, usage } = await decisions.decide(
      { message },
      { yesNo: {}, choices: { model: question } },
      signal,
    );
    workflow.store.recordModelUsage({
      purpose: REQUESTED_RUNTIME_PURPOSE,
      model: decisions.model,
      ...usage,
    });
    const runtime = runtimeForModel(choices.model.option, sources);
    return runtime ? { kind: "resolved", runtime } : { kind: "unresolved", closest };
  } catch (error) {
    workflow.log(
      null,
      `requested runtime unknown, decisions failed: ${String(error).slice(0, 200)}`,
    );
    return { kind: "unresolved", closest };
  }
}

/** Every harness's own model list and the list of the gateway sandboxes route through. */
async function loadModelSources(workflow: WorkflowRuntime): Promise<ModelSources> {
  const gateway = workflow.gateway(workflow.config().adapters.gateway.provider);
  const [own, listed] = await Promise.all([
    Promise.all(
      HARNESSES.map(async (harness) => ({
        harness,
        list: await listOrNull(workflow, harness, workflow.harness(harness).models()),
      })),
    ),
    gateway ? listOrNull(workflow, "the gateway", gateway.models()) : null,
  ]);
  return modelSources(own, listed);
}

async function listOrNull<List>(
  workflow: WorkflowRuntime,
  source: string,
  listing: Promise<List | null>,
): Promise<List | null> {
  try {
    return await listing;
  } catch (error) {
    workflow.log(null, `model list of ${source} unavailable: ${String(error).slice(0, 200)}`);
    return null;
  }
}

function newestOfEachFamily(models: ModelCandidate[]): Set<string> {
  const newest = new Map<string, ModelCandidate>();
  for (const model of models) {
    const key = `${model.harness} ${modelFamily(model.id)}`;
    const held = newest.get(key);
    if (!held || model.released > held.released) newest.set(key, model);
  }
  return new Set([...newest.values()].map((model) => model.id));
}

function nameWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .flatMap((word) => [word, ...word.split(".")]);
  return new Set(words.filter((word) => word.length > 1 && /[a-z]/.test(word)));
}

function sharedWords(said: Set<string>, name: string): number {
  return [...nameWords(name)].filter((word) => said.has(word)).length;
}
