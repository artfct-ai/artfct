import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RouterBindingsReplay, type RouterView } from "../../test/router-bindings-replay";

let replay: RouterBindingsReplay;

beforeEach(() => {
  replay = new RouterBindingsReplay();
});

afterEach(async () => {
  await replay.close();
});

const never = () => false;
const anyButAFind = (call: string) => !call.startsWith("Find");

function isAbandoned(view: RouterView, workflow: number): boolean {
  return view.rows[workflow] === "Ended" && !view.objects[workflow]?.created;
}

function holdersOfTheIssue(view: RouterView): number[] {
  return Object.entries(view.objects)
    .filter(([, object]) => object.holdsIssue && !object.ended)
    .map(([workflow]) => Number(workflow));
}

describe("two starts on two sessions of one issue, where the second read the issue unbound", () => {
  let view: RouterView;

  beforeEach(async () => {
    const first = await replay.arrive("SessionBSurface", "Start");
    const second = await replay.arrive("SessionASurface", "Start");
    await replay.landUntil(second, anyButAFind);
    await replay.landUntil(first, never);
    await replay.landUntil(second, (call) => call.startsWith("CreateWorkflow"));
    view = replay.project();
  });

  it("leaves the issue with the workflow that runs", () => {
    expect(view.bindings.Issue?.workflow).toBe(view.bindings.SessionB?.workflow);
  });

  it("binds the second session to the second workflow", () => {
    expect(view.bindings.SessionA?.workflow).not.toBe(view.bindings.SessionB?.workflow);
  });
});

describe("a message in a chat thread whose workflow has not returned from its create", () => {
  let message: string;

  beforeEach(async () => {
    const start = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(start, (call) => call.startsWith("CreateWorkflow"));
    message = await replay.arrive("ThreadSurface", "PersonsMessage");
    await replay.landUntil(message, never);
  });

  it("is dropped, since the workflow refuses it", () => {
    expect(replay.deliveryOf(message)).toEqual({
      dropped: expect.stringContaining("is not created yet"),
    });
  });
});

describe("a start that joins a workflow whose create then fails", () => {
  let view: RouterView;
  let joiner: string;

  beforeEach(async () => {
    const start = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(start, (call) => call.startsWith("CreateWorkflow"));
    joiner = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(joiner, anyButAFind);
    await replay.failCreate(start);
    await replay.landUntil(start, never);
    await replay.landUntil(joiner, never);
    view = replay.project();
  });

  it("leaves no binding on the abandoned workflow", () => {
    const bound = Object.values(view.bindings).map((holder) => holder.workflow);
    expect(bound.filter((workflow) => isAbandoned(view, workflow))).toEqual([]);
  });

  it("drops the joining start", () => {
    expect(replay.deliveryOf(joiner)).toEqual({
      dropped: expect.stringContaining("is not created yet"),
    });
  });
});

describe("a pull request a workflow records while it ends", () => {
  let view: RouterView;

  beforeEach(async () => {
    const start = await replay.arrive("SessionASurface", "Start");
    await replay.landUntil(start, never);
    const pull = await replay.startWork(0, "pull_request");
    const end = await replay.startWork(0, "end");
    await replay.landUntil(end, never);
    await replay.landUntil(pull, never);
    view = replay.project();
  });

  it("stays unbound once the end removed the code host bindings", () => {
    expect(view.bindings.Pull).toBeUndefined();
  });
});

describe("two workflows that start a job on one issue, where the second claims it while the first waits", () => {
  let view: RouterView;

  beforeEach(async () => {
    const thread = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(thread, never);
    const session = await replay.arrive("SessionASurface", "Start");
    await replay.landUntil(session, never);
    const threadJob = await replay.startWork(0, "job_on_issue");
    await replay.landUntil(
      threadJob,
      (call) => !call.startsWith("FindBinding") && !call.startsWith("HeldInput"),
    );
    const sessionJob = await replay.startWork(1, "job_on_issue");
    await replay.landUntil(sessionJob, never);
    await replay.landUntil(threadJob, never);
    view = replay.project();
  });

  it("lets one running workflow hold the issue", () => {
    expect(holdersOfTheIssue(view)).toEqual([1]);
  });
});

describe("a person's message in a chat thread whose workflow ended in its Durable Object", () => {
  let view: RouterView;
  let message: string;

  beforeEach(async () => {
    const start = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(start, never);
    await replay.startWork(0, "end");
    message = await replay.arrive("ThreadSurface", "PersonsMessage");
    await replay.landUntil(message, never);
    view = replay.project();
  });

  it("starts the next workflow", () => {
    expect(replay.deliveryOf(message)).toMatchObject({ created: true });
  });

  it("binds the thread to it", () => {
    expect(view.bindings.Thread?.workflow).toBe(1);
  });
});
