import { FakeRuntime } from "./fake-runtime";
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
