/** A task's cost as the agent and the board read it. Zero reads as unknown, never as free. */
export function taskCostText(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(2)}` : "unknown";
}
