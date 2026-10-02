import type { ToolSet } from "ai";
import { CONDENSE_PROMPT } from "../../prompts/summarization-prompt";
import type { WorkflowRuntime } from "../../workflow/types";
import { runPrompt } from "../model/run-prompt";
import { estimatedTokens } from "../transcript/transcript-size";

/** The first line of a condensed result. It tells the model what it reads and how to get the rest. */
export function condensedMarker(tokens: number): string {
  return `[condensed result] The result was about ${tokens} tokens, so this is a summary of it. Make a more precise query when you need the detail.`;
}

/** What the model reads in place of a result that was too large and could not be condensed. */
export function tooLargeText(tokens: number): string {
  return `[result too large] The result was about ${tokens} tokens and could not be condensed. Make a more precise query that returns less.`;
}

/**
 * The same tools, each with its result held to `orchestrator.context_tokens`. A larger result
 * is condensed inside the call, so the model and the transcript hold the same text.
 */
export function condensingTools(workflow: WorkflowRuntime, tools: ToolSet): ToolSet {
  const wrapped = Object.entries(tools).map(([name, tool]) => {
    const { execute } = tool;
    if (!execute) return [name, tool] as const;
    const bounded: typeof execute = async (input, options) => {
      const result: unknown = await execute(input, options);
      return condensedWhenLarge(workflow, name, result, options.abortSignal);
    };
    return [name, { ...tool, execute: bounded }] as const;
  });
  return Object.fromEntries(wrapped);
}

async function condensedWhenLarge(
  workflow: WorkflowRuntime,
  toolName: string,
  result: unknown,
  abortSignal: AbortSignal | undefined,
): Promise<unknown> {
  const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
  const tokens = estimatedTokens(text);
  if (tokens <= workflow.config().orchestrator.context_tokens) return result;
  const condensed = await runPrompt(workflow, CONDENSE_PROMPT, text, { abortSignal });
  workflow.log(
    null,
    `agent: ${toolName} result of about ${tokens} tokens ${condensed ? "condensed" : "withheld, no summary"}`,
  );
  return condensed ? `${condensedMarker(tokens)}\n${condensed}` : tooLargeText(tokens);
}
