#!/usr/bin/env bun
/**
 * Mock Linear API for local smoke tests, behind `LINEAR_API_URL`. It serves the OAuth token
 * endpoint and the GraphQL operations the Linear SDK sends, and records every call.
 * `GET /__state` returns the record. `POST /__reset` clears it and forgets every token.
 */
import { LINEAR_APP_USER, LINEAR_ORG, LINEAR_TEAM, LINEAR_TEAM_STATES } from "./smoke/fixtures";

/** A token grant as recorded. Secrets stay out: only whether they matched. */
type GrantRecord = {
  at: string;
  grant_type: string;
  code: string | null;
  redirect_uri: string | null;
  refresh_token_current: boolean;
  client_ok: boolean;
};

/** A GraphQL call as recorded. `token_index` is the position of the bearer in `tokens`. */
type GqlRecord = {
  at: string;
  operation: string;
  token_index: number;
  token_ok: boolean;
  variables: Record<string, unknown>;
};

/** An issued access token and when it stops being accepted. */
type IssuedToken = { access: string; refresh: string; expires_at_ms: number };

/** The code grant lasts less than the refresh margin, so the first API call must refresh. */
const CODE_GRANT_LIFETIME_S = 60;

/** The refresh grant lasts a day, like Linear's tokens. */
const REFRESH_GRANT_LIFETIME_S = 24 * 60 * 60;

const port = Number(process.env.MOCK_LINEAR_PORT ?? "9898");
const clientId = process.env.MOCK_LINEAR_CLIENT_ID ?? "smoke-linear-client";
const clientSecret = process.env.MOCK_LINEAR_CLIENT_SECRET ?? "smoke-linear-secret";

const state = {
  grants: [] as GrantRecord[],
  calls: [] as GqlRecord[],
  tokens: [] as IssuedToken[],
};

function log(line: string): void {
  console.log(`[mock-linear] ${line}`);
}

function now(): string {
  return new Date().toISOString();
}

/** The newest token pair. The refresh grant accepts only its refresh token. */
function currentToken(): IssuedToken | null {
  return state.tokens.at(-1) ?? null;
}

function oauthError(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400 });
}

/** Issues a new token pair and answers like Linear's token endpoint. */
function issueTokens(lifetimeSeconds: number): Response {
  const index = state.tokens.length + 1;
  const token: IssuedToken = {
    access: `lin_oauth_smoke_${index}`,
    refresh: `lin_refresh_smoke_${index}`,
    expires_at_ms: Date.now() + lifetimeSeconds * 1000,
  };
  state.tokens.push(token);
  log(`issued token ${index}, expires in ${lifetimeSeconds}s`);
  return Response.json({
    access_token: token.access,
    refresh_token: token.refresh,
    token_type: "Bearer",
    expires_in: lifetimeSeconds,
    scope: "read,write,app:assignable,app:mentionable",
  });
}

/** `POST /oauth/token`. Records the grant and validates the client and the refresh token. */
async function handleToken(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type") ?? "";
  const clientOk = form.get("client_id") === clientId && form.get("client_secret") === clientSecret;
  const refreshCurrent = form.get("refresh_token") === currentToken()?.refresh;
  state.grants.push({
    at: now(),
    grant_type: grantType,
    code: form.get("code"),
    redirect_uri: form.get("redirect_uri"),
    refresh_token_current: refreshCurrent,
    client_ok: clientOk,
  });
  log(`grant ${grantType} client_ok=${clientOk}`);
  if (!clientOk) return oauthError("invalid_client", "client id or secret is wrong");
  if (grantType === "authorization_code") {
    if (!form.get("code")) return oauthError("invalid_request", "code is missing");
    return issueTokens(CODE_GRANT_LIFETIME_S);
  }
  if (grantType === "refresh_token") {
    if (!refreshCurrent) return oauthError("invalid_grant", "refresh token is not current");
    return issueTokens(REFRESH_GRANT_LIFETIME_S);
  }
  return oauthError("unsupported_grant_type", grantType);
}

/** The first field of the operation, for example `viewer` or `agentActivityCreate`. */
function operationName(query: string): string {
  const match = /(?:query|mutation)\s*\w*\s*(?:\([^)]*\))?\s*\{\s*(\w+)/.exec(query);
  return match?.[1] ?? "unknown";
}

/** A one-page connection. The SDK builds its models from `nodes` and `pageInfo`. */
function connection(nodes: unknown[]): { nodes: unknown[]; pageInfo: Record<string, unknown> } {
  return {
    nodes,
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

/** The user id a `team_members` query filters on, when the call is one. */
function memberFilterId(variables: Record<string, unknown>): string | null {
  const filter = variables.filter as { id?: { eq?: string } } | undefined;
  return filter?.id?.eq ?? null;
}

/** The team as the SDK reads it. One shape answers `team`, `team_states`, and `team_members`. */
function teamAnswer(variables: Record<string, unknown>): unknown {
  const memberId = memberFilterId(variables);
  return {
    team: {
      ...LINEAR_TEAM,
      states: connection(LINEAR_TEAM_STATES),
      members: connection(memberId ? [{ id: memberId, name: "Member" }] : []),
    },
  };
}

/** A document that echoes the id it was asked for, with a content id derived from it. */
function documentAnswer(id: string): Record<string, unknown> {
  return {
    id,
    documentContentId: `${id}-content`,
    url: `https://linear.app/${LINEAR_ORG.urlKey}/document/${id}`,
  };
}

/** The data for one operation, or null when the mock does not know it. */
function answer(operation: string, variables: Record<string, unknown>): unknown {
  switch (operation) {
    case "viewer":
      return { viewer: LINEAR_APP_USER };
    case "organization":
      return { organization: { ...LINEAR_ORG, projectStatuses: [] } };
    case "team":
      return teamAnswer(variables);
    case "users":
      return { users: connection([]) };
    case "document":
      return { document: documentAnswer(String(variables.id)) };
    case "issue":
      return { issue: null };
    case "project":
      return { project: null };
    case "commentCreate":
      return {
        commentCreate: {
          success: true,
          lastSyncId: state.calls.length,
          comment: { id: `comment-${state.calls.length}` },
        },
      };
    case "comment":
      return {
        comment: {
          id: String(variables.id),
          url: `https://linear.app/mock/comment/${String(variables.id)}`,
          reactions: [],
        },
      };
    case "commentUpdate":
    case "commentDelete":
    case "issueUpdate":
    case "agentActivityCreate":
    case "agentSessionUpdate":
      return { [operation]: { success: true, lastSyncId: state.calls.length } };
    default:
      return null;
  }
}

/** `POST /graphql`. Every call needs a bearer that this mock issued and that has not expired. */
async function handleGraphql(request: Request): Promise<Response> {
  const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
  const operation = operationName(body.query);
  const variables = body.variables ?? {};
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const tokenIndex = state.tokens.findIndex((token) => token.access === bearer);
  const tokenOk = tokenIndex >= 0 && state.tokens[tokenIndex]!.expires_at_ms > Date.now();
  state.calls.push({ at: now(), operation, token_index: tokenIndex, token_ok: tokenOk, variables });
  log(`gql ${operation} token=${tokenIndex} ok=${tokenOk}`);
  if (!tokenOk) {
    return Response.json({ errors: [{ message: "authentication required" }] }, { status: 401 });
  }
  const data = answer(operation, variables);
  if (data === null) {
    return Response.json({ errors: [{ message: `mock-linear: unknown operation ${operation}` }] });
  }
  return Response.json({ data });
}

function handleReset(): Response {
  state.grants.length = 0;
  state.calls.length = 0;
  state.tokens.length = 0;
  log("reset");
  return Response.json({ ok: true });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/__state") return Response.json(state);
  if (request.method !== "POST") return new Response("mock linear", { status: 200 });
  switch (url.pathname) {
    case "/__reset":
      return handleReset();
    case "/oauth/token":
      return handleToken(request);
    case "/graphql":
      return handleGraphql(request);
    default:
      return new Response("not found", { status: 404 });
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

Bun.serve({ port, fetch: handleRequest });
log(`listening on http://localhost:${port}`);
