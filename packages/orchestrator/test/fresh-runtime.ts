import { createFakeWorkflow, FakeRuntime } from "./fake-runtime";
import { openMemoryDb } from "./memory-db";
import type { Scenario } from "./scenario";
import { testEnv } from "./test-env";

/**
 * A fresh fake runtime over an in-memory database, as the base scenario of a describe block.
 * Every call opens a new database.
 */
export const freshRuntime: Scenario<FakeRuntime> = async (run) => {
  await run(new FakeRuntime(openMemoryDb(), testEnv()));
};

/** A fresh fake runtime before the plan that starts its workflow: status `new`, without a workflow definition. */
export const unstartedRuntime: Scenario<FakeRuntime> = async (run) => {
  const workflow = new FakeRuntime(openMemoryDb(), testEnv(), "uncreated");
  createFakeWorkflow(workflow);
  await run(workflow);
};
