import { WorkflowStore } from "../src/workflow/store/tasks";
import { openMemoryDb } from "./memory-db";
import type { Scenario } from "./scenario";

/** A store over a fresh in-memory database, with the migrations applied. Every call opens a new one. */
export const freshStore: Scenario<WorkflowStore> = async (run) => {
  await run(new WorkflowStore(openMemoryDb()));
};

/** `freshStore` with an open conversation and the running workflow a plan created, for jobs and tasks. */
export const plannedStore: Scenario<WorkflowStore> = (run) =>
  freshStore(async (store) => {
    store.openConversation({
      conversation_id: "wf_store",
      request_title: "Fix the login redirect",
      request_text: "Fix the login redirect.",
      request_links: [],
      origin: null,
    });
    store.createWorkflow({
      workflow_id: "wf_planned",
      definition: "development",
      name: "Login redirect",
      reason: "asked",
      repo: null,
      subject: null,
    });
    await run(store);
  });
