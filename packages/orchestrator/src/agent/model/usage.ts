import type { LanguageModelUsage } from "ai";

/** What one model call used, as the Workflow DO records it. */
export type CallUsage = { input_tokens: number; output_tokens: number; cost_usd: number };

/** The `purpose` an agent turn records its model calls under. Every other purpose is a prompt name. */
export const TURN_PURPOSE = "orchestrator";

/** The tokens and the cost of one response. A provider that reports no cost costs zero. */
export function callUsage(usage: LanguageModelUsage): CallUsage {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cost_usd: reportedCost(usage.raw),
  };
}

/** The usage of a whole call, summed over its steps. */
export function stepsUsage(steps: Array<{ usage: LanguageModelUsage }>): CallUsage {
  const total: CallUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  for (const step of steps) {
    const used = callUsage(step.usage);
    total.input_tokens += used.input_tokens;
    total.output_tokens += used.output_tokens;
    total.cost_usd += used.cost_usd;
  }
  return total;
}

/** The `cost` field of a raw usage object, when it is a finite number. */
function reportedCost(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const cost = Reflect.get(raw, "cost");
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}
