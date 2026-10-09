import {
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import { agentTelemetry, type AgentIdentity } from "../model/agent-identity";
import { isSupersededIsolate, supersededToolError, SupersededIsolateError } from "./superseded";
import { tracedAI } from "../model/traced-ai";
import { callUsage, type CallUsage } from "../model/usage";

/** Retries the AI SDK makes on a failed request, on top of the turn's own second attempt. */
export const MODEL_RETRIES = 1;

/** What one completed step produced. */
export type StepReport = {
  /** The assistant message and the tool results of the step, in transcript order. */
  messages: ModelMessage[];
  toolCalls: Array<{ toolName: string; input: unknown }>;
  /** The tool calls of the step that failed, with the error text the model was given. */
  toolErrors: Array<{ toolName: string; error: string }>;
  /** What the step's model call used and cost. */
  usage: CallUsage;
};

export type GenerateOptions = {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  maxSteps: number;
  /** The workflow's identity, attached to the trace this call emits. */
  identity: AgentIdentity;
  /** Awaited as each step completes. Persist the step's messages here. */
  onStep: (step: StepReport) => void | Promise<void>;
  /** Ends the model call when it fires. The turn deadline. */
  abortSignal?: AbortSignal;
  /** Tools that end the loop. The step that calls one of them and succeeds is the last. */
  stopTools?: string[];
  /** Read before each step: the tools that step offers the model. Unset offers every tool. */
  activeTools?: () => string[];
};

/**
 * Run the model until it stops calling tools, one of `stopTools` succeeds, or it hits `maxSteps`,
 * and return its final text. A superseded isolate ends the loop and throws.
 */
export async function generateSteps(options: GenerateOptions): Promise<string> {
  let superseded: unknown = null;
  const result = await tracedAI.generateText({
    model: options.model,
    system: options.system,
    messages: options.messages,
    tools: options.tools,
    stopWhen: [
      stepCountIs(options.maxSteps),
      ({ steps }) => stopToolSucceeded(steps.at(-1), options.stopTools ?? []),
      () => superseded !== null,
    ],
    maxRetries: MODEL_RETRIES,
    abortSignal: options.abortSignal,
    prepareStep: ({ stepNumber }) => ({
      activeTools: options.activeTools?.(),
      toolChoice: stepNumber === options.maxSteps - 1 ? "none" : undefined,
    }),
    onStepEnd: async (step) => {
      superseded ??= supersededToolError(step.content);
      try {
        await options.onStep({
          messages: step.response.messages,
          toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName, input: call.input })),
          toolErrors: failedTools(step.content),
          usage: callUsage(step.usage),
        });
      } catch (error) {
        if (!isSupersededIsolate(error)) throw error;
        superseded ??= error;
      }
    },
    ...agentTelemetry(options.identity, "turn"),
  });
  if (superseded !== null) throw new SupersededIsolateError(superseded);
  return result.text.trim();
}

/** True when a stop tool of the step ran without failing. A refused or failed call keeps the loop going. */
function stopToolSucceeded(step: StepResult<ToolSet> | undefined, stopTools: string[]): boolean {
  if (!step) return false;
  const failed = new Set(failedTools(step.content).map((error) => error.toolName));
  return step.toolCalls.some(
    (call) => stopTools.includes(call.toolName) && !failed.has(call.toolName),
  );
}

/** The failed tool calls of a step: a thrown error, an unknown tool, or input the schema refused. */
function failedTools(content: StepResult<ToolSet>["content"]): StepReport["toolErrors"] {
  const failed: StepReport["toolErrors"] = [];
  for (const part of content) {
    if (part.type !== "tool-error") continue;
    const text = part.error instanceof Error ? part.error.message : String(part.error);
    failed.push({ toolName: part.toolName, error: text.slice(0, 300) });
  }
  return failed;
}
