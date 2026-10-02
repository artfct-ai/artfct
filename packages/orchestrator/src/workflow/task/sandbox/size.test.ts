import { describe, expect, it } from "bun:test";
import { seedTask } from "../../../../test/fake-runtime";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { sandboxRefOf, sandboxSizeOf } from "./size";

describe("sandboxSizeOf", () => {
  it("gives the author the large sandbox", () => {
    expect(sandboxSizeOf("author")).toBe("large");
  });

  it("gives every other role the small sandbox", () => {
    expect(sandboxSizeOf("reviewer")).toBe("small");
    expect(sandboxSizeOf("polisher")).toBe("small");
    expect(sandboxSizeOf("researcher")).toBe("small");
  });
});

describe("sandboxRefOf", () => {
  it("addresses the sandbox of a reviewer run by its task id and its size", () =>
    freshRuntime((workflow) => {
      const run = seedTask(workflow, { task_id: "wf_x.2", role: "reviewer" });
      expect(sandboxRefOf(run)).toEqual({ id: "wf_x.2", size: "small" });
    }));
});
