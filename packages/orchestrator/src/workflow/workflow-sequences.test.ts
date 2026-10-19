import { describe, expect, it } from "bun:test";
import { fakeDocumentsOf } from "../../test/fake-runtime";
import {
  agentCancels,
  agentCompletes,
  agentHoldsAuthor,
  agentPromptsAuthor,
  agentRoutes,
  agentStartsTask,
  agentStartsTaskOnArtifact,
  authorRestartsWhile,
  authorTurnEnds,
  firstArtifactAppears,
  modelCallOutlivesItsDeadline,
  personAsksForRevision,
  personEditsPageDuringModelCall,
  personMentionsOnPage,
  personRules,
  personStopsModelCall,
  refinerRunEnds,
  researcherTurnEnds,
  sandboxComesUp,
  taskSandboxComesUp,
  workflowEndsWhile,
  type PageMention,
  type RefinerRunEnd,
} from "../../test/workflow-actions";
import {
  REQUEST_TEXTS,
  WorkflowWorld,
  type Observation,
  type ObservedTask,
  type Step,
  type WorkflowAction,
  type WorldSetup,
} from "../../test/workflow-world";
import { judgeRuled } from "./refiner/stage-refiner";

const draftedArtifact = [firstArtifactAppears(0, "author_text"), authorTurnEnds(0, "same")];
const approvingEnd = refinerRunEnds(0, {
  reviewer: "approved",
  pageCommenting: "takes",
  judge: "approves",
  whileRuled: "nothing",
  polisher: "nothing_pushed",
  stopReason: "end_turn",
  closing: "reports_work",
});

function findingsOnHost(pageCommenting: RefinerRunEnd["pageCommenting"]): WorkflowAction {
  return refinerRunEnds(0, {
    reviewer: "findings",
    pageCommenting,
    judge: "rejects",
    whileRuled: "nothing",
    polisher: "pushed",
    stopReason: "end_turn",
    closing: "reports_work",
  });
}

const revisionMovesBetweenTwoReviewers = [
  ...draftedArtifact,
  findingsOnHost("takes"),
  agentPromptsAuthor(0),
  authorTurnEnds(0, "changed"),
  findingsOnHost("takes"),
  findingsOnHost("takes"),
];

const reviewAskedOnAnUnchangedRevision = [
  ...draftedArtifact,
  findingsOnHost("takes"),
  authorTurnEnds(0, "same"),
  agentRoutes(0, "request_review"),
];

const reviewedWhileTheAuthorWorks = [
  ...draftedArtifact,
  agentPromptsAuthor(0),
  approvingEnd,
  authorTurnEnds(0, "same"),
];

const handedOnAfterAStaleRestartIsCancelled = [
  ...draftedArtifact,
  findingsOnHost("takes"),
  agentPromptsAuthor(0),
  authorTurnEnds(0, "changed"),
  findingsOnHost("takes"),
  agentCancels(0, "refiner_run"),
  agentRoutes(0, "finish_review"),
];

const reviewedPastARuledJudge = [
  ...draftedArtifact,
  findingsOnHost("takes"),
  agentCancels(0, "refiner_run"),
  agentPromptsAuthor(0),
  authorTurnEnds(0, "changed"),
  personRules(0, "reject"),
  authorTurnEnds(0, "changed"),
  agentPromptsAuthor(0),
  approvingEnd,
  authorTurnEnds(0, "same"),
  approvingEnd,
];

const findingsThenJudgeApproves = refinerRunEnds(0, {
  reviewer: "findings",
  pageCommenting: "takes",
  judge: "approves",
  whileRuled: "nothing",
  polisher: "nothing_pushed",
  stopReason: "end_turn",
  closing: "reports_work",
});

const judgeApprovesAfterFindings = [
  ...draftedArtifact,
  findingsThenJudgeApproves,
  findingsThenJudgeApproves,
  authorTurnEnds(0, "changed"),
  agentRoutes(0, "finish_review"),
];

const personRulesWhileTheJudgeIsRuled = [
  ...draftedArtifact,
  refinerRunEnds(0, {
    reviewer: "approved",
    pageCommenting: "takes",
    judge: "approves",
    whileRuled: "reject",
    polisher: "nothing_pushed",
    stopReason: "end_turn",
    closing: "reports_work",
  }),
];

function tasksStartedIn(world: WorkflowWorld, step: Step): string[] {
  const waitedBefore = new Set(
    step.before.tasks
      .filter((task) => task.status === "queued" || task.status === "provisioning")
      .map((task) => task.task_id),
  );
  return world
    .tasksAwaitingSandbox()
    .filter((task) => !waitedBefore.has(task.task_id))
    .map((task) => task.task_id);
}

async function worldAfter([setup, sequence]: [
  WorldSetup,
  WorkflowAction[],
]): Promise<WorkflowWorld> {
  const world = await WorkflowWorld.open(setup);
  for (const action of sequence) {
    const step = await world.apply(action);
    if (setup.sandboxStart !== "at_task_start") continue;
    for (const taskId of tasksStartedIn(world, step)) {
      await world.apply(taskSandboxComesUp(taskId));
    }
  }
  return world;
}

function authorStatuses(world: WorkflowWorld): string[] {
  return world.workflow.store
    .tasks()
    .filter((task) => task.role === "author")
    .map((task) => task.status);
}

function authorIn(observation: Observation): ObservedTask | undefined {
  return observation.tasks.find((task) => task.role === "author");
}

describe("a job that continued its own input", () => {
  it("frees that input for the next job once it finishes, on a pull", async () => {
    const world = await worldAfter([
      {
        opening: "job",
        artifact: "pull",
        refiners: "none",
        research: false,
        pageAuthor: "harness",
        checksOnPush: "passed",
        pageEnding: "acceptance",
        origin: "chat",
        firstInput: "request",
        subject: "none",
        sandboxStart: "on_an_action",
        pageBranch: false,
      },
      [
        firstArtifactAppears(0, "author_text"),
        authorTurnEnds(0, "same"),
        agentCancels(0, "author"),
        agentStartsTaskOnArtifact("pull", "a_finished_author", 0),
        sandboxComesUp("dials_in"),
        firstArtifactAppears(1, "author_text"),
        authorTurnEnds(1, "same"),
        agentCancels(1, "author"),
        agentStartsTaskOnArtifact("pull", "a_finished_author", 1),
      ],
    ]);
    expect(authorStatuses(world)).toEqual(["cancelled", "cancelled", "queued"]);
  });

  it("keeps its issue from a next job once it finishes, since an issue gets one job", async () => {
    const world = await worldAfter([
      {
        opening: "job",
        artifact: "issues",
        refiners: "judge_between_reviewers",
        research: false,
        pageAuthor: "harness",
        checksOnPush: "passed",
        pageEnding: "acceptance",
        origin: "chat",
        firstInput: "origin_issue",
        subject: "none",
        sandboxStart: "on_an_action",
        pageBranch: false,
      },
      [
        firstArtifactAppears(0, "author_text", "the_subject_issue"),
        authorTurnEnds(0, "same"),
        findingsOnHost("drops_inline"),
        findingsOnHost("takes"),
        findingsOnHost("inline_throws"),
        findingsOnHost("down"),
        authorTurnEnds(0, "changed", "finished", "agent_cancels"),
        agentStartsTask("pull", "the_subject_issue", REQUEST_TEXTS[0]),
      ],
    ]);
    expect(world.steps.at(-1)?.start).toEqual({ refused: true });
    expect(authorStatuses(world)).toEqual(["cancelled"]);
  });
});

function pullSetup(refiners: WorldSetup["refiners"]): WorldSetup {
  return {
    opening: "job",
    artifact: "pull",
    refiners,
    research: false,
    pageAuthor: "harness",
    checksOnPush: "passed",
    pageEnding: "acceptance",
    origin: "chat",
    firstInput: "request",
    subject: "none",
    sandboxStart: "on_an_action",
    pageBranch: false,
  };
}

function entriesRun(world: WorkflowWorld): Array<number | null> {
  return world.workflow.store
    .refinerRunsOf(world.jobOf(world.authorAt(0)!).job_id)
    .map((run) => run.refiner_index);
}

describe("reviewers on a revision they reviewed", () => {
  it("refuses request_review after the author answered without a change", async () => {
    const world = await worldAfter([pullSetup("reviewer"), reviewAskedOnAnUnchangedRevision]);
    expect(entriesRun(world)).toEqual([0]);
  });

  it("passes over a reviewer that read the revision a stale segment moved to", async () => {
    const world = await worldAfter([pullSetup("two_reviewers"), revisionMovesBetweenTwoReviewers]);
    expect(entriesRun(world)).toEqual([0, 1, 0]);
    const observed = world.steps.at(-1)!.after.tasks.find((task) => task.role === "author")!;
    expect(observed.promptTexts.at(-1)).toContain("Second read");
  });

  it("passes over a reviewer that approved the revision while the author worked", async () => {
    const world = await worldAfter([
      pullSetup("reviewer_then_polisher"),
      reviewedWhileTheAuthorWorks,
    ]);
    expect(entriesRun(world)).toEqual([0, 1]);
  });

  it("hands on past a reviewer that read the revision when a restart is cancelled", async () => {
    const world = await worldAfter([
      pullSetup("two_reviewers"),
      handedOnAfterAStaleRestartIsCancelled,
    ]);
    expect(entriesRun(world)).toEqual([0, 1, 0]);
  });

  it("passes over a ruled judge and a reviewer that read the revision", async () => {
    const world = await worldAfter([pullSetup("judge_between_reviewers"), reviewedPastARuledJudge]);
    expect(entriesRun(world)).toEqual([0, 1, 2, 0]);
  });

  it("sends the findings before a judge to the author when the judge approves", async () => {
    const world = await worldAfter([
      pullSetup("judge_between_reviewers"),
      judgeApprovesAfterFindings,
    ]);
    expect(entriesRun(world)).toEqual([0, 1, 2]);
    const observed = world.steps.at(-1)!.after.tasks.find((task) => task.role === "author")!;
    expect(observed.promptsQueued.some((text) => text.includes("Name the owner."))).toBe(true);
  });

  it("has the judge's ruling and drops a later one", async () => {
    const world = await worldAfter([
      pullSetup("judge_then_polisher"),
      personRulesWhileTheJudgeIsRuled,
    ]);
    const rulings = world.workflow.store
      .refinerRunsOf(world.jobOf(world.authorAt(0)!).job_id)
      .flatMap((run) => (judgeRuled(run.ruling) ? [run.ruling.status] : []));
    expect(rulings).toEqual(["rejected"]);
  });
});

const pageSetup: WorldSetup = { ...pullSetup("none"), artifact: "page" };

describe("the shortest traces of the workflow lifecycle spec", () => {
  it("keeps an author cancelled while its restart destroys the old container", async () => {
    const world = await worldAfter([pageSetup, [authorRestartsWhile(0, "agent_cancels")]]);
    expect(authorStatuses(world)).toEqual(["cancelled"]);
  });

  it("keeps an author done when it completes while its restart destroys the old container", async () => {
    const world = await worldAfter([
      pageSetup,
      [...draftedArtifact, authorRestartsWhile(0, "agent_completes")],
    ]);
    expect(authorStatuses(world)).toEqual(["done"]);
  });

  it("keeps one live job on an input when it starts again during a restart", async () => {
    const world = await worldAfter([
      pageSetup,
      [authorRestartsWhile(0, "agent_cancels_and_starts_again")],
    ]);
    expect(authorStatuses(world)).toEqual(["cancelled", "queued"]);
  });

  it("keeps an author cancelled while the acceptance check is out", async () => {
    const world = await worldAfter([
      pageSetup,
      [...draftedArtifact, agentCompletes(0, "accepts", "answers", "agent_cancels")],
    ]);
    expect(authorStatuses(world)).toEqual(["cancelled"]);
  });

  it("refuses a job start while the workflow fails", async () => {
    const world = await worldAfter([pageSetup, [workflowEndsWhile("agent_fails", "agent_starts")]]);
    expect(world.steps.at(-1)?.start).toEqual({ refused: true });
    expect(world.workflow.state.status).toBe("failed");
    expect(authorStatuses(world)).toEqual(["cancelled"]);
  });

  it("refuses finish_workflow while the workflow fails", async () => {
    const world = await worldAfter([
      pageSetup,
      [workflowEndsWhile("agent_fails", "agent_finishes")],
    ]);
    expect(world.workflow.state.status).toBe("failed");
    expect(authorStatuses(world)).toEqual(["cancelled"]);
  });

  it("holds the first prompt of an author paused before its sandbox came up", async () => {
    const world = await worldAfter([
      { ...pageSetup, research: true },
      [
        researcherTurnEnds(0, "written"),
        agentHoldsAuthor(0, "pause_task"),
        sandboxComesUp("dials_in"),
        agentHoldsAuthor(0, "resume_task"),
      ],
    ]);
    const [, , cameUp, resumed] = world.steps.map((step) => authorIn(step.after));
    expect(cameUp).toMatchObject({ paused: true, promptsSent: 0, queuedPrompts: 1 });
    expect(resumed).toMatchObject({ paused: false, promptsSent: 1 });
  });

  it("sends no prompt to an author paused while its restart destroys the old container", async () => {
    const world = await worldAfter([
      pageSetup,
      [authorRestartsWhile(0, "agent_pauses"), sandboxComesUp("dials_in")],
    ]);
    expect(authorIn(world.steps[0]!.before)).toMatchObject({ promptsSent: 1 });
    expect(authorIn(world.steps.at(-1)!.after)).toMatchObject({ paused: true, promptsSent: 1 });
  });
});

const judgedPageSetup: WorldSetup = { ...pageSetup, refiners: "judge" };

const modelPageSetup: WorldSetup = { ...pageSetup, pageAuthor: "model" };

function mentionOnThePage(mention: Partial<PageMention>): WorkflowAction {
  return personMentionsOnPage(0, {
    routing: "for_author",
    host: "readable",
    meanwhile: "nothing",
    ...mention,
  });
}

function judgeRejects(pageCommenting: RefinerRunEnd["pageCommenting"]): WorkflowAction {
  return refinerRunEnds(0, {
    reviewer: "approved",
    pageCommenting,
    judge: "rejects",
    whileRuled: "nothing",
    polisher: "nothing_pushed",
    stopReason: "end_turn",
    closing: "reports_work",
  });
}

describe("the shortest traces of the review loop spec", () => {
  it("keeps a reply held that a person left while the screen read its comment thread", async () => {
    const world = await worldAfter([
      pageSetup,
      [...draftedArtifact, mentionOnThePage({ meanwhile: "person_replies" })],
    ]);
    expect(world.pageHost.heldNow().map((comment) => comment.author_name)).toEqual(["Cy"]);
  });

  it("starts a revise turn over when a person edits the page during the model call", async () => {
    const world = await worldAfter([
      modelPageSetup,
      [
        personEditsPageDuringModelCall(0, "agent_prompts"),
        personEditsPageDuringModelCall(0, "agent_prompts"),
      ],
    ]);
    expect(world.taskOf(world.authorAt(0)!).status).toBe("in_review");
  });

  it("posts a judge rejection on the page once and sends it to the author", async () => {
    const world = await worldAfter([judgedPageSetup, [...draftedArtifact, judgeRejects("takes")]]);
    expect(fakeDocumentsOf(world.workflow).argsOf("comment")).toHaveLength(1);
    expect(authorIn(world.steps.at(-1)!.after)).toMatchObject({
      status: "working",
      promptsSent: 2,
    });
  });

  it("sends a judge rejection to the author when the host refuses the comment", async () => {
    const world = await worldAfter([judgedPageSetup, [...draftedArtifact, judgeRejects("down")]]);
    expect(authorIn(world.steps.at(-1)!.after)).toMatchObject({
      status: "working",
      promptsSent: 2,
    });
  });
});

describe("an author whose artifact a polisher holds", () => {
  it("gets no prompt from a restart while the polisher runs", async () => {
    const world = await worldAfter([
      {
        ...pageSetup,
        refiners: "reviewer_then_polisher",
        pageEnding: "choice",
        sandboxStart: "at_task_start",
      },
      [
        ...draftedArtifact,
        agentPromptsAuthor(0),
        approvingEnd,
        authorTurnEnds(0, "same"),
        authorRestartsWhile(0, "agent_completes"),
      ],
    ]);
    const after = world.steps.at(-1)!.after;
    expect(after.tasks.find((task) => task.role === "polisher")?.status).toBe("working");
    expect(authorIn(after)).toMatchObject({ promptsSent: 2, queuedPrompts: 1 });
  });
});

describe("a model page author asked for a revision without held comments", () => {
  it("keeps its next turn when the cancel set to land during the request never did", async () => {
    const world = await worldAfter([
      {
        ...pageSetup,
        refiners: "reviewer",
        pageAuthor: "model",
        origin: "tracker",
        firstInput: "origin_issue",
        sandboxStart: "at_task_start",
      },
      [
        firstArtifactAppears(0, "author_text"),
        refinerRunEnds(0, {
          reviewer: "findings",
          pageCommenting: "takes",
          judge: "rejects",
          whileRuled: "nothing",
          polisher: "pushed",
          stopReason: "end_turn",
          closing: "reports_work",
        }),
        agentCompletes(0, "asks_for_a_change", "answers"),
        personStopsModelCall(0, "agent_prompts"),
        personAsksForRevision(0, {
          decisions: "answers",
          host: "readable",
          meanwhile: "agent_cancels",
        }),
        modelCallOutlivesItsDeadline(0, "agent_prompts"),
      ],
    ]);
    expect(authorIn(world.steps.at(-1)!.after)).toMatchObject({
      status: "in_review",
      promptsSent: 2,
      queuedPrompts: 0,
    });
  });
});
