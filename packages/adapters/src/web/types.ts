/**
 * The web capability: plain page reads over HTTP. Consumers program against `Web`. `HttpWeb`
 * implements it.
 */

/** A page as the server sent it, cut at the byte bound when `truncated`. */
export type WebPage = { contentType: string; body: string; truncated: boolean };

/** What the orchestrator agent asks of the web. Each call gives up when `signal` aborts. */
export interface Web {
  /** Reads the body of an HTTP or HTTPS URL as text. */
  readPage(url: string, signal?: AbortSignal): Promise<WebPage>;
}
