/** The official `@linear/sdk` client for the Linear tracker. */
import type { LinearClient } from "@linear/sdk";

/** Base URL of the Linear API. */
export const LINEAR_API_URL = "https://api.linear.app";

/** Supplies the current access token. Called on every request. */
export type TokenSource = () => Promise<string>;

/** Construction options for the Linear tracker adapter. `baseUrl` is a seam for tests. */
export type LinearOptions = { baseUrl?: string };

/** The text Linear puts in the error for an id that no longer resolves. */
const GONE_MESSAGE = "Entity not found";

/** The SDK credential for a token. A personal API key (`lin_api_`) goes bare. */
function credential(token: string): { apiKey: string } | { accessToken: string } {
  return token.startsWith("lin_api_") ? { apiKey: token } : { accessToken: token };
}

/**
 * A Linear SDK client built on demand, rebuilt when the token value changes. The SDK module
 * itself is imported on the first call.
 */
export class LinearSdk {
  readonly apiUrl: string;
  private cached: { token: string; client: LinearClient } | null = null;

  constructor(
    private readonly token: string | TokenSource,
    options: LinearOptions = {},
  ) {
    this.apiUrl = `${options.baseUrl ?? LINEAR_API_URL}/graphql`;
  }

  async client(): Promise<LinearClient> {
    const token = typeof this.token === "string" ? this.token : await this.token();
    if (this.cached?.token === token) return this.cached.client;
    const { LinearClient } = await import("@linear/sdk");
    const client = new LinearClient({ ...credential(token), apiUrl: this.apiUrl });
    this.cached = { token, client };
    return client;
  }
}

/** True when Linear says the entity is gone, which is how an unknown id reads. */
export function isGoneError(error: unknown): boolean {
  return errorMessages(error).some((message) => message.includes(GONE_MESSAGE));
}

/** Every message an error carries, including the GraphQL errors a `LinearError` lists. */
function errorMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const nested: unknown[] = "errors" in error && Array.isArray(error.errors) ? error.errors : [];
  return [error.message, ...nested.map(messageOf)];
}

function messageOf(item: unknown): string {
  if (typeof item === "object" && item !== null && "message" in item) return String(item.message);
  return String(item);
}
