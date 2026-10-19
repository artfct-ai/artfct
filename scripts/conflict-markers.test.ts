import { describe, expect, it } from "bun:test";

describe("tracked files", () => {
  it("hold no merge conflict markers", () => {
    const grep = Bun.spawnSync(["git", "grep", "-nE", "^(<<<<<<<|>>>>>>>)( |$)"], {
      cwd: `${import.meta.dir}/..`,
    });
    expect(grep.stdout.toString()).toBe("");
  });
});
