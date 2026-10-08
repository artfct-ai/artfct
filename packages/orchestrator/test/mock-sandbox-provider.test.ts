import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MockSandboxProvider } from "./mock-sandbox-provider";

describe("MockSandboxProvider readFile", () => {
  const provider = new MockSandboxProvider("http://mock-sandbox.test");
  let requests: Array<{ url: string; body: string }>;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    requests = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const body = await request.text();
      requests.push({ url: request.url, body });
      const { path } = JSON.parse(body) as { path: string };
      if (path === "/workspace/research.json") return new Response('{"findings":[]}');
      return new Response(`no file at ${path}`, { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns the text the host serves", async () => {
    expect(
      await provider.readFile({ id: "wf_x.1", size: "small" }, "/workspace/research.json"),
    ).toBe('{"findings":[]}');
  });

  it("posts the sandbox id and the path to the read route", async () => {
    await provider.readFile({ id: "wf_x.1", size: "small" }, "/workspace/research.json");
    expect(requests).toEqual([
      {
        url: "http://mock-sandbox.test/read",
        body: JSON.stringify({ sandbox_id: "wf_x.1", path: "/workspace/research.json" }),
      },
    ]);
  });

  it("fails with an error that names the missing path", async () => {
    await expect(
      provider.readFile({ id: "wf_x.1", size: "small" }, "/workspace/missing.json"),
    ).rejects.toThrow("mock sandbox /read: 404 no file at /workspace/missing.json");
  });
});

describe("MockSandboxProvider bridgeRunning", () => {
  const provider = new MockSandboxProvider("http://mock-sandbox.test");
  let requests: Array<{ url: string; body: string }>;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    requests = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const body = await request.text();
      requests.push({ url: request.url, body });
      const { generation } = JSON.parse(body) as { generation: number };
      return Response.json({ running: generation === 2 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("posts the sandbox id and the generation to the bridge route", async () => {
    await provider.bridgeRunning({ id: "wf_x.1", size: "small" }, 2);
    expect(requests).toEqual([
      {
        url: "http://mock-sandbox.test/bridge",
        body: JSON.stringify({ sandbox_id: "wf_x.1", generation: 2 }),
      },
    ]);
  });

  it("answers what the host answers", async () => {
    expect(await provider.bridgeRunning({ id: "wf_x.1", size: "small" }, 2)).toBe(true);
    expect(await provider.bridgeRunning({ id: "wf_x.1", size: "small" }, 1)).toBe(false);
  });
});
