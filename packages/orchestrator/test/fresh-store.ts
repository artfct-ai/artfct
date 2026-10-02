import { WorkflowStore } from "../src/workflow/store/tasks";
import { openMemoryDb } from "./memory-db";
import type { Scenario } from "./scenario";

/** A store over a fresh in-memory database, with the migrations applied. Every call opens a new one. */
export const freshStore: Scenario<WorkflowStore> = async (run) => {
  await run(new WorkflowStore(openMemoryDb()));
};
