import { describe, expect, it } from "bun:test";
import { sqliteD1 } from "../../test/sqlite-d1";
import { createDb, type Database } from "./client";
import { conversationIdOf } from "./conversations";
import { dropWatch, keepWatch, watcherConversations, type Watch } from "./watches";
import { writeWorkflowRow } from "./workflows";

const PULL = { repo: "acme/app", number: 12 };

async function keepRunningWatch(db: Database, watch: Watch): Promise<void> {
  const workflowId = `wf_${watch.definition}_${watch.number}`;
  await writeWorkflowRow(db, { workflow_id: workflowId, conversation_id: "cv", status: "running" });
  await keepWatch(db, watch, workflowId);
}

describe("watches", () => {
  it("lead to the conversation of each definition that watches the pull request", async () => {
    const db = createDb(sqliteD1());
    await keepRunningWatch(db, { ...PULL, definition: "reviews" });
    await keepRunningWatch(db, { ...PULL, definition: "labels" });
    await keepRunningWatch(db, { repo: "acme/app", number: 13, definition: "reviews" });
    const expected = await Promise.all(
      ["reviews", "labels"].map((definition) =>
        conversationIdOf({ source: "pull_request", ...PULL, definition }),
      ),
    );
    expect((await watcherConversations(db, PULL)).toSorted()).toEqual(expected.toSorted());
  });

  it("keep one row when a watch is kept twice", async () => {
    const db = createDb(sqliteD1());
    await keepRunningWatch(db, { ...PULL, definition: "reviews" });
    await keepRunningWatch(db, { ...PULL, definition: "reviews" });
    expect(await watcherConversations(db, PULL)).toHaveLength(1);
  });

  it("are not kept for a workflow whose row finished", async () => {
    const db = createDb(sqliteD1());
    await writeWorkflowRow(db, { workflow_id: "wf_ended", conversation_id: "cv", status: "done" });
    await keepWatch(db, { ...PULL, definition: "reviews" }, "wf_ended");
    expect(await watcherConversations(db, PULL)).toEqual([]);
  });

  it("drop only the watch of the definition that ended", async () => {
    const db = createDb(sqliteD1());
    await keepRunningWatch(db, { ...PULL, definition: "reviews" });
    await keepRunningWatch(db, { ...PULL, definition: "labels" });
    await dropWatch(db, { ...PULL, definition: "reviews" });
    expect(await watcherConversations(db, PULL)).toEqual([
      await conversationIdOf({ source: "pull_request", ...PULL, definition: "labels" }),
    ]);
  });
});
