import { describe, expect, it } from "bun:test";
import { fetchHeader, fetchUrl } from "../../test/fetch";
import { HttpWeb } from "./http";

type Call = { url: string; init?: RequestInit };

function answering(response: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: fetchUrl(input), init });
    return response();
  };
  return { fetch: fake, calls };
}

describe("HttpWeb", () => {
  describe("readPage", () => {
    it("reads the body and its content type", async () => {
      const { fetch } = answering(
        () => new Response("# Hi", { headers: { "content-type": "text/markdown" } }),
      );
      expect(await new HttpWeb({ fetch }).readPage("https://a.example/")).toEqual({
        contentType: "text/markdown",
        body: "# Hi",
        truncated: false,
      });
    });

    it("asks for markdown, text, and HTML", async () => {
      const { fetch, calls } = answering(() => new Response("hi"));
      await new HttpWeb({ fetch }).readPage("https://a.example/");
      expect(fetchHeader(calls[0]?.init, "accept")).toStartWith(
        "text/markdown, text/plain, text/html",
      );
    });

    it("cuts a large body at the byte bound", async () => {
      const { fetch } = answering(() => new Response("x".repeat(600 * 1024)));
      const page = await new HttpWeb({ fetch }).readPage("https://a.example/");
      expect(page.truncated).toBe(true);
      expect(page.body.length).toBe(512 * 1024);
    });

    it("passes the turn's abort to the request", async () => {
      const { fetch, calls } = answering(() => new Response("hi"));
      const turn = new AbortController();
      await new HttpWeb({ fetch }).readPage("https://a.example/", turn.signal);
      turn.abort();
      expect(calls[0]?.init?.signal?.aborted).toBe(true);
    });

    it("throws on a failed status", async () => {
      const { fetch } = answering(() => new Response("", { status: 404 }));
      await expect(new HttpWeb({ fetch }).readPage("https://a.example/")).rejects.toThrow(
        "https://a.example/ answered 404",
      );
    });
  });
});
