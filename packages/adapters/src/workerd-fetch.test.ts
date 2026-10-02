import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { workerdFetch } from "./workerd-fetch";

function strictFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
  if (this !== undefined && this !== globalThis) {
    throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
  }
  if (args[1]?.redirect === "error") {
    throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
  }
  return Promise.resolve(Response.json({ redirect: args[1]?.redirect ?? null }));
}

async function redirecting(): Promise<Response> {
  return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
}

afterEach(() => {
  mock.restore();
});

describe("workerdFetch", () => {
  describe("over a fetch that rejects a foreign this", () => {
    describe("an SDK that calls it as a method", () => {
      const sdk = { fetch: workerdFetch(strictFetch) };

      it("calls the inner fetch bare and asks for the manual redirect mode", async () => {
        const response = await sdk.fetch("https://api.test/", { redirect: "error" });
        expect(await response.json<unknown>()).toEqual({ redirect: "manual" });
      });
    });

    describe("every other redirect mode", () => {
      const wrapped = workerdFetch(strictFetch);

      it("passes the follow mode through", async () => {
        const follow = await wrapped("https://api.test/", { redirect: "follow" });
        expect(await follow.json<unknown>()).toEqual({ redirect: "follow" });
      });

      it("leaves an unset mode unset", async () => {
        const unset = await wrapped("https://api.test/");
        expect(await unset.json<unknown>()).toEqual({ redirect: null });
      });
    });
  });

  describe("over a fetch that answers with a redirect", () => {
    const wrapped = workerdFetch(redirecting);

    it("refuses the redirect when the SDK asked for the error mode", async () => {
      await expect(wrapped("https://api.test/", { redirect: "error" })).rejects.toThrow(
        "fetch refused a 302 redirect to https://elsewhere.test/",
      );
    });

    it("returns the redirect when the SDK asked for the manual mode", async () => {
      expect((await wrapped("https://api.test/", { redirect: "manual" })).status).toBe(302);
    });
  });

  describe("with no inner fetch given", () => {
    it("reads the global fetch at call time", async () => {
      const wrapped = workerdFetch();
      spyOn(globalThis, "fetch").mockImplementation(strictFetch);
      const response = await wrapped("https://api.test/", { redirect: "error" });
      expect(await response.json<unknown>()).toEqual({ redirect: "manual" });
    });
  });
});
