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

function runningWithAJobOnTheIssue(view: RouterView): number[] {
  return Object.entries(view.objects)
    .filter(([, object]) => object.hasIssueJob && !object.ended)
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
    expect(view.bindings.Issue).toBe(view.bindings.SessionB);
  });

  it("binds the second session to the second workflow", () => {
    expect(view.bindings.SessionA).not.toBe(view.bindings.SessionB);
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
    const bound = Object.values(view.bindings);
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

describe("a job start on an issue whose binding points at another running workflow", () => {
  let view: RouterView;

  beforeEach(async () => {
    const session = await replay.arrive("SessionASurface", "Start");
    await replay.landUntil(session, never);
    const thread = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(thread, never);
    const threadJob = await replay.startWork(1, "job_on_issue");
    await replay.landUntil(threadJob, never);
    view = replay.project();
  });

  it("leaves the issue's binding on that workflow", () => {
    expect(view.bindings.Issue).toBe(0);
  });

  it("starts no job on the issue", () => {
    expect(runningWithAJobOnTheIssue(view)).toEqual([]);
  });
});

describe("a job start on an issue whose binding points at a workflow that ended", () => {
  let view: RouterView;

  beforeEach(async () => {
    const session = await replay.arrive("SessionASurface", "Start");
    await replay.landUntil(session, never);
    const end = await replay.startWork(0, "end");
    await replay.landUntil(end, never);
    const thread = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(thread, never);
    const threadJob = await replay.startWork(1, "job_on_issue");
    await replay.landUntil(threadJob, never);
    view = replay.project();
  });

  it("points the issue's binding at the job's workflow", () => {
    expect(view.bindings.Issue).toBe(1);
  });

  it("starts the job", () => {
    expect(runningWithAJobOnTheIssue(view)).toEqual([1]);
  });
});

describe("a job start that read the issue unbound while a session start binds it to a new workflow", () => {
  let view: RouterView;

  beforeEach(async () => {
    const thread = await replay.arrive("ThreadSurface", "Start");
    await replay.landUntil(thread, never);
    const threadJob = await replay.startWork(0, "job_on_issue");
    await replay.landUntil(threadJob, (call) => call.startsWith("ClaimBinding"));
    const session = await replay.arrive("SessionASurface", "Start");
    await replay.landUntil(session, never);
    await replay.landUntil(threadJob, never);
    const sessionJob = await replay.startWork(1, "job_on_issue");
    await replay.landUntil(sessionJob, never);
    view = replay.project();
  });

  it("lets only the workflow the binding points at start a job on the issue", () => {
    expect(runningWithAJobOnTheIssue(view)).toEqual([1]);
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
    expect(view.bindings.Thread).toBe(1);
  });
});
