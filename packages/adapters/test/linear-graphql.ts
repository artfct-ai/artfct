/**
 * A Linear GraphQL fake for the adapters that run on the Linear SDK. It records every request
 * and answers from a table keyed by operation name, so a test asserts on what was sent.
 */
import { spyOn } from "bun:test";
import { fetchBody, fetchHeader, fetchUrl } from "./fetch";

/** One GraphQL request as the fake saw it. */
export type Call = {
  url: string;
  operation: string;
  query: string;
  variables: Record<string, unknown>;
  authorization: string | null;
};

/** A GraphQL `data` object, or `{ errors }` to answer with a GraphQL error response. */
export type Answer = Record<string, unknown>;

/** Answers keyed by the operation name the SDK (or a raw document) declares. */
export type Answers = Record<string, Answer | ((call: Call) => Answer)>;

/** An empty connection page, which the SDK expects on every list answer. */
export const PAGE = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
};

/** The operation name after `query` or `mutation`. */
export function operationName(query: string): string {
  return /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
}

/**
 * Stub `globalThis.fetch` with a Linear API fake. It records every call and answers from the
 * operation table. An answer of `{ errors }` is sent as a GraphQL error response.
 */
export function fakeLinear(answers: Answers): Call[] {
  const calls: Call[] = [];
  const fetchFake = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(fetchBody(init)) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const call: Call = {
      url: fetchUrl(input),
      operation: operationName(body.query),
      query: body.query,
      variables: body.variables ?? {},
      authorization: fetchHeader(init, "authorization"),
    };
    calls.push(call);
    const answer = answers[call.operation];
    if (answer === undefined)
      return Response.json({ errors: [{ message: `unknown ${call.operation}` }] });
    const data = typeof answer === "function" ? answer(call) : answer;
    if ("errors" in data) return Response.json(data);
    return Response.json({ data });
  };
  spyOn(globalThis, "fetch").mockImplementation(fetchFake);
  return calls;
}
