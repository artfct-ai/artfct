import { beforeEach, describe, expect, it } from "bun:test";
import { FakeSandboxProvider } from "./fake-sandbox";

describe("FakeSandboxProvider readFile", () => {
  let sandbox: FakeSandboxProvider;

  beforeEach(() => {
    sandbox = new FakeSandboxProvider();
    sandbox.putFile("wf_x.1", "/workspace/research.json", '{"findings":[]}');
  });

  it("returns file contents previously written to the sandbox", async () => {
    expect(
      await sandbox.readFile({ id: "wf_x.1", size: "small" }, "/workspace/research.json"),
    ).toBe('{"findings":[]}');
  });

  it("records the read", async () => {
    await sandbox.readFile({ id: "wf_x.1", size: "small" }, "/workspace/research.json");
    expect(sandbox.calls).toEqual(["readFile wf_x.1 /workspace/research.json"]);
  });

  it("throws when requested file does not exist", async () => {
    await expect(
      sandbox.readFile({ id: "wf_x.1", size: "small" }, "/workspace/missing.json"),
    ).rejects.toThrow("no file at /workspace/missing.json in sandbox wf_x.1");
  });

  it("throws for a file placed in another sandbox", async () => {
    await expect(
      sandbox.readFile({ id: "wf_x.2", size: "small" }, "/workspace/research.json"),
    ).rejects.toThrow("no file at /workspace/research.json in sandbox wf_x.2");
  });
});
