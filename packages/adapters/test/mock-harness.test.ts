import { describe, expect, it } from "bun:test";
import { MockHarness } from "./mock-harness";

describe("MockHarness", () => {
  const mockAdapter = new MockHarness("opencode");

  it("runs in process with no command", () => {
    expect(mockAdapter.command().command).toEqual([]);
  });

  it("puts the repository url in env and writes no files and runs no commands", () => {
    expect(
      mockAdapter.setup({
        model: "mock",
        effort: "xhigh",
        repoFull: "acme/app",
        gateway: null,
      }),
    ).toEqual({
      env: { ARTFCT_MOCK_REPO_URL: "https://github.com/acme/app" },
      files: [],
      commands: [],
    });
  });

  it("sets no env for a task with no repository", () => {
    expect(
      mockAdapter.setup({
        model: "mock",
        effort: "xhigh",
        repoFull: null,
        gateway: null,
      }),
    ).toEqual({ env: {}, files: [], commands: [] });
  });
});
