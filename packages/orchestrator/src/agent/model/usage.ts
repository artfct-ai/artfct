import type { LanguageModelUsage } from "ai";

/** What one model call used, as the Workflow DO records it. The cost is null when the provider reported none. */
export type CallUsage = { input_tokens: number; output_tokens: number; cost_usd: number | null };

/** The `purpose` an agent turn records its model calls under. Every other purpose is a prompt name. */
export const TURN_PURPOSE = "orchestrator";

/** The tokens and the cost of one response. */
export function callUsage(usage: LanguageModelUsage): CallUsage {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cost_usd: reportedCost(usage.raw),
  };
}

/** The usage of a whole call, summed over its steps. */
export function stepsUsage(steps: Array<{ usage: LanguageModelUsage }>): CallUsage {
  const total: CallUsage = { input_tokens: 0, output_tokens: 0, cost_usd: null };
  for (const step of steps) {
    const used = callUsage(step.usage);
    total.input_tokens += used.input_tokens;
    total.output_tokens += used.output_tokens;
    total.cost_usd = addReportedCosts(total.cost_usd, used.cost_usd);
  }
  return total;
}

/** The sum of two costs. Null only when neither was reported. */
export function addReportedCosts(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return first + second;
}

/** The `cost` field of a raw usage object, when it is a finite number. */
function reportedCost(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const cost = Reflect.get(raw, "cost");
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}
