import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../src/env";

/** Values from `.dev.vars.example`, so a developer's real `.dev.vars` never reaches tests. */
function exampleVars(): Record<string, string> {
  const text = readFileSync(join(import.meta.dirname, "../.dev.vars.example"), "utf8");
  const pairs = text.matchAll(/^([A-Z_]+)=(.*)$/gm);
  return Object.fromEntries(
    [...pairs].map(([, key, value]) => [key, (value ?? "").replace(/^"|"$/g, "")]),
  );
}

/** The string vars every test Worker and every small test runs with. */
export function testVars(): Record<string, string> {
  return {
    ...exampleVars(),
    MOCK_SANDBOX_URL: "http://sandbox.invalid",
  };
}

/** A binding no small test may reach. Any use throws and names the binding. */
function missingBinding(name: string): object {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol" || key === "then" || key === "toJSON") return undefined;
        throw new Error(`small tests have no ${name} binding. Make the test medium.`);
      },
    },
  );
}

/** The Worker environment of a small test: the test Worker's vars, and bindings that throw. */
export function testEnv(): Env {
  return {
    ...testVars(),
    DB: missingBinding("DB") as Env["DB"],
    Workflow: missingBinding("Workflow") as Env["Workflow"],
    Sandbox: missingBinding("Sandbox") as Env["Sandbox"],
    SandboxLarge: missingBinding("SandboxLarge") as Env["SandboxLarge"],
    TEST_MIGRATIONS: [],
  };
}
