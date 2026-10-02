/** The request header a bridge dial carries its token in. */
export const BRIDGE_TOKEN_HEADER = "authorization";

const BEARER = "Bearer ";

/** The headers of a bridge dial that carries `token`. */
export function bridgeTokenHeaders(token: string): Record<string, string> {
  return { [BRIDGE_TOKEN_HEADER]: `${BEARER}${token}` };
}

/** The token a bridge dial carries. Null when the dial carries none. */
export function bridgeTokenOf(headers: Headers): string | null {
  const value = headers.get(BRIDGE_TOKEN_HEADER);
  return value?.startsWith(BEARER) ? value.slice(BEARER.length) : null;
}
