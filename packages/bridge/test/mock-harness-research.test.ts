import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mockResearchPayload,
  researchPayloadPath,
  writeMockResearchPayload,
} from "./mock-harness-research";

describe("researchPayloadPath", () => {
  it("reads the container path a researcher prompt names", () => {
    const prompt =
      "Read the code.\nWrite the research payload to `/workspace/research-payload.json`.";
    expect(researchPayloadPath(prompt)).toBe("/workspace/research-payload.json");
  });

  it("is null for any other prompt", () => {
    expect(researchPayloadPath("Write the design document.")).toBeNull();
  });
});

describe("mockResearchPayload", () => {
  it("names the stage and one finding with a file and a line", () => {
    expect(JSON.parse(mockResearchPayload("plan"))).toMatchObject({
      stage: "plan",
      findings: [{ file: "src/auth/redirect.ts", line: 42 }],
    });
  });
});

describe("writeMockResearchPayload", () => {
  it("writes the payload at the container path under the sandbox root", async () => {
    const sandboxRoot = await mkdtemp(join(tmpdir(), "mock-research-"));
    await writeMockResearchPayload({
      sandboxRoot,
      path: "/workspace/research-payload.json",
      payload: "{}",
    });
    expect(await readFile(join(sandboxRoot, "workspace/research-payload.json"), "utf8")).toBe("{}");
    await rm(sandboxRoot, { recursive: true });
  });
});
