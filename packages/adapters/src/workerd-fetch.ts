/**
 * Adapt a vendor SDK's fetch calls to workerd: the inner fetch is called bare, and the
 * `error` redirect mode is served by refusing a redirect here.
 */
export function workerdFetch(inner?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const call = inner ?? globalThis.fetch;
    if (init?.redirect !== "error") return call(input, init);
    const response = await call(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      throw new Error(`fetch refused a ${response.status} redirect to ${location}`);
    }
    return response;
  };
}
