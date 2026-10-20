import { describe, expect, it } from "bun:test";
import { Deferred } from "../../test/deferred";
import { SessionRoutingReplay, type SpecPicks } from "../../test/session-routing-replay";

const NO_PICKS: SpecPicks = {
  subject: null,
  issue: null,
  text: null,
  outcome: null,
  id: null,
  ending: null,
  turnEnding: null,
  streamed: null,
  health: null,
  todos: null,
  message: null,
  researchEnding: null,
  reply: null,
};

describe("a verbal cancel of an author whose prompt is in flight", () => {
  it("cancels the author before its feed close returns", async () => {
    const replay = await SessionRoutingReplay.open("trackerOnly");
    await replay.take({ action: "agentStartsJob", picks: { ...NO_PICKS, issue: "SubIssue" } });
    await replay.take({
      action: "trackerOpensSession",
      picks: { ...NO_PICKS, issue: "SubIssue" },
    });
    const { workflow, tracker } = replay.world;
    const author = workflow.store.tasks().find((task) => task.role === "author");
    if (!author) throw new Error("the job has no author");
    const feedCloseOut = new Deferred<void>();
    const feedCloseReturns = new Deferred<void>();
    const postActivity = tracker.activity.bind(tracker);
    tracker.activity = async (...activity) => {
      feedCloseOut.resolve();
      await feedCloseReturns.promise;
      return postActivity(...activity);
    };
    const cancel = replay.take({
      action: "personWritesInSession",
      picks: { ...NO_PICKS, issue: "SubjectIssue", text: "CancelCommand" },
    });
    await feedCloseOut.promise;
    expect(workflow.store.requireTask(author.task_id).status).toBe("cancelled");
    feedCloseReturns.resolve();
    await cancel;
  });
});
