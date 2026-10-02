import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { openWorkflowDb } from "../src/workflow/store/db";
import { FakeRuntime } from "./fake-runtime";
import type { Scenario } from "./scenario";

let opened = 0;

/**
 * `freshRuntime` for a medium test: the fake runtime over a real Workflow DO's storage, with
 * the test Worker's env. Every call opens a new DO.
 */
export const freshDurableRuntime: Scenario<FakeRuntime> = async (run) => {
  opened += 1;
  const stub = env.Workflow.getByName(`fresh-runtime-${opened}`);
  await runInDurableObject(stub, async (_instance, state) => {
    await run(new FakeRuntime(await openWorkflowDb(state.storage), env));
  });
};
