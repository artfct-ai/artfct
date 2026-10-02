/**
 * Read helpers for the mock Linear API record (`scripts/mock-linear.ts`). Steps assert on
 * the grants the orchestrator asked for and the GraphQL calls it made.
 */
import { MOCK_LINEAR_URL } from "./config";

/** A token grant as the mock Linear API recorded it. */
export type GrantRecord = {
  at: string;
  grant_type: string;
  code: string | null;
  redirect_uri: string | null;
  refresh_token_current: boolean;
  client_ok: boolean;
};

/** A GraphQL call as the mock Linear API recorded it. */
export type GqlRecord = {
  at: string;
  operation: string;
  token_index: number;
  token_ok: boolean;
  variables: Record<string, unknown>;
};

/** Everything the mock Linear API recorded since its last reset. */
export type MockLinearState = {
  grants: GrantRecord[];
  calls: GqlRecord[];
  tokens: Array<{ access: string; refresh: string; expires_at_ms: number }>;
};

/** Returns everything the mock Linear API recorded. */
export async function fetchMockLinearState(): Promise<MockLinearState> {
  const response = await fetch(`${MOCK_LINEAR_URL}/__state`);
  if (!response.ok) throw new Error(`mock linear /__state ${response.status}`);
  return (await response.json()) as MockLinearState;
}

/** Clears the mock Linear API record and forgets every token it issued. */
export async function resetMockLinear(): Promise<void> {
  const response = await fetch(`${MOCK_LINEAR_URL}/__reset`, { method: "POST" });
  if (!response.ok) throw new Error(`mock linear /__reset ${response.status}`);
}

/** The bodies of the activities posted on one agent session, in order. */
export function activityBodies(state: MockLinearState, sessionId: string): string[] {
  return state.calls
    .filter((call) => call.operation === "agentActivityCreate")
    .map((call) => call.variables.input as { agentSessionId: string; content: { body?: string } })
    .filter((input) => input.agentSessionId === sessionId)
    .map((input) => input.content.body ?? "");
}

/** The `issueUpdate` inputs sent for one issue, in order. */
export function issueUpdates(state: MockLinearState, issueId: string): Record<string, unknown>[] {
  return state.calls
    .filter((call) => call.operation === "issueUpdate" && call.variables.id === issueId)
    .map((call) => call.variables.input as Record<string, unknown>);
}
