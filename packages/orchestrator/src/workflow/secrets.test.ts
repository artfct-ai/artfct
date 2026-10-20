import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_SECRETS } from "../env";
import { DEV_VAR_HANDLING } from "../../test/orchestrator-secret-invariants";

describe("the secret allowlist", () => {
  it("names every orchestrator `.dev.vars` entry in the secret allowlist", () => {
    const text = readFileSync(join(import.meta.dirname, "../../.dev.vars.example"), "utf8");
    const names = [...text.matchAll(/^([A-Z_]+)=/gm)].flatMap(([, name]) => name ?? []);
    expect(names.toSorted()).toEqual(Object.keys(DEV_VAR_HANDLING).toSorted());
  });

  it("keeps out of MCP servers exactly the secrets the allowlist calls the Worker's own", () => {
    const workerSecrets = Object.entries(DEV_VAR_HANDLING)
      .filter(([, handling]) => handling.kind === "worker_secret")
      .map(([name]) => name);
    expect(WORKER_SECRETS.map(String).toSorted()).toEqual(workerSecrets.toSorted());
  });
});
