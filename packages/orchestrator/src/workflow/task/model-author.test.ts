import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { EchoModel, ScriptedFailure } from "../../../test/fake-model";
import {
  PAGE_PARENT,
  fakeDocumentsOf,
  patchModelExecution,
  patchNestingHost,
  seedModelAuthor,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import type { TaskRow } from "../store/tasks";
import { CLOSING_TEXT_MARKER } from "../../prompts/model-author-prompt";
import { registeredConfig } from "../../config/register-config";
import { modelAuthorPageTitle, runModelAuthorTurn } from "./model-author";
import { promptTask } from "./harness/prompt-queue";

describe("modelAuthorPageTitle", () => {
  it("names the workflow and the stage", () => {
    expect(modelAuthorPageTitle("Add SSO", "design")).toBe("Add SSO (design)");
  });
});

describe("runModelAuthorTurn", () => {
  describe("with no document host", () => {
    const hostless = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      workflow.documentsInstance = null;
      workflow.modelInstance = new EchoModel("# Design");
      await runModelAuthorTurn(workflow, seedModelAuthor(workflow));
    });

    it("fails the task", () =>
      hostless((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("failed");
      }));

    it("makes no model call", () =>
      hostless((workflow) => {
        expect(workflow.modelRequests).toEqual([]);
      }));
  });

  describe("when the model call throws", () => {
    const outage = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      workflow.modelInstance = new ScriptedFailure(["throw"]);
      await runModelAuthorTurn(workflow, seedModelAuthor(workflow));
    });

    it("fails the task", () =>
      outage((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("failed");
      }));

    it("creates no page", () =>
      outage((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toEqual([]);
      }));

    it("records no artifact", () =>
      outage((workflow) => {
        expect(workflow.store.artifact("wf_x-1")).toBeNull();
      }));

    it("posts what failed and the task whose log holds the details", () =>
      outage((workflow) => {
        expect(workflow.posted).toContainEqual({
          type: "failed",
          job_id: "wf_x-1",
          reason:
            "The model call or the page create failed. The details are in the logs of task wf_x.1.",
        });
      }));

    it("keeps the error text of the model out of every post", () =>
      outage((workflow) => {
        expect(JSON.stringify(workflow.posted)).not.toContain("model outage");
      }));

    it("logs the error text of the model", () =>
      outage((workflow) => {
        expect(workflow.lines).toContainEqual(
          expect.stringMatching(/^model call or page create failed: .*model outage/),
        );
      }));
  });

  describe("when the model answers with no text", () => {
    const blank = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      workflow.modelInstance = new EchoModel("  \n", 0, 0.1);
      await runModelAuthorTurn(workflow, seedModelAuthor(workflow));
    });

    it("fails the task", () =>
      blank((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("failed");
      }));

    it("counts the call on the task", () =>
      blank((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").cost_usd).toBeCloseTo(0.1);
      }));

    it("creates no page", () =>
      blank((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toEqual([]);
      }));

    it("posts the reason unchanged", () =>
      blank((workflow) => {
        expect(workflow.posted).toContainEqual({
          type: "failed",
          job_id: "wf_x-1",
          reason: "The model answered with no document text.",
        });
      }));
  });
});

const FIRST_PAGE = "## Goal\nLet people sign in.";
const REVISED_PAGE = "## Goal\nLet people sign in with SSO.";
const FEEDBACK = "Name the identity provider in the goal.";
const CLOSING_TEXT = "Named the identity provider. The change was straightforward.";
const REVISE_ANSWER = `${REVISED_PAGE}\n${CLOSING_TEXT_MARKER}\n${CLOSING_TEXT}`;

async function seedPageWithHumans(workflow: FakeRuntime): Promise<TaskRow> {
  const documents = patchModelExecution(workflow);
  const author = seedModelAuthor(workflow);
  const page = await documents.createPage("Add SSO (design)", FIRST_PAGE, PAGE_PARENT);
  workflow.store.upsertArtifact({
    job_id: "wf_x-1",
    kind: "page",
    external_url: page.url,
    ref: { kind: "page", page_id: page.id },
  });
  workflow.store.advanceArtifact("wf_x-1", ["drafted"], "ready");
  workflow.store.updateTask(author.task_id, { status: "in_review" });
  return workflow.store.requireTask(author.task_id);
}

describe("reviseModelAuthorPage", () => {
  describe("feedback on a page the humans have", () => {
    const revised = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.modelInstance = new EchoModel(REVISE_ANSWER, 0, 0.2);
      await promptTask(workflow, author, FEEDBACK);
    });

    it("gives the model the page text and the feedback", () =>
      revised((workflow) => {
        const model = workflow.modelInstance;
        const userText = model instanceof EchoModel ? model.userTexts[0] : "";
        expect(userText).toContain(FIRST_PAGE);
        expect(userText).toContain(FEEDBACK);
      }));

    it("ends the system prompt with the writing rules", () =>
      revised((workflow) => {
        const model = workflow.modelInstance;
        const system = model instanceof EchoModel ? model.systems[0] : "";
        expect(system?.endsWith(`\n\n${registeredConfig().writingRules}`)).toBe(true);
      }));

    it("keeps the closing text as the task summary", () =>
      revised((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").summary).toBe(CLOSING_TEXT);
      }));

    it("updates the same page with the document part of the answer", () =>
      revised((workflow) => {
        const documents = fakeDocumentsOf(workflow);
        expect(documents.argsOf("updatePageContent")).toEqual([["page-1", REVISED_PAGE]]);
        expect(documents.argsOf("createPage")).toHaveLength(1);
      }));

    it("takes the prompt off the queue", () =>
      revised((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("counts the call on the task", () =>
      revised((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").cost_usd).toBeCloseTo(0.2);
      }));

    it("makes the page a draft again", () =>
      revised((workflow) => {
        expect(workflow.store.artifact("wf_x-1")?.status).toBe("drafted");
      }));

    it("puts the author back in review", () =>
      revised((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));

    it("runs the reviewer of the stage and no researcher", () =>
      revised((workflow) => {
        expect(workflow.store.tasks().map((task) => task.role)).toEqual(["author", "reviewer"]);
      }));
  });

  describe("an answer with no closing text", () => {
    const unmarked = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.modelInstance = new EchoModel(REVISED_PAGE);
      await promptTask(workflow, author, FEEDBACK);
    });

    it("fails the task", () =>
      unmarked((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("failed");
      }));

    it("leaves the page alone", () =>
      unmarked((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toEqual([]);
      }));
  });

  describe("a prompt while the first model call runs", () => {
    const waiting = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      const author = seedModelAuthor(workflow);
      workflow.store.updateTask(author.task_id, { status: "working" });
      workflow.modelInstance = new EchoModel(REVISED_PAGE);
      await promptTask(workflow, workflow.store.requireTask(author.task_id), FEEDBACK);
    });

    it("keeps the prompt in the queue", () =>
      waiting((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([FEEDBACK]);
      }));

    it("makes no model call", () =>
      waiting((workflow) => {
        expect(workflow.modelRequests).toEqual([]);
      }));
  });

  describe("a prompt to a paused author", () => {
    const paused = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.store.updateTask(author.task_id, { paused_at: new Date().toISOString() });
      workflow.modelInstance = new EchoModel(REVISED_PAGE);
      await promptTask(workflow, workflow.store.requireTask(author.task_id), FEEDBACK);
    });

    it("keeps the prompt in the queue", () =>
      paused((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([FEEDBACK]);
      }));

    it("leaves the page alone", () =>
      paused((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toEqual([]);
      }));
  });

  describe("when the model call throws", () => {
    const outage = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.modelInstance = new ScriptedFailure(["throw"]);
      await promptTask(workflow, author, FEEDBACK);
    });

    it("fails the task", () =>
      outage((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("failed");
      }));

    it("leaves the page alone", () =>
      outage((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toEqual([]);
      }));

    it("posts what failed and the task whose log holds the details", () =>
      outage((workflow) => {
        expect(workflow.posted).toContainEqual({
          type: "failed",
          job_id: "wf_x-1",
          reason:
            "The model call or the page update failed. The details are in the logs of task wf_x.1.",
        });
      }));

    it("keeps the error text of the model out of every post", () =>
      outage((workflow) => {
        expect(JSON.stringify(workflow.posted)).not.toContain("model outage");
      }));

    it("logs the error text of the model", () =>
      outage((workflow) => {
        expect(workflow.lines).toContainEqual(
          expect.stringMatching(/^model call or page update failed: .*model outage/),
        );
      }));
  });

  describe("feedback on the root page", () => {
    const CHILD = '<page url="https://docs.test/page-2">Add SSO (plan)</page>';
    const ROOT_TEXT = `${FIRST_PAGE}\n\n## Resources\n${CHILD}`;

    const revised = scenario(freshRuntime, async (workflow) => {
      const documents = patchNestingHost(workflow);
      const author = seedModelAuthor(workflow);
      documents.seedPage("root-1", ROOT_TEXT);
      workflow.patchState({
        root_page: { page_id: "root-1", url: "https://docs.test/root-1", source: "container" },
      });
      workflow.store.upsertArtifact({
        job_id: "wf_x-1",
        kind: "page",
        external_url: "https://docs.test/root-1",
        ref: { kind: "page", page_id: "root-1" },
      });
      workflow.store.advanceArtifact("wf_x-1", ["drafted"], "ready");
      workflow.store.updateTask(author.task_id, { status: "in_review" });
      workflow.modelInstance = new EchoModel(REVISE_ANSWER);
      await promptTask(workflow, workflow.store.requireTask(author.task_id), FEEDBACK);
    });

    it("gives the model only the text above the resources section", () =>
      revised((workflow) => {
        const model = workflow.modelInstance;
        const userText = model instanceof EchoModel ? model.userTexts[0] : "";
        expect(userText).toContain(FIRST_PAGE);
        expect(userText).not.toContain(CHILD);
      }));

    it("replaces the text above the resources section and keeps the section", () =>
      revised((workflow) => {
        expect(fakeDocumentsOf(workflow).pageText("root-1")).toBe(
          `${REVISED_PAGE}\n\n## Resources\n${CHILD}`,
        );
      }));
  });
});
