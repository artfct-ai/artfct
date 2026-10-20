/** A task's cost as the agent and the board read it. A cost nobody reported reads as unknown. */
export function taskCostText(cost: number | null): string {
  return cost === null ? "unknown" : `$${cost.toFixed(2)}`;
}
