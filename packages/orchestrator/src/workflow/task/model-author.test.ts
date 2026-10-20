import { describe, expect, it } from "bun:test";
import { acceptingD1 } from "../../../test/accepting-d1";
import { freshRuntime } from "../../../test/fresh-runtime";
import { EchoModel, GatedModel, ScriptedFailure } from "../../../test/fake-model";
import {
  PAGE_PARENT,
  fakeDocumentsOf,
  GatedPageWrites,
  patchModelExecution,
  patchNestingHost,
  seedModelAuthor,
  FakeRuntime,
  patchStagePlan,
} from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import { scenario, type Scenario } from "../../../test/scenario";
import { testEnv } from "../../../test/test-env";
import type { TaskRow } from "../store/tasks";
import { CLOSING_TEXT_MARKER, replyMarker } from "../../prompts/model-author-prompt";
import { registeredConfig } from "../../config/register-config";
import { modelAuthorPageTitle, QUEUED_COMMENT_REPLY, runModelAuthorTurn } from "./model-author";
import { promptTask } from "./harness/prompt-queue";
import { provision } from "./sandbox/sandbox";
import { stopAuthor, type StopOutcome } from "../inbound/controls";

const runtimeWithD1: Scenario<FakeRuntime> = async (run) => {
  await run(new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: acceptingD1() }));
};

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
        expect(documents.argsOf("updatePageContent")).toEqual([
          ["page-1", { before: FIRST_PAGE, after: REVISED_PAGE }],
        ]);
        expect(documents.argsOf("createPage")).toHaveLength(1);
      }));

    it("keeps the id of the line the answer left as it was, and only that one", () =>
      freshRuntime(async (workflow) => {
        const author = await seedPageWithHumans(workflow);
        const documents = fakeDocumentsOf(workflow);
        const before = documents.lineIds("page-1");
        workflow.modelInstance = new EchoModel(REVISE_ANSWER);
        await promptTask(workflow, author, FEEDBACK);
        const after = documents.lineIds("page-1");
        expect(documents.pageText("page-1")).toBe(REVISED_PAGE);
        expect(before).toHaveLength(2);
        expect(after[0]).toBe(before[0]);
        expect(after[1]).not.toBe(before[1]);
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

  describe("feedback from comments on the page", () => {
    const COMMENTS = "Comments:\n- [comment c-1] Ann: Name the identity provider.";
    const REPLY = "Named Okta in the goal.";
    const answer = `${REVISE_ANSWER}\n${replyMarker("c-1")}\n${REPLY}`;

    const replied = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.modelInstance = new EchoModel(answer);
      await promptTask(workflow, author, COMMENTS);
    });

    it("asks the model for a reply to the comment", () =>
      replied((workflow) => {
        const model = workflow.modelInstance;
        const userText = model instanceof EchoModel ? model.userTexts[0] : "";
        expect(userText).toContain(replyMarker("<id>"));
      }));

    it("replies to the comment before it changes the page", () =>
      replied((workflow) => {
        const methods = fakeDocumentsOf(workflow).calls.map((call) => call.method);
        expect(methods.indexOf("replyToComment")).toBeLessThan(
          methods.indexOf("updatePageContent"),
        );
        expect(fakeDocumentsOf(workflow).argsOf("replyToComment")).toEqual([
          [{ pageId: "page-1", commentId: "c-1" }, REPLY],
        ]);
      }));

    it("keeps the replies out of the page", () =>
      replied((workflow) => {
        expect(fakeDocumentsOf(workflow).pageText("page-1")).toBe(REVISED_PAGE);
      }));
  });

  describe("an answer that leaves a comment without a reply", () => {
    const unanswered = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.modelInstance = new EchoModel(REVISE_ANSWER);
      await promptTask(workflow, author, "Comments:\n- [comment c-1] Ann: Name it.");
    });

    it("fails the task with the comment it did not answer", () =>
      unanswered((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("failed");
        expect(workflow.posted).toContainEqual(
          expect.objectContaining({ reason: "The model did not reply to comment c-1." }),
        );
      }));

    it("leaves the page alone", () =>
      unanswered((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toEqual([]);
      }));
  });

  describe("a reply the host does not take", () => {
    const outage = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      fakeDocumentsOf(workflow).failNext("replyToComment");
      workflow.modelInstance = new EchoModel(`${REVISE_ANSWER}\n${replyMarker("c-1")}\nDone.`);
      await promptTask(workflow, author, "Comments:\n- [comment c-1] Ann: Name it.");
    });

    it("fails the task", () =>
      outage((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("failed");
      }));

    it("leaves the page alone", () =>
      outage((workflow) => {
        expect(fakeDocumentsOf(workflow).pageText("page-1")).toBe(FIRST_PAGE);
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
    let queuedDuringCall: string[] = [];
    let callsDuringCall = 0;
    let answering = new EchoModel(REVISE_ANSWER);
    const waiting = scenario(runtimeWithD1, async (workflow) => {
      patchModelExecution(workflow);
      const author = seedModelAuthor(workflow);
      answering = new EchoModel(REVISE_ANSWER);
      const model = new GatedModel(answering);
      workflow.modelInstance = model;
      const turn = runModelAuthorTurn(workflow, author);
      await model.waiting;
      await promptTask(workflow, workflow.store.requireTask(author.task_id), FEEDBACK);
      queuedDuringCall = workflow.store.queue().map((row) => row.text);
      callsDuringCall = workflow.modelRequests.length;
      model.release();
      await turn;
    });

    it("keeps the prompt in the queue while the call runs", () =>
      waiting(() => {
        expect(queuedDuringCall).toEqual([FEEDBACK]);
        expect(callsDuringCall).toBe(1);
      }));

    it("revises the page with the prompt once the page is out", () =>
      waiting((workflow) => {
        expect(answering.userTexts).toHaveLength(2);
        expect(answering.userTexts[1]).toContain(FEEDBACK);
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("a person edits the page during the model call", () => {
    const EDITED_PAGE = "## Goal\nLet people sign in with a passkey.";
    let answering = new EchoModel(REVISE_ANSWER);
    const edited = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      const documents = fakeDocumentsOf(workflow);
      answering = new EchoModel((userText) => {
        if (userText.includes(FIRST_PAGE)) documents.seedPage("page-1", EDITED_PAGE);
        return REVISE_ANSWER;
      });
      workflow.modelInstance = answering;
      await promptTask(workflow, author, FEEDBACK);
    });

    it("starts the turn over on the page as the person left it", () =>
      edited(() => {
        expect(answering.userTexts).toHaveLength(2);
        expect(answering.userTexts[1]).toContain(EDITED_PAGE);
      }));

    it("writes the revision over the edited page", () =>
      edited((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toEqual([
          ["page-1", { before: EDITED_PAGE, after: REVISED_PAGE }],
        ]);
      }));

    it("takes the prompt and puts the author back in review", () =>
      edited((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));
  });

  describe("a reply to a comment that is gone from the page", () => {
    const gone = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      fakeDocumentsOf(workflow).addPersonComment({
        id: "c-1",
        pageId: "page-1",
        lineId: Math.max(...fakeDocumentsOf(workflow).lineIds("page-1")) + 1,
        authorName: "Ann",
        text: "Name it.",
      });
      workflow.modelInstance = new EchoModel(`${REVISE_ANSWER}\n${replyMarker("c-1")}\nDone.`);
      await promptTask(workflow, author, "Comments:\n- [comment c-1] Ann: Name it.");
    });

    it("does not reply to it", () =>
      gone((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("replyToComment")).toEqual([]);
      }));

    it("revises the page and puts the author back in review", () =>
      gone((workflow) => {
        expect(fakeDocumentsOf(workflow).pageText("page-1")).toBe(REVISED_PAGE);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));
  });

  describe("a revision that rewrites the line of a comment a queued prompt carries", () => {
    const QUEUED_COMMENT = "Comments:\n- [comment c-2] Bo: Say who signs in.";
    const queued = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      const documents = fakeDocumentsOf(workflow);
      const [, goalLine] = documents.lineIds("page-1");
      documents.addPersonComment({
        id: "c-2",
        pageId: "page-1",
        lineId: goalLine ?? null,
        authorName: "Bo",
        text: "Say who signs in.",
      });
      const model = new GatedModel(
        new EchoModel((userText) =>
          userText.includes("[comment c-2]")
            ? `${REVISE_ANSWER}\n${replyMarker("c-2")}\nSaid it.`
            : REVISE_ANSWER,
        ),
      );
      workflow.modelInstance = model;
      const firstTurn = promptTask(workflow, author, FEEDBACK);
      await model.waiting;
      await promptTask(workflow, workflow.store.requireTask(author.task_id), QUEUED_COMMENT);
      model.release();
      await firstTurn;
    });

    it("replies to the comment before the revision removes its line", () =>
      queued((workflow) => {
        const documents = fakeDocumentsOf(workflow);
        const methods = documents.calls.map((call) => call.method);
        expect(documents.argsOf("replyToComment")[0]).toEqual([
          { pageId: "page-1", commentId: "c-2" },
          QUEUED_COMMENT_REPLY,
        ]);
        expect(methods.indexOf("replyToComment")).toBeLessThan(
          methods.indexOf("updatePageContent"),
        );
      }));

    it("answers the queued prompt next without failing", () =>
      queued((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
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
      patchStagePlan(workflow, {
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

    it("leaves the title of the root page alone", () =>
      revised((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("renamePage")).toEqual([]);
      }));
  });
});

describe("stopAuthor on a model-call author", () => {
  describe("before its first turn", () => {
    let outcome: StopOutcome | null = null;
    const stopped = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      const author = seedModelAuthor(workflow);
      workflow.modelInstance = new EchoModel(FIRST_PAGE);
      outcome = await stopAuthor(workflow, author);
      await provision(workflow, author.task_id);
    });

    it("ends the turn it was starting", () =>
      stopped(() => {
        expect(outcome).toBe("ended");
      }));

    it("leaves the author working without a page", () =>
      stopped((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("working");
        expect(workflow.store.artifact("wf_x-1")).toBeNull();
      }));

    it("makes no model call once its provision alarm fires", () =>
      stopped((workflow) => {
        expect(workflow.modelRequests).toEqual([]);
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toEqual([]);
      }));
  });

  describe("before its first turn, then a prompt", () => {
    let queuedBeforeProvision: string[] = [];
    const prompted = scenario(runtimeWithD1, async (workflow) => {
      patchModelExecution(workflow);
      const author = seedModelAuthor(workflow);
      workflow.modelInstance = new EchoModel(REVISE_ANSWER);
      await stopAuthor(workflow, author);
      await promptTask(workflow, workflow.store.requireTask(author.task_id), FEEDBACK);
      queuedBeforeProvision = workflow.store.queue().map((row) => row.text);
      await provision(workflow, author.task_id);
    });

    it("queues the author to produce its page and keeps the prompt", () =>
      prompted((workflow) => {
        expect(queuedBeforeProvision).toEqual([FEEDBACK]);
        expect(
          workflow.alarmsFor("provision").map((alarm) => alarm.payload as { task_id: string }),
        ).toContainEqual({ task_id: "wf_x.1" });
      }));

    it("produces the page, then revises it with the prompt", () =>
      prompted((workflow) => {
        const model = workflow.modelInstance;
        const userTexts = model instanceof EchoModel ? model.userTexts : [];
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toHaveLength(1);
        expect(userTexts[1]).toContain(FEEDBACK);
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("while the model call of its first turn runs", () => {
    let outcome: StopOutcome | null = null;
    const stopped = scenario(freshRuntime, async (workflow) => {
      patchModelExecution(workflow);
      const author = seedModelAuthor(workflow);
      const model = new GatedModel(new EchoModel(FIRST_PAGE));
      workflow.modelInstance = model;
      const turn = runModelAuthorTurn(workflow, author);
      await model.waiting;
      outcome = await stopAuthor(workflow, workflow.store.requireTask(author.task_id));
      model.release();
      await turn;
    });

    it("ends the turn", () =>
      stopped(() => {
        expect(outcome).toBe("ended");
      }));

    it("does not create a page from the answer", () =>
      stopped((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toEqual([]);
        expect(workflow.store.artifact("wf_x-1")).toBeNull();
      }));

    it("leaves the author working, and logs the dropped answer", () =>
      stopped((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("working");
        expect(workflow.lines).toContain(
          "model call ended after a stop ended its turn. no change.",
        );
      }));
  });

  describe("while the model call of a revise runs", () => {
    const stopped = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      const model = new GatedModel(new EchoModel(REVISE_ANSWER));
      workflow.modelInstance = model;
      const revise = promptTask(workflow, author, FEEDBACK);
      await model.waiting;
      await stopAuthor(workflow, workflow.store.requireTask(author.task_id));
      model.release();
      await revise;
    });

    it("leaves the page alone", () =>
      stopped((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toEqual([]);
        expect(workflow.store.artifact("wf_x-1")?.status).toBe("ready");
      }));

    it("puts the author back in review", () =>
      stopped((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
      }));
  });

  describe("while the page create of its first turn runs, then a prompt", () => {
    let outcome: StopOutcome | null = null;
    let queuedBeforeTheCreate: string[] = [];
    let mostOut = 0;
    const stopped = scenario(runtimeWithD1, async (workflow) => {
      patchModelExecution(workflow);
      const author = seedModelAuthor(workflow);
      workflow.modelInstance = new EchoModel(REVISE_ANSWER);
      const writes = new GatedPageWrites(fakeDocumentsOf(workflow));
      const turn = runModelAuthorTurn(workflow, author);
      await writes.waiting;
      outcome = await stopAuthor(workflow, workflow.store.requireTask(author.task_id));
      await promptTask(workflow, workflow.store.requireTask(author.task_id), FEEDBACK);
      queuedBeforeTheCreate = workflow.store.queue().map((row) => row.text);
      writes.release();
      await turn;
      mostOut = writes.mostOut;
    });

    it("leaves the turn in flight until the create returns", () =>
      stopped(() => {
        expect(outcome).toBe("writing");
      }));

    it("keeps the prompt queued while the create is out", () =>
      stopped(() => {
        expect(queuedBeforeTheCreate).toEqual([FEEDBACK]);
      }));

    it("creates one page and records it", () =>
      stopped((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("createPage")).toHaveLength(1);
        expect(workflow.store.artifact("wf_x-1")).not.toBeNull();
      }));

    it("revises the page with the prompt once the create returns", () =>
      stopped((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toHaveLength(1);
        expect(mostOut).toBe(1);
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("while the page update of a revise runs, then a prompt", () => {
    let outcome: StopOutcome | null = null;
    let mostOut = 0;
    const stopped = scenario(runtimeWithD1, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      workflow.modelInstance = new EchoModel(REVISE_ANSWER);
      const writes = new GatedPageWrites(fakeDocumentsOf(workflow));
      const revise = promptTask(workflow, author, FEEDBACK);
      await writes.waiting;
      outcome = await stopAuthor(workflow, workflow.store.requireTask(author.task_id));
      await promptTask(workflow, workflow.store.requireTask(author.task_id), FEEDBACK);
      writes.release();
      await revise;
      mostOut = writes.mostOut;
    });

    it("leaves the turn in flight until the update returns", () =>
      stopped(() => {
        expect(outcome).toBe("writing");
      }));

    it("runs one page update at a time", () =>
      stopped((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("updatePageContent")).toHaveLength(2);
        expect(mostOut).toBe(1);
      }));

    it("puts the author back in review with its queue empty", () =>
      stopped((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("while the model call of a revise runs, and the call then fails", () => {
    let postedBeforeStop = 0;
    const stopped = scenario(freshRuntime, async (workflow) => {
      const author = await seedPageWithHumans(workflow);
      const model = new GatedModel(new ScriptedFailure(["throw"]));
      workflow.modelInstance = model;
      const revise = promptTask(workflow, author, FEEDBACK);
      await model.waiting;
      postedBeforeStop = workflow.posted.length;
      await stopAuthor(workflow, workflow.store.requireTask(author.task_id));
      model.release();
      await revise;
    });

    it("leaves the author in review, without failing it", () =>
      stopped((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("in_review");
        expect(workflow.lines).toContain(
          "model call failed after a stop ended its turn. no change.",
        );
      }));

    it("does not post for the failure", () =>
      stopped((workflow) => {
        expect(workflow.posted).toHaveLength(postedBeforeStop);
      }));
  });
});
