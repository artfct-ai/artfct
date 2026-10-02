/**
 * Helpers for fetch fakes in adapter tests. A fake reads its inputs through these so no
 * object is stringified by accident.
 */

/** The URL a fetch call was made with, as a string. */
export function fetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The request body as a string. Missing or non-string bodies read as empty. */
export function fetchBody(init?: RequestInit): string {
  return typeof init?.body === "string" ? init.body : "";
}

/** The value of one request header, or null. */
export function fetchHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}
