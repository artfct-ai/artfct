import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { openWorkflowDb } from "../src/workflow/store/db";
import { openFakeConversation, FakeRuntime, type FakeOpening } from "./fake-runtime";
import type { Scenario } from "./scenario";

let opened = 0;

/**
 * `freshRuntime` for a medium test: the fake runtime over a real Workflow DO's storage, with
 * the test Worker's env. Every call opens a new DO.
 */
export const freshDurableRuntime: Scenario<FakeRuntime> = (run) => durableRuntime("running", run);

async function durableRuntime(
  opening: FakeOpening,
  run: (workflow: FakeRuntime) => void | Promise<void>,
): Promise<void> {
  opened += 1;
  const stub = env.Workflow.getByName(`fresh-runtime-${opened}`);
  await runInDurableObject(stub, async (_instance, state) => {
    await run(new FakeRuntime(await openWorkflowDb(state.storage), env, opening));
  });
}

/** `freshDurableRuntime` with an open conversation, before the plan that creates its workflow. */
export const unstartedDurableRuntime: Scenario<FakeRuntime> = (run) =>
  durableRuntime("uncreated", async (workflow) => {
    openFakeConversation(workflow);
    await run(workflow);
  });
