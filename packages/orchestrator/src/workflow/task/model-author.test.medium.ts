import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { describe, expect, it } from "vitest";
import { ScriptedDecisions } from "../../../test/scripted-decisions";
import { SCRIPTED_NO_REVIEW, SCRIPTED_REVIEW_REQUEST } from "../../../test/scripted-model";
import { CLOSING_TEXT_MARKER } from "../../prompts/model-author-prompt";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { EchoModel } from "../../../test/fake-model";
import {
  PAGE_PARENT,
  MODEL_AUTHOR_MODEL,
  fakeDocumentsOf,
  patchModelExecution,
  patchNestingHost,
  seedModelAuthor,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { runModelAuthorTurn } from "./model-author";
import { promptTask } from "./harness/prompt-queue";

const DOCUMENT = "## Goal\nLet people sign in with SSO.";

const FINDINGS = "The review of your artifact asked for changes.\n- Goal: name the provider.";

function reviseAnswer(closingText: string): string {
  return `${DOCUMENT}\n${CLOSING_TEXT_MARKER}\n${closingText}`;
}

async function reviseAfterReview(workflow: FakeRuntime, closingText: string): Promise<void> {
  const docs = patchModelExecution(workflow);
  const author = seedModelAuthor(workflow);
  const page = await docs.createPage("Add SSO (design)", "## Goal\nSign in.", PAGE_PARENT);
  workflow.store.upsertArtifact({
    job_id: "wf_x-1",
    kind: "page",
    external_url: page.url,
    ref: { kind: "page", page_id: page.id },
  });
  workflow.store.insertTask({
    task_id: "wf_x.2",
    job_id: "wf_x-1",
    role: "reviewer",
    refiner_index: 0,
    sandbox: null,
    model: "mock",
  });
  workflow.store.updateTask("wf_x.2", {
    status: "done",
    result: {
      kind: "review",
      revision: null,
      blocking: true,
      summary: "",
      findings: [{ body: "Name the provider.", location: "Goal" }],
    },
  });
  workflow.store.setArtifactRefinerRun("wf_x-1", "wf_x.2");
  workflow.store.updateTask(author.task_id, { status: "in_review" });
  workflow.patchState({ task_seq: 2 });
  workflow.gatewayInstance = new FakeGateway({ decisions: new ScriptedDecisions() });
  workflow.modelInstance = new EchoModel(reviseAnswer(closingText));
  await promptTask(workflow, workflow.store.requireTask(author.task_id), FINDINGS);
}

function answerWithDocument(workflow: FakeRuntime): EchoModel {
  const model = new EchoModel(DOCUMENT, 0, 0.25);
  workflow.modelInstance = model;
  return model;
}

describe("runModelAuthorTurn", () => {
  describe("a design job that works from the request", () => {
    const written = scenario(freshDurableRuntime, async (workflow) => {
      patchModelExecution(workflow);
      workflow.patchWorkflowDefinition({
        stages: workflow.workflowDefinition().stages.map((stage) => ({
          ...stage,
          author: { produce: { ...stage.author.produce, effort: "high" as const } },
        })),
      });
      workflow.patchState({ name: "SSO sign-in" });
      answerWithDocument(workflow);
      await runModelAuthorTurn(workflow, seedModelAuthor(workflow));
    });

    it("writes the whole page in one call", () =>
      written((workflow) => {
        const model = workflow.modelInstance;
        expect(model instanceof EchoModel && model.userTexts.length).toBe(1);
      }));

    it("asks the produce model at the produce effort on the default gateway", () =>
      written((workflow) => {
        expect(workflow.modelRequests).toEqual([MODEL_AUTHOR_MODEL]);
        expect(workflow.modelParams).toEqual([{ reasoning_effort: "high" }]);
        expect(workflow.modelGateways).toEqual([workflow.config().adapters.gateway.provider]);
      }));

    it("creates the page under the page parent the plan named", () =>
      written((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toEqual([
          ["SSO sign-in (design)", DOCUMENT, PAGE_PARENT],
        ]);
      }));

    it("records the page as the artifact of the job", () =>
      written((workflow) => {
        expect(workflow.store.artifact("wf_x-1")).toMatchObject({
          kind: "page",
          external_url: "https://docs.test/page-1",
          ref: { kind: "page", page_id: "page-1" },
        });
      }));

    it("records the cost of the call on the task", () =>
      written((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").cost_usd).toBeCloseTo(0.25);
      }));

    it("puts the author in review", () =>
      written((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));

    it("starts the reviewer of the stage", () =>
      written((workflow) => {
        expect(workflow.store.tasks().map((task) => task.role)).toEqual(["author", "reviewer"]);
      }));
  });

  describe("the root page stage", () => {
    const ROOT = {
      page_id: "page-1",
      url: "https://docs.test/page-1",
      source: "container" as const,
    };

    const written = scenario(freshDurableRuntime, async (workflow) => {
      const docs = patchNestingHost(workflow);
      await docs.nesting?.createRootPage("SSO sign-in (design)", "## Resources", PAGE_PARENT);
      workflow.patchState({ name: "SSO sign-in", root_page: ROOT });
      answerWithDocument(workflow);
      await runModelAuthorTurn(workflow, seedModelAuthor(workflow));
    });

    it("fills the root page above its resources section", () =>
      written((workflow) => {
        expect(fakeDocumentsOf(workflow).pageText("page-1")).toBe(`${DOCUMENT}\n\n## Resources`);
      }));

    it("creates no other page", () =>
      written((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toEqual([]);
      }));

    it("records the root page as the artifact of the job", () =>
      written((workflow) => {
        expect(workflow.store.artifact("wf_x-1")).toMatchObject({
          external_url: ROOT.url,
          ref: { kind: "page", page_id: "page-1" },
        });
      }));
  });

  describe("a page stage after the root page", () => {
    const written = scenario(freshDurableRuntime, async (workflow) => {
      const docs = patchNestingHost(workflow);
      workflow.patchWorkflowDefinition({
        stages: workflow
          .workflowDefinition()
          .stages.map((stage) => ({ ...stage, root_page: false })),
      });
      docs.seedPage("root-1", "# Design\n\n## Resources");
      workflow.patchState({
        name: "SSO sign-in",
        root_page: { page_id: "root-1", url: "https://docs.test/root-1", source: "container" },
      });
      answerWithDocument(workflow);
      await runModelAuthorTurn(workflow, seedModelAuthor(workflow));
    });

    it("creates its page under the root page", () =>
      written((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toEqual([
          ["SSO sign-in (design)", DOCUMENT, "root-1"],
        ]);
      }));
  });

  describe("a job that works from the page of an earlier job", () => {
    const EARLIER_PAGE = "# Design\nUse OIDC.";

    const fromPage = scenario(freshDurableRuntime, async (workflow) => {
      const docs = patchModelExecution(workflow);
      const earlier = await docs.createPage("Earlier", EARLIER_PAGE, PAGE_PARENT);
      workflow.store.insertJob({
        job_id: "wf_x-0",
        stage: "design",
        issue_id: null,
        issue_key: null,
        input_key: null,
        preceding_job_id: null,
        branch: null,
        brief: "",
      });
      workflow.store.upsertArtifact({
        job_id: "wf_x-0",
        kind: "page",
        external_url: earlier.url,
        ref: { kind: "page", page_id: earlier.id },
      });
      answerWithDocument(workflow);
      await runModelAuthorTurn(
        workflow,
        seedModelAuthor(workflow, { stage: "breakdown", preceding_job_id: "wf_x-0" }),
      );
    });

    it("gives the model the text of the earlier page", () =>
      fromPage((workflow) => {
        const model = workflow.modelInstance;
        expect(model instanceof EchoModel && model.userTexts[0]).toContain(EARLIER_PAGE);
      }));
  });

  describe("a job that works from a page no job of this workflow produced", () => {
    const GIVEN_PAGE = "# Design\nUse SAML.";

    const fromGivenPage = scenario(freshDurableRuntime, async (workflow) => {
      const docs = patchModelExecution(workflow);
      const given = await docs.createPage("Given", GIVEN_PAGE, PAGE_PARENT);
      answerWithDocument(workflow);
      await runModelAuthorTurn(
        workflow,
        seedModelAuthor(workflow, {
          stage: "breakdown",
          input_ref: { kind: "page", page_id: given.id },
          input_url: given.url,
        }),
      );
    });

    it("gives the model the text of the page", () =>
      fromGivenPage((workflow) => {
        const model = workflow.modelInstance;
        expect(model instanceof EchoModel && model.userTexts[0]).toContain(GIVEN_PAGE);
      }));

    it("links the page as the input artifact", () =>
      fromGivenPage((workflow) => {
        const model = workflow.modelInstance;
        expect(model instanceof EchoModel && model.userTexts[0]).toContain("## Input artifact\n");
      }));
  });

  describe("a prompt that arrived while the first call ran", () => {
    const followed = scenario(freshDurableRuntime, async (workflow) => {
      patchModelExecution(workflow);
      workflow.modelInstance = new EchoModel(reviseAnswer(SCRIPTED_NO_REVIEW));
      const author = seedModelAuthor(workflow);
      workflow.store.enqueuePrompt(author.task_id, "Name the identity provider.");
      await runModelAuthorTurn(workflow, author);
    });

    it("creates the page and then updates it from the prompt", () =>
      followed((workflow) => {
        const docs = fakeDocumentsOf(workflow);
        expect(docs.argsOf("createPage")).toHaveLength(1);
        expect(docs.argsOf("updatePageContent")).toEqual([["page-1", DOCUMENT]]);
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("starts the reviewer once, after the revision", () =>
      followed((workflow) => {
        expect(workflow.store.tasks().map((task) => task.role)).toEqual(["author", "reviewer"]);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));
  });

  describe("a stage with no refiners", () => {
    const unreviewed = scenario(freshDurableRuntime, async (workflow) => {
      patchModelExecution(workflow);
      workflow.patchWorkflowDefinition({
        stages: workflow.workflowDefinition().stages.map((stage) => ({ ...stage, reviewers: [] })),
      });
      answerWithDocument(workflow);
      await runModelAuthorTurn(workflow, seedModelAuthor(workflow));
    });

    it("tells the orchestrator agent the call ended", () =>
      unreviewed((workflow) => {
        expect(workflow.notes.map((note) => note.wake)).toEqual(["task_result"]);
        expect(workflow.noteTexts()[0]).toContain("Model call ended.");
      }));
  });

  describe("a revision whose closing text asks for another review", () => {
    const reviewAgain = scenario(freshDurableRuntime, (workflow) =>
      reviseAfterReview(workflow, SCRIPTED_REVIEW_REQUEST),
    );

    it("updates the page with the document part of the answer", () =>
      reviewAgain((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toEqual([
          ["page-1", DOCUMENT],
        ]);
      }));

    it("keeps the closing text as the task summary", () =>
      reviewAgain((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").summary).toBe(SCRIPTED_REVIEW_REQUEST);
      }));

    it("runs the reviewers again from the start of the segment", () =>
      reviewAgain((workflow) => {
        const reviewers = workflow.store.tasks().filter((task) => task.role === "reviewer");
        expect(reviewers.map((task) => [task.task_id, task.refiner_index])).toEqual([
          ["wf_x.2", 0],
          ["wf_x.3", 0],
        ]);
      }));

    it("keeps the page from the humans", () =>
      reviewAgain((workflow) => {
        expect(workflow.store.artifact("wf_x-1")?.status).toBe("drafted");
      }));
  });

  describe("a revision whose closing text needs no review", () => {
    const handedOn = scenario(freshDurableRuntime, (workflow) =>
      reviseAfterReview(workflow, SCRIPTED_NO_REVIEW),
    );

    it("runs no other reviewer", () =>
      handedOn((workflow) => {
        expect(workflow.store.tasks().filter((task) => task.role === "reviewer")).toHaveLength(1);
      }));

    it("hands the page to the humans once the list is exhausted", () =>
      handedOn((workflow) => {
        expect(workflow.store.artifact("wf_x-1")?.status).toBe("ready");
      }));

    it("gives the orchestrator agent the closing text", () =>
      handedOn((workflow) => {
        const ended = workflow.noteTexts().find((text) => text.includes("Model call ended."));
        expect(ended).toContain(SCRIPTED_NO_REVIEW);
      }));
  });
});
