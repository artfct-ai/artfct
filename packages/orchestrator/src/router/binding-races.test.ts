import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { conversationIdOf } from "../db/conversations";
import { RouterBindingsReplay, type PlaceName } from "../../test/router-bindings-replay";

let replay: RouterBindingsReplay;

beforeEach(() => {
  replay = new RouterBindingsReplay();
});

afterEach(async () => {
  await replay.close();
});

const never = () => false;

async function openWithAWorkflow(place: PlaceName): Promise<void> {
  const surface = place === "Thread" ? "ThreadSurface" : "SessionSurface";
  await replay.landUntil(await replay.arrive(surface, "Start"), never);
  await replay.landUntil(await replay.plan(place), never);
}

describe("a tracker session event on an issue that a thread's workflow claimed", () => {
  let delivered: string;

  beforeEach(async () => {
    await openWithAWorkflow("Thread");
    await replay.landUntil(await replay.startWork(0, "job_on_issue"), never);
    delivered = await replay.arrive("SessionSurface", "Reply");
    await replay.landUntil(delivered, never);
  });

  it("goes to the thread's conversation", async () => {
    expect(replay.deliveryOf(delivered)).toMatchObject({
      conversation_id: await conversationIdOf({
        source: "chat_thread",
        channel: "C1",
        thread: "1.0",
      }),
    });
  });

  it("does not open the issue's conversation", () => {
    expect(replay.project().opened).toEqual(["Thread"]);
  });
});

describe("a claim on the issue that lands after its workflow ended", () => {
  beforeEach(async () => {
    await openWithAWorkflow("Thread");
    const job = await replay.startWork(0, "job_on_issue");
    await replay.landUntil(job, (call) => call.startsWith("ClaimBinding"));
    await replay.landUntil(await replay.startWork(0, "end"), never);
    await replay.landUntil(job, never);
  });

  it("leaves the issue unbound", () => {
    expect(replay.project().bindings.Issue).toBeUndefined();
  });
});

describe("a reply in a chat thread the router never recorded", () => {
  let delivered: string;

  beforeEach(async () => {
    delivered = await replay.arrive("ThreadSurface", "Reply");
    await replay.landUntil(delivered, never);
  });

  it("is dropped", () => {
    expect(replay.deliveryOf(delivered)).toMatchObject({ dropped: expect.any(String) });
  });

  it("does not record or open a conversation", () => {
    expect(replay.project()).toMatchObject({ recorded: [], opened: [] });
  });
});

describe("a plan's row write that lands after its workflow ended", () => {
  beforeEach(async () => {
    await replay.landUntil(await replay.arrive("ThreadSurface", "Start"), never);
    const plan = await replay.plan("Thread");
    await replay.landUntil(await replay.startWork(0, "end"), never);
    await replay.landUntil(plan, never);
  });

  it("leaves the row ended", () => {
    expect(replay.project().rows[0]).toBe("Ended");
  });
});

describe("an end whose deletes an instance restart cuts off", () => {
  beforeEach(async () => {
    await openWithAWorkflow("Thread");
    await replay.landUntil(await replay.startWork(0, "job_on_issue"), never);
    const end = await replay.startWork(0, "end");
    await replay.landUntil(end, (call) => call.startsWith("DeleteBindings"));
    await replay.restart(end, false);
    for (const caller of Object.keys(replay.project().calls)) {
      await replay.landUntil(caller, never);
    }
  });

  it("deletes the bindings from the new instance", () => {
    expect(replay.project().bindings).toEqual({});
  });

  it("ends the workflow", () => {
    expect(replay.project().workflows[0]?.status).toBe("Done");
  });
});

describe("the next workflow of a conversation whose first one ended", () => {
  beforeEach(async () => {
    await openWithAWorkflow("Thread");
    await replay.landUntil(await replay.startWork(0, "job_on_issue"), never);
    await replay.landUntil(await replay.startWork(0, "end"), never);
    await replay.landUntil(await replay.plan("Thread"), never);
    await replay.landUntil(await replay.startWork(1, "job_on_issue"), never);
  });

  it("takes the issue", () => {
    expect(replay.project().bindings.Issue).toBe(1);
  });

  it("runs a job on the issue", () => {
    expect(replay.project().workflows[1]?.hasIssueJob).toBe(true);
  });
});
