import { vi } from "vitest";

/**
 * Replace the global fetch with one that validates each call the way workerd does, records it,
 * and answers it with `answer`. Undo it with `vi.unstubAllGlobals()`.
 */
export function stubValidatingFetch(answer: (request: Request) => Response): Request[] {
  const requests: Request[] = [];
  function validatingFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    const request = new Request(...args);
    requests.push(request);
    return Promise.resolve(answer(request));
  }
  vi.stubGlobal("fetch", validatingFetch);
  return requests;
}
