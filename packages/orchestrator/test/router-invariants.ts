export type ObservedBinding = { key: string; workflowId: string | null; ended: boolean };

/** Messages delivered together on one surface and what the router did with them. */
export type RouteRecord = {
  personWrote: boolean;
  before: ObservedBinding[];
  after: ObservedBinding[];
  created: string[];
};

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * A person's message on a binding whose workflow ended starts exactly one new workflow, and the
 * binding then points at it.
 */
export function messageAfterEndStartsNextWorkflow(record: RouteRecord): void {
  if (!record.personWrote) return;
  const running = record.before.some((binding) => binding.workflowId && !binding.ended);
  const ended = record.before.filter((binding) => binding.ended);
  if (running || ended.length === 0) return;
  if (record.created.length !== 1) {
    violated(
      "messageAfterEndStartsNextWorkflow",
      `${record.created.length} workflows started after ${ended.map((binding) => binding.workflowId).join(", ")} ended`,
    );
  }
  const next = record.created[0];
  for (const binding of ended) {
    const now = record.after.find((after) => after.key === binding.key)?.workflowId ?? null;
    if (now !== next) {
      violated(
        "messageAfterEndStartsNextWorkflow",
        `${binding.key} points at ${String(now)}, not at the next workflow ${String(next)}`,
      );
    }
  }
}

export const ROUTE_INVARIANTS = [messageAfterEndStartsNextWorkflow];
