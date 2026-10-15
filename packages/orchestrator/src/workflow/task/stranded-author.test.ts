import { describe, expect, it } from "bun:test";
import { GatedModel, EchoModel } from "../../../test/fake-model";
import {
  PAGE_PARENT,
  fakeDocumentsOf,
  patchModelExecution,
  seedModelAuthor,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import type { Scenario } from "../../../test/scenario";
import { runStartStep } from "../../../test/restart";
import type { Step } from "../../../test/invariants";
import * as invariants from "../../../test/invariants";
import { WorkflowWorld } from "../../../test/workflow-world";
import {
  agentPromptsAuthor,
  workflowRestartsDuringModelCall,
} from "../../../test/workflow-actions";
import { CLOSING_TEXT_MARKER } from "../../prompts/model-author-prompt";
import { systemPrompt } from "../../agent/prompt/system-prompt";
import type { WorkflowRuntime } from "../types";
import { runModelAuthorTurn } from "./model-author";
import { promptTask } from "./harness/prompt-queue";
import { onModelTurnDeadline, type ModelTurnAlarm } from "./model-turn";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const FIRST_PAGE = "## Goal\nLet people sign in.";
const REVISED_PAGE = "## Goal\nLet people sign in with SSO.";
const FEEDBACK = "Name the identity provider in the goal.";
const LATER_FEEDBACK = "Link the security review.";
const REVISE_ANSWER = `${REVISED_PAGE}\n${CLOSING_TEXT_MARKER}\nDone.`;

type CutTurn = { workflow: FakeRuntime; lostCall: GatedModel; turn: Promise<unknown> };

async function seedPageWithHumans(workflow: FakeRuntime) {
  const documents = patchModelExecution(workflow);
  const author = seedModelAuthor(workflow);
  const page = await documents.createPage("Add SSO (design)", FIRST_PAGE, PAGE_PARENT);
  workflow.store.upsertArtifact({
    job_id: JOB,
    kind: "page",
    external_url: page.url,
    ref: { kind: "page", page_id: page.id },
  });
  workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
  workflow.store.updateTask(author.task_id, { status: "in_review" });
  return workflow.store.requireTask(author.task_id);
}

function revisingWith(restarts: number): Scenario<CutTurn> {
  return (run) =>
    freshRuntime(async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.store.updateTask(author.task_id, { restarts });
      const lostCall = new GatedModel(new EchoModel(REVISE_ANSWER));
      workflow.modelInstance = lostCall;
      const turn = promptTask(workflow, workflow.store.requireTask(TASK), FEEDBACK);
      await lostCall.waiting;
      await run({ workflow, lostCall, turn });
    });
}

const producing: Scenario<CutTurn> = (run) =>
  freshRuntime(async (workflow) => {
    patchModelExecution(workflow);
    const author = seedModelAuthor(workflow);
    const lostCall = new GatedModel(new EchoModel(FIRST_PAGE));
    workflow.modelInstance = lostCall;
    const turn = runModelAuthorTurn(workflow, author);
    await lostCall.waiting;
    await run({ workflow, lostCall, turn });
  });

function restartedDuring(cut: Scenario<CutTurn>): Scenario<FakeRuntime> {
  return (run) =>
    cut(async ({ workflow }) => {
      const restarted = workflow.restarted();
      restarted.modelInstance = new EchoModel(REVISE_ANSWER);
      await runStartStep(restarted);
      await run(restarted);
    });
}

function jobLineOf(workflow: FakeRuntime): string | undefined {
  const prompt = systemPrompt(workflow, {
    personWrote: false,
    requestsWork: true,
    inputArtifact: null,
    heldComments: new Map(),
  });
  return prompt.split("\n").find((line) => line.startsWith(`- job ${JOB}`));
}

function pageTextOf(workflow: FakeRuntime): string | undefined {
  const ref = workflow.store.artifact(JOB)?.ref;
  return ref?.kind === "page" ? fakeDocumentsOf(workflow).pageText(ref.page_id) : undefined;
}

describe("a revise whose model call is out", () => {
  const revising = revisingWith(0);

  it("keeps its prompt queued and holds its model turn", () =>
    revising(({ workflow }) => {
      expect(workflow.store.queue().map((row) => row.text)).toEqual([FEEDBACK]);
      expect(workflow.store.requireTask(TASK).model_turn_id).not.toBeNull();
      expect(jobLineOf(workflow)).toContain("activity=running");
    }));

  it("arms the deadline of its model turn", () =>
    revising(({ workflow }) => {
      const turnId = workflow.store.requireTask(TASK).model_turn_id;
      expect(workflow.alarmsFor("onModelTurnDeadline").map((alarm) => alarm.payload)).toEqual([
        { task_id: TASK, turn_id: turnId },
      ]);
    }));

  it("takes its prompt off the queue once the page is revised", () =>
    revising(async ({ workflow, lostCall, turn }) => {
      lostCall.release();
      await turn;
      expect(workflow.store.queue()).toEqual([]);
      expect(workflow.store.requireTask(TASK)).toMatchObject({
        status: "in_review",
        model_turn_id: null,
      });
    }));

  it("ignores a deadline alarm of an older turn", () =>
    revising(async ({ workflow }) => {
      const task = workflow.store.requireTask(TASK);
      const stale: ModelTurnAlarm = { task_id: TASK, turn_id: "an-older-turn" };
      await onModelTurnDeadline(workflow, stale);
      expect(workflow.store.requireTask(TASK)).toEqual(task);
      expect(workflow.store.queue().map((row) => row.text)).toEqual([FEEDBACK]);
    }));
});

describe("a restart while the model call of a revise runs", () => {
  const restarted = restartedDuring(revisingWith(0));

  it("revises the page on the prompt the lost turn kept", () =>
    restarted((workflow) => {
      expect(workflow.store.queue()).toEqual([]);
      expect(pageTextOf(workflow)).toBe(REVISED_PAGE);
    }));

  it("counts a restart and puts the author back in review", () =>
    restarted((workflow) => {
      expect(workflow.store.requireTask(TASK)).toMatchObject({
        status: "in_review",
        restarts: 1,
        model_turn_id: null,
      });
    }));

  it("revises the page again on the next prompt", () =>
    restarted(async (workflow) => {
      await promptTask(workflow, workflow.store.requireTask(TASK), LATER_FEEDBACK);
      expect(workflow.store.queue()).toEqual([]);
      expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toHaveLength(2);
    }));
});

describe("a restart while the model call of the first turn runs", () => {
  const restarted = restartedDuring(producing);

  it("queues the author to produce its page again", () =>
    restarted((workflow) => {
      expect(workflow.store.requireTask(TASK)).toMatchObject({
        status: "queued",
        restarts: 1,
        model_turn_id: null,
      });
      expect(workflow.alarmsFor("provision").map((alarm) => alarm.payload)).toEqual([
        { task_id: TASK },
      ]);
    }));

  it("tells the agent the author starts", () =>
    restarted((workflow) => {
      expect(jobLineOf(workflow)).toContain("activity=starting");
    }));
});

describe("a model turn lost with no restarts left", () => {
  const restarted = restartedDuring(revisingWith(2));

  it("fails the task", () =>
    restarted((workflow) => {
      expect(workflow.store.requireTask(TASK).status).toBe("failed");
    }));

  it("tells the person why", () =>
    restarted((workflow) => {
      expect(workflow.posted).toContainEqual({
        type: "failed",
        job_id: JOB,
        reason: "its model turn was lost with no restarts left",
      });
    }));
});

describe("the shrunk sequence of seed 1718026998", () => {
  it("keeps every invariant and revises the page after the restart", async () => {
    const world = await WorkflowWorld.open({
      opening: "job",
      artifact: "page",
      refiners: "none",
      research: false,
      pageAuthor: "model",
      checksOnPush: "passed",
      pageEnding: "acceptance",
      origin: "chat",
      firstInput: "request",
    });
    const every = Object.values(invariants).filter(
      (value): value is (workflow: WorkflowRuntime, step: Step) => void =>
        typeof value === "function",
    );
    const sequence = [
      workflowRestartsDuringModelCall(0, "agent_prompts"),
      agentPromptsAuthor(0, { decisions: "answers", host: "readable", meanwhile: "nothing" }),
    ];
    for (const action of sequence) {
      const step = await world.apply(action);
      for (const invariant of every) invariant(world.workflow, step);
    }
    expect(world.steps[0]?.after.tasks).toContainEqual(
      expect.objectContaining({ task_id: TASK, status: "in_review", queuedPrompts: 0 }),
    );
    expect(fakeDocumentsOf(world.workflow).argsOf("updatePageContent").length).toBeGreaterThan(0);
  });
});
