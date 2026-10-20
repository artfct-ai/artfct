import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INGRESS_SECRETS } from "../../test/ingress-secret-invariants";

describe("the ingress secrets", () => {
  it("lists every ingress `.dev.vars` entry as a secret", () => {
    const example = readFileSync(join(import.meta.dirname, "../../.dev.vars.example"), "utf8");
    const names = [...example.matchAll(/^([A-Z_]+)=/gm)].flatMap(([, name]) => name ?? []);
    expect(names.toSorted()).toEqual([...INGRESS_SECRETS].toSorted());
  });
});
