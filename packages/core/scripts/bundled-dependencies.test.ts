import { describe, expect, it } from "bun:test";
import { bundledDependencies, type Manifest } from "./bundled-dependencies";

const WORKSPACE: Manifest[] = [
  { name: "orchestrator", dependencies: { adapters: "workspace:*", zod: "^4.0.0" } },
  { name: "ingress", dependencies: { adapters: "workspace:*", hono: "^4.0.0" } },
  { name: "adapters", dependencies: { zod: "^4.0.0", "@slack/web-api": "^8.0.0" } },
  { name: "bridge", dependencies: { bun: "^1.0.0" } },
];

describe("bundledDependencies", () => {
  it("collects the npm dependencies of every reachable workspace package, sorted", () => {
    expect(bundledDependencies(WORKSPACE, ["orchestrator", "ingress"])).toEqual({
      "@slack/web-api": "^8.0.0",
      hono: "^4.0.0",
      zod: "^4.0.0",
    });
  });

  it("leaves out a workspace package nothing reaches", () => {
    expect(bundledDependencies(WORKSPACE, ["ingress"])).not.toHaveProperty("bun");
  });

  it("refuses two ranges for one dependency", () => {
    const drifted: Manifest[] = [
      ...WORKSPACE.filter((manifest) => manifest.name !== "adapters"),
      { name: "adapters", dependencies: { zod: "^3.0.0" } },
    ];
    expect(() => bundledDependencies(drifted, ["orchestrator"])).toThrow(/zod is/);
  });

  it("refuses a root that is not in the workspace", () => {
    expect(() => bundledDependencies(WORKSPACE, ["missing"])).toThrow(/not a workspace package/);
  });
});
