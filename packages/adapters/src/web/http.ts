import { workerdFetch } from "../workerd-fetch";
import type { Web, WebPage } from "./types";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 512 * 1024;
const PAGE_ACCEPT = "text/markdown, text/plain, text/html, application/json;q=0.9, */*;q=0.1";

/** Reads pages over plain HTTP. */
export class HttpWeb implements Web {
  private readonly fetch: typeof fetch;

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.fetch = workerdFetch(options.fetch);
  }

  async readPage(url: string, signal?: AbortSignal): Promise<WebPage> {
    const response = await this.fetch(url, {
      headers: { accept: PAGE_ACCEPT },
      signal: timedSignal(signal),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    return { contentType, ...(await readBoundedText(response)) };
  }
}

function timedSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedText(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  while (bytes < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) return { body: body + decoder.decode(), truncated: false };
    const kept = value.subarray(0, MAX_PAGE_BYTES - bytes);
    bytes += kept.byteLength;
    body += decoder.decode(kept, { stream: true });
  }
  await reader.cancel();
  return { body: body + decoder.decode(), truncated: true };
}
