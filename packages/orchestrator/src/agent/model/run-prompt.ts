import type { JSONValue } from "ai";
import { orchestratorGateway } from "../../config/gateway";
import type { SummarizationPrompt } from "../../prompts/summarization-prompt";
import type { WorkflowRuntime } from "../../workflow/types";
import { agentTelemetry, orchestratorIdentity } from "./agent-identity";
import { runUnderDeadline } from "../turn/deadline";
import { tracedAI } from "./traced-ai";
import { stepsUsage } from "./usage";

/** Milliseconds one summarization call may take on one model. */
export const SUMMARIZATION_TIMEOUT_MS = 60_000;

/** What one run may change about the call: an answer length and the caller's own deadline. */
export type PromptOptions = { maxChars?: number; abortSignal?: AbortSignal };

/**
 * Run one summarization over `text` on `orchestrator.summarization.model`. When that model fails,
 * run once more on the orchestrator's model. Null whenever it could not run, never a throw.
 */
export async function runPrompt(
  workflow: WorkflowRuntime,
  prompt: SummarizationPrompt,
  text: string,
  options: PromptOptions = {},
): Promise<string | null> {
  const { maxChars } = options;
  if (!text.trim() || (maxChars !== undefined && maxChars <= 0)) return null;
  const { orchestrator } = workflow.config();
  const model = summarizationModel(workflow);
  const first = await runOnModel(workflow, prompt, { model, params: {} }, text, options);
  if (first.kind !== "failed" || model === orchestrator.model) {
    return first.kind === "answered" ? first.text : null;
  }
  workflow.log(null, `prompt ${prompt.name} falls back to ${orchestrator.model}`);
  const fallback = { model: orchestrator.model, params: orchestrator.model_params };
  const second = await runOnModel(workflow, prompt, fallback, text, options);
  return second.kind === "answered" ? second.text : null;
}

/** The model every summarization runs on. */
function summarizationModel(workflow: WorkflowRuntime): string {
  const { orchestrator } = workflow.config();
  return orchestrator.summarization.model ?? orchestrator.model;
}

/** The model of one run and the extra request fields it takes. */
type PromptModel = { model: string; params: Record<string, JSONValue> };

/** How one run of a prompt on one model ended. */
type PromptRun = { kind: "answered"; text: string | null } | { kind: "timed_out" | "failed" };

/** One run of a prompt on one model, through the orchestrator's gateway. */
async function runOnModel(
  workflow: WorkflowRuntime,
  prompt: SummarizationPrompt,
  on: PromptModel,
  text: string,
  options: PromptOptions,
): Promise<PromptRun> {
  try {
    const gateway = orchestratorGateway(workflow.config());
    const model = await workflow.model(on.model, on.params, gateway);
    const bounded = await runUnderDeadline(SUMMARIZATION_TIMEOUT_MS, (signal) =>
      tracedAI.generateText({
        model,
        system: systemFor(prompt, options.maxChars),
        prompt: text,
        abortSignal: options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal,
        ...agentTelemetry(
          orchestratorIdentity(workflow.state.workflow_id),
          `prompt:${prompt.name}`,
        ),
      }),
    );
    if (bounded.kind === "timed_out") {
      workflow.log(null, `prompt ${prompt.name} gave up after ${SUMMARIZATION_TIMEOUT_MS} ms`);
      return { kind: "timed_out" };
    }
    const usage = stepsUsage(bounded.result.steps);
    workflow.store.recordModelUsage({ purpose: prompt.name, model: on.model, ...usage });
    return { kind: "answered", text: bounded.result.text.trim() || null };
  } catch (error) {
    workflow.log(null, `prompt ${prompt.name} failed: ${String(error).slice(0, 300)}`);
    return { kind: "failed" };
  }
}

/** The prompt's system text, with the length the caller can take added when it named one. */
function systemFor(prompt: SummarizationPrompt, maxChars?: number): string {
  return maxChars === undefined
    ? prompt.system
    : `${prompt.system} Answer in at most ${maxChars} characters.`;
}
