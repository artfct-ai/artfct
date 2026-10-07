import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { describe, expect, it } from "vitest";
import {
  freshWorkflow,
  plannedWorkflow,
  type WorkflowClients,
} from "../../../../test/fresh-workflow";
import { scenario, type Scenario } from "../../../../test/scenario";
import { toolText } from "../../../../test/tool-result";
import type { Workflow } from "../../../workflow";
import type { JobInput } from "../../../workflow/lifecycle";
import { planTools } from "../plan";
import { jobInputKey } from "../../../workflow/store/input-key";
import { startTools, unfinishedJobRefusal } from "./start";

const call = { toolCallId: "call-1", messages: [], context: {} };

const REQUEST = "Fix the login redirect.";

type JobSeed = { stage?: string; issue?: { id: string; key: string } };

function seedJob(workflow: Workflow, jobId: string, taskId: string, seed: JobSeed = {}): void {
  workflow.store.insertJob({
    job_id: jobId,
    stage: seed.stage ?? "implement",
    issue_id: seed.issue?.id ?? null,
    issue_key: seed.issue?.key ?? null,
    input_key: seed.issue?.id ?? jobInputKey({ kind: "request", text: REQUEST }),
    preceding_job_id: null,
    branch: null,
    brief: "",
  });
  workflow.store.insertTask({
    task_id: taskId,
    job_id: jobId,
    role: "author",
    sandbox: { harness: "opencode", bridge_token: "secret" },
    model: "mock",
  });
}

const ENG_1 = { id: "i1", key: "ENG-1" };

const ENG_1_INPUT: JobInput = {
  kind: "issue",
  issue: { ...ENG_1, title: "Fix login", team_id: null, started: false },
};

describe("unfinishedJobRefusal", () => {
  describe("an issue whose only job failed", () => {
    const failed = scenario(freshWorkflow(), (workflow) => {
      seedJob(workflow, "j1", "t1", { issue: ENG_1 });
      workflow.store.updateTask("t1", { status: "failed" });
    });

    it("frees the issue again", () =>
      failed((workflow) => {
        expect(unfinishedJobRefusal(workflow, ENG_1_INPUT)).toBeNull();
      }));

    describe("with a newer job on the same issue", () => {
      const owned = scenario(failed, (workflow) => {
        seedJob(workflow, "j2", "t2", { issue: ENG_1 });
      });

      it("names the newer job, not the failed one", () =>
        owned((workflow) => {
          expect(unfinishedJobRefusal(workflow, ENG_1_INPUT)).toMatch(
            /^Job j2 already works on ENG-1/,
          );
        }));

      describe("once that job is done", () => {
        const done = scenario(owned, (workflow) => {
          workflow.store.updateTask("t2", { status: "done" });
        });

        it("leaves the issue to the output artifact check", () =>
          done((workflow) => {
            expect(unfinishedJobRefusal(workflow, ENG_1_INPUT)).toBeNull();
          }));
      });
    });
  });
});

function closedPullHost(): FakeCodeHost {
  return new FakeCodeHost({
    pulls: [pullRequest({ number: 1, merged: false, state: "closed" })],
    repositories: ["acme/app"],
  });
}

type StartedFrom = { issue: true } | { issue: false; request: string };

function cancelledJobWithPull(code: () => FakeCodeHost, from: StartedFrom): Scenario<Completion> {
  const issue = from.issue;
  return (run) =>
    plannedWorkflow(2, () => ({ code: code() }))(async (workflow) => {
      pullJob(workflow, issue ? { issue: { id: "ENG-1", key: "ENG-1" } } : {});
      workflow.store.updateTask("t1", { status: "cancelled" });
      const { start_job } = startTools(workflow, from.issue ? [] : [from.request]);
      const result = toolText(
        await start_job.execute(
          { stage: "implement", brief: "again", issue: issue ? "ENG-1" : undefined },
          call,
        ),
      );
      await run({ workflow, result });
    });
}

describe("start_job after a finished job on the same input artifact", () => {
  describe("whose pull request the host still holds", () => {
    const refused = cancelledJobWithPull(() => pullHost(false), { issue: true });

    it("refuses and names the output artifact", () =>
      refused(({ result }) => {
        expect(result).toMatch(
          /^Job j1 \(cancelled\) already produced https:\/\/github.com\/acme\/app\/pull\/1/,
        );
      }));

    it("says how to continue the pull request", () =>
      refused(({ result }) => {
        expect(result).toContain("call start_job with artifact set to that link and no issue");
      }));

    it("records no second job", () =>
      refused(({ workflow }) => {
        expect(workflow.store.jobs()).toHaveLength(1);
      }));
  });

  describe("that named no issue, asked for by the same request", () => {
    const refused = cancelledJobWithPull(() => pullHost(false), { issue: false, request: REQUEST });

    it("refuses and names the request", () =>
      refused(({ result }) => {
        expect(result).toMatch(/^Job j1 \(cancelled\) already produced \S+ from the same request/);
      }));
  });

  describe("that named no issue, asked for by another request", () => {
    const started = cancelledJobWithPull(() => pullHost(false), {
      issue: false,
      request: "Add a logout link.",
    });

    it("starts the job", () =>
      started(({ result }) => {
        expect(result).toMatch(/^Started job/);
      }));
  });

  describe("whose pull request the host closed with no merge, and the event was lost", () => {
    const started = cancelledJobWithPull(closedPullHost, { issue: true });

    it("starts the job", () =>
      started(({ result }) => {
        expect(result).toMatch(/^Started job/);
      }));

    it("records the removal", () =>
      started(({ workflow }) => {
        expect(workflow.store.artifact("j1")?.status).toBe("removed");
      }));
  });

  describe("whose pull request the host merged", () => {
    const refused = cancelledJobWithPull(() => pullHost(true), { issue: true });

    it("refuses", () =>
      refused(({ result }) => {
        expect(result).toMatch(/the host still holds it/);
      }));
  });
});

const PULL_URL = "https://github.com/acme/app/pull/1";

function startedOnPullOfJob(
  code: () => FakeCodeHost,
  authorStatus: "cancelled" | "in_review",
): Scenario<Completion> {
  return (run) =>
    plannedWorkflow(2, () => ({ code: code() }))(async (workflow) => {
      pullJob(workflow, { issue: { id: "ENG-1", key: "ENG-1" } });
      workflow.store.updateTask("t1", { status: authorStatus });
      const { start_job } = startTools(workflow);
      const result = toolText(
        await start_job.execute(
          { stage: "implement", brief: "merge main in", artifact: PULL_URL },
          call,
        ),
      );
      await run({ workflow, result });
    });
}

describe("start_job on the open pull request of an earlier job", () => {
  describe("whose author was cancelled", () => {
    const continued = startedOnPullOfJob(() => pullHost(false), "cancelled");

    it("starts a job that continues the pull request", () =>
      continued(({ result }) => {
        expect(result).toMatch(
          /^Started job \S+ for stage implement on branch artfct\/wf-1-fix\. It continues https:\/\/github.com\/acme\/app\/pull\/1\./,
        );
      }));

    it("puts the job on the branch of the pull request", () =>
      continued(({ workflow }) => {
        expect(workflow.store.jobs().at(-1)?.branch).toBe("artfct/wf-1-fix");
      }));

    it("starts another one after that job was cancelled too", () =>
      continued(async ({ workflow }) => {
        const second = workflow.store.jobs().at(-1)!;
        workflow.store.upsertArtifact({
          job_id: second.job_id,
          kind: "pull",
          external_url: PULL_URL,
          ref: { kind: "pull", repo: "acme/app", number: 1 },
        });
        const author = workflow.store.authorTaskOf(second.job_id);
        workflow.store.updateTask(author.task_id, { status: "cancelled" });
        const { start_job } = startTools(workflow);
        const again = toolText(
          await start_job.execute({ stage: "implement", brief: "again", artifact: PULL_URL }, call),
        );
        expect(again).toMatch(/^Started job \S+ for stage implement/);
      }));
  });

  describe("whose author is unfinished", () => {
    const refused = startedOnPullOfJob(() => pullHost(false), "in_review");

    it("refuses and names the job that works on it", () =>
      refused(({ result }) => {
        expect(result).toMatch(/^Job j1 still works on https:\/\/github.com\/acme\/app\/pull\/1/);
      }));
  });

  describe("that the host merged", () => {
    const refused = startedOnPullOfJob(() => pullHost(true), "cancelled");

    it("refuses, because a closed pull request cannot be continued", () =>
      refused(({ result }) => {
        expect(result).toBe(
          `${PULL_URL} is closed or comes from a fork, so no job can continue it.`,
        );
      }));
  });

  describe("that comes from a fork", () => {
    const refused = startedOnPullOfJob(
      () =>
        new FakeCodeHost({
          pulls: [pullRequest({ number: 1, from_fork: true })],
          repositories: ["acme/app"],
        }),
      "cancelled",
    );

    it("refuses, because its branch is not in the repository", () =>
      refused(({ result }) => {
        expect(result).toBe(
          `${PULL_URL} is closed or comes from a fork, so no job can continue it.`,
        );
      }));
  });
});

function issueStartedByAnotherWorkflow(
  afterStart: (owner: Workflow, jobId: string) => void,
): Scenario<Completion> {
  return async (run) => {
    await plannedWorkflow(1, () => ({ code: pullHost(false) }))(async (owner) => {
      const { start_job } = startTools(owner);
      await start_job.execute({ stage: "implement", brief: "first", issue: "ENG-1" }, call);
      afterStart(owner, owner.store.jobs()[0]!.job_id);
    });
    await plannedWorkflow(1)(async (workflow) => {
      const { start_job } = startTools(workflow);
      const result = toolText(
        await start_job.execute({ stage: "implement", brief: "second", issue: "ENG-1" }, call),
      );
      await run({ workflow, result });
    });
  };
}

function cancelAuthor(owner: Workflow, jobId: string): void {
  owner.store.updateTask(owner.store.authorTaskOf(jobId).task_id, { status: "cancelled" });
}

describe("start_job on an issue another workflow started a job on", () => {
  describe("while that job is unfinished", () => {
    const refused = issueStartedByAnotherWorkflow(() => {});

    it("refuses and names the workflow and its job", () =>
      refused(({ result }) => {
        expect(result).toMatch(
          /^Workflow wf_fresh_\d+ holds ENG-1\. Job \S+ already works on ENG-1/,
        );
      }));

    it("records no job", () =>
      refused(({ workflow }) => {
        expect(workflow.store.jobs()).toHaveLength(0);
      }));
  });

  describe("after that job was cancelled with its pull request still open", () => {
    const refused = issueStartedByAnotherWorkflow((owner, jobId) => {
      cancelAuthor(owner, jobId);
      owner.store.upsertArtifact({
        job_id: jobId,
        kind: "pull",
        external_url: "https://github.com/acme/app/pull/1",
        ref: { kind: "pull", repo: "acme/app", number: 1 },
      });
    });

    it("refuses and names the output artifact", () =>
      refused(({ result }) => {
        expect(result).toMatch(
          /^Workflow wf_fresh_\d+ holds ENG-1\. Job \S+ \(cancelled\) already produced https:\/\/github.com\/acme\/app\/pull\/1/,
        );
      }));
  });

  describe("after that job was cancelled with no output artifact", () => {
    const started = issueStartedByAnotherWorkflow(cancelAuthor);

    it("starts the job", () =>
      started(({ result }) => {
        expect(result).toMatch(/^Started job/);
      }));
  });
});

function startFrom(link: string, clients: () => WorkflowClients, input: { issue?: string } = {}) {
  return (run: (completion: Completion) => Promise<void> | void) =>
    plannedWorkflow(
      2,
      clients,
    )(async (workflow) => {
      const { start_job } = startTools(workflow, [REQUEST]);
      const result = toolText(
        await start_job.execute(
          { stage: "implement", brief: "plan it", artifact: link, ...input },
          call,
        ),
      );
      await run({ workflow, result });
    });
}

describe("start_job", () => {
  describe("two calls that race for one free slot", () => {
    let texts: string[];
    const raced = scenario(plannedWorkflow(1), async (workflow) => {
      const { start_job } = startTools(workflow);
      const results = await Promise.all([
        start_job.execute({ stage: "implement", brief: "one", issue: "ENG-1" }, call),
        start_job.execute({ stage: "implement", brief: "two", issue: "ENG-2" }, call),
      ]);
      texts = results.map(toolText);
    });

    it("starts one of them", () =>
      raced(() => {
        expect(texts.filter((text) => text.startsWith("Started job"))).toHaveLength(1);
      }));

    it("tells the other that the slots are busy", () =>
      raced(() => {
        expect(texts.filter((text) => /slots are busy/.test(text))).toHaveLength(1);
      }));

    it("records one job", () =>
      raced((workflow) => {
        expect(workflow.store.jobs()).toHaveLength(1);
      }));
  });

  describe("an issue another job already works on", () => {
    let result: string;
    const refused = scenario(plannedWorkflow(2), async (workflow) => {
      seedJob(workflow, "j1", "t1", { issue: { id: "ENG-1", key: "ENG-1" } });
      const { start_job } = startTools(workflow);
      result = toolText(
        await start_job.execute({ stage: "implement", brief: "again", issue: "ENG-1" }, call),
      );
    });

    it("names the job that owns the issue", () =>
      refused(() => {
        expect(result).toMatch(/^Job j1 already works on ENG-1/);
      }));

    it("records no second job", () =>
      refused((workflow) => {
        expect(workflow.store.jobs()).toHaveLength(1);
      }));
  });

  describe("a request another unfinished job was started for", () => {
    let result: string;
    const refused = scenario(plannedWorkflow(2), async (workflow) => {
      seedJob(workflow, "j1", "t1");
      const { start_job } = startTools(workflow, [REQUEST]);
      result = toolText(await start_job.execute({ stage: "implement", brief: "again" }, call));
    });

    it("names the job that works on it", () =>
      refused(() => {
        expect(result).toBe("Job j1 already works on the same request (queued).");
      }));

    it("records no second job", () =>
      refused((workflow) => {
        expect(workflow.store.jobs()).toHaveLength(1);
      }));
  });

  describe("another request in the stage of an unfinished job", () => {
    let result: string;
    const started = scenario(plannedWorkflow(2), async (workflow) => {
      seedJob(workflow, "j1", "t1");
      const { start_job } = startTools(workflow, ["Add a logout link."]);
      result = toolText(await start_job.execute({ stage: "implement", brief: "logout" }, call));
    });

    it("starts the job", () =>
      started(() => {
        expect(result).toMatch(/^Started job/);
      }));
  });

  describe("a workflow that is done", () => {
    let result: string;
    const refused = scenario(plannedWorkflow(1), async (workflow) => {
      workflow.patchState({ status: "done" });
      const { start_job } = startTools(workflow, [REQUEST]);
      result = toolText(await start_job.execute({ stage: "implement", brief: "more" }, call));
    });

    it("refuses, since a finished workflow stays finished", () =>
      refused(() => {
        expect(result).toBe("The workflow is done. A finished workflow stays finished.");
      }));

    it("records no job", () =>
      refused((workflow) => {
        expect(workflow.store.jobs()).toHaveLength(0);
      }));
  });

  describe("the next stage twice, after the job before it was accepted", () => {
    const APPROVAL = "looks good, go ahead";
    let first: string;
    let second: string;
    const advanced = scenario(plannedWorkflow(2), async (workflow) => {
      pullJob(workflow);
      workflow.store.updateTask("t1", { status: "done" });
      workflow.store.advanceArtifact("j1", ["drafted"], "accepted");
      const { start_job } = startTools(workflow, [APPROVAL]);
      first = toolText(await start_job.execute({ stage: "implement", brief: "next" }, call));
      second = toolText(await start_job.execute({ stage: "implement", brief: "again" }, call));
    });

    it("starts the first job on the accepted artifact", () =>
      advanced((workflow) => {
        expect(first).toMatch(/^Started job/);
        expect(workflow.store.jobs().at(-1)?.input_key).toBe(
          jobInputKey({ kind: "artifact", jobId: "j1" }),
        );
      }));

    it("refuses the second and names the artifact", () =>
      advanced(() => {
        expect(second).toMatch(/^Job \S+ already works on the artifact of job j1 \(queued\)\.$/);
      }));
  });

  describe("an artifact the agent names", () => {
    const PAGE_URL = "https://docs.test/design-7";

    function pageHost(): WorkflowClients {
      return { documents: new FakeDocuments({ pages: { [PAGE_URL]: "page-7" } }) };
    }

    describe("a page on the document host", () => {
      const started = startFrom(PAGE_URL, pageHost);

      it("starts the job", () =>
        started(({ result }) => {
          expect(result).toMatch(/^Started job/);
        }));

      it("records the page as the input of the job", () =>
        started(({ workflow }) => {
          expect(workflow.store.jobs().at(-1)).toMatchObject({
            input_key: "page:page-7",
            input_ref: { kind: "page", page_id: "page-7" },
            input_url: PAGE_URL,
          });
        }));

      describe("and a second job on the same page", () => {
        it("refuses and names the page", () =>
          started(async ({ workflow }) => {
            const { start_job } = startTools(workflow, [REQUEST]);
            const second = toolText(
              await start_job.execute(
                { stage: "implement", brief: "again", artifact: PAGE_URL },
                call,
              ),
            );
            expect(second).toBe(
              `Job ${workflow.store.jobs()[0]?.job_id} already works on the page ${PAGE_URL} (queued).`,
            );
          }));
      });
    });

    describe("a pull request of the repository", () => {
      const started = startFrom(PULL_URL, () => ({ code: pullHost(false) }));

      it("starts the job", () =>
        started(({ result }) => {
          expect(result).toMatch(/^Started job/);
        }));

      it("records the pull request as the input of the job", () =>
        started(({ workflow }) => {
          expect(workflow.store.jobs().at(-1)).toMatchObject({
            input_key: "pull:acme/app#1",
            input_ref: { kind: "pull", repo: "acme/app", number: 1 },
            input_url: PULL_URL,
          });
        }));
    });

    describe("a link no artifact kind claims", () => {
      const refused = startFrom("https://example.test/notes", pageHost);

      it("refuses and names the link", () =>
        refused(({ result }) => {
          expect(result).toBe(
            "The link https://example.test/notes is not an artifact on a configured host.",
          );
        }));

      it("records no job", () =>
        refused(({ workflow }) => {
          expect(workflow.store.jobs()).toHaveLength(0);
        }));
    });

    describe("a page link with no document host", () => {
      const refused = startFrom(PAGE_URL, () => ({ documents: null }));

      it("refuses", () =>
        refused(({ result }) => {
          expect(result).toBe(`The link ${PAGE_URL} is not an artifact on a configured host.`);
        }));
    });

    describe("together with an issue", () => {
      const refused = startFrom(PAGE_URL, pageHost, { issue: "ENG-1" });

      it("refuses", () =>
        refused(({ result }) => {
          expect(result).toBe("Name the issue or the artifact, not both.");
        }));
    });
  });

  describe("a harness and a model the agent names", () => {
    let result: string;
    const started = scenario(plannedWorkflow(1), async (workflow) => {
      const { start_job } = startTools(workflow);
      result = toolText(
        await start_job.execute(
          {
            stage: "implement",
            brief: "go",
            harness: "opencode",
            model: "openrouter/x-ai/grok-4.6",
          },
          call,
        ),
      );
    });

    it("starts the job", () =>
      started(() => {
        expect(result).toMatch(/^Started job/);
      }));

    it("runs its author on the named harness", () =>
      started((workflow) => {
        const [task] = workflow.store.tasks();
        expect(task && workflow.store.sandbox(task.task_id)?.harness).toBe("opencode");
      }));

    it("runs its author on the named model", () =>
      started((workflow) => {
        expect(workflow.store.tasks()[0]?.model).toBe("openrouter/x-ai/grok-4.6");
      }));
  });

  describe("a gateway model on claude-code", () => {
    let result: string;
    const refused = scenario(plannedWorkflow(1), async (workflow) => {
      const { start_job } = startTools(workflow);
      result = toolText(
        await start_job.execute(
          {
            stage: "implement",
            brief: "go",
            harness: "claude-code",
            model: "openrouter/x-ai/grok-4.6",
          },
          call,
        ),
      );
    });

    it("says claude-code runs Anthropic models by their plain id", () =>
      refused(() => {
        expect(result).toMatch(
          /^claude-code runs Anthropic models by their plain id\. openrouter\/x-ai\/grok-4\.6 is a gateway model/,
        );
      }));

    it("refuses before the job takes a slot", () =>
      refused((workflow) => {
        expect(workflow.store.jobs()).toHaveLength(0);
      }));
  });

  describe("a stage the config does not have, with no plan set", () => {
    let result: string;
    const refused = scenario(freshWorkflow(), async (workflow) => {
      const { start_job } = startTools(workflow);
      result = toolText(await start_job.execute({ stage: "deploy", brief: "ship" }, call));
    });

    it("asks for a name from the config", () =>
      refused(() => {
        expect(result).toBe("Unknown stage deploy. Use a name from the config.");
      }));

    it("records no job", () =>
      refused((workflow) => {
        expect(workflow.store.jobs()).toHaveLength(0);
      }));
  });
});

function pullHost(merged: boolean): FakeCodeHost {
  return new FakeCodeHost({
    pulls: [pullRequest({ number: 1, merged, state: merged ? "closed" : "open" })],
    repositories: ["acme/app"],
  });
}

function pullJob(workflow: Workflow, seed: JobSeed = {}): void {
  seedJob(workflow, "j1", "t1", seed);
  workflow.store.updateTask("t1", { status: "in_review" });
  workflow.store.upsertArtifact({
    job_id: "j1",
    kind: "pull",
    external_url: "https://github.com/acme/app/pull/1",
    ref: { kind: "pull", repo: "acme/app", number: 1 },
  });
}

type Completion = { workflow: Workflow; result: string };

function completedPullJob(code: () => FakeCodeHost | null): Scenario<Completion> {
  return (run) =>
    plannedWorkflow(1, () => ({ code: code() }))(async (workflow) => {
      pullJob(workflow);
      const { complete_job } = startTools(workflow);
      const result = toolText(
        await complete_job.execute({ job_id: "j1", result: "shipped" }, call),
      );
      await run({ workflow, result });
    });
}

describe("complete_job", () => {
  describe("a job whose artifact the host says is accepted", () => {
    let code: FakeCodeHost;
    const completed = completedPullJob(() => {
      code = pullHost(true);
      return code;
    });

    it("says the job is done and the last planned stage is over", () =>
      completed(({ result }) => {
        expect(result).toMatch(
          /^Job j1 done\. That was the last planned stage\. Call finish_workflow/,
        );
      }));

    it("records the artifact as accepted", () =>
      completed(({ workflow }) => {
        expect(workflow.store.artifact("j1")?.status).toBe("accepted");
      }));

    it("marks the author done", () =>
      completed(({ workflow }) => {
        expect(workflow.store.requireTask("t1").status).toBe("done");
      }));

    it("asks the host about the artifact", () =>
      completed(() => {
        expect(code.argsOf("getPull")).toEqual([["acme/app", 1]]);
      }));
  });

  describe("a job whose artifact the host has not accepted", () => {
    const refused = completedPullJob(() => pullHost(false));

    it("refuses, and says what the host is waiting for", () =>
      refused(({ result }) => {
        expect(result).toMatch(
          /^The artifact of job j1 is drafted, and the host has not accepted it\./,
        );
      }));

    it("leaves the author in review", () =>
      refused(({ workflow }) => {
        expect(workflow.store.requireTask("t1").status).toBe("in_review");
      }));
  });

  describe("a job whose artifact the host cannot describe", () => {
    const refused = completedPullJob(() => null);

    it("refuses, since nothing says the host accepted it", () =>
      refused(({ result }) => {
        expect(result).toMatch(/the host has not accepted it\./);
      }));
  });

  describe("a document a person accepted in this turn", () => {
    let result: string;
    const completed = scenario(freshWorkflow(), async (workflow) => {
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Fix it",
          stages: ["design", "implement"],
          repo: "acme/app",
          page_parent: null,
          reason: "test",
        },
        call,
      );
      seedJob(workflow, "j1", "t1", { stage: "design" });
      workflow.store.updateTask("t1", { status: "in_review" });
      workflow.store.upsertArtifact({
        job_id: "j1",
        kind: "page",
        external_url: "https://notion.so/doc",
        ref: { kind: "issues" },
      });
      const { complete_job } = startTools(workflow, ["Ship it."]);
      result = toolText(
        await complete_job.execute({ job_id: "j1", result: "Dev said ship it." }, call),
      );
    });

    it("names the next stage of the plan", () =>
      completed(() => {
        expect(result).toBe(
          "Job j1 done. Next stage: implement. Call start_job with stage implement and a brief for it.",
        );
      }));

    it("gives the document to the humans without accepting it, since nobody merges one", () =>
      completed((workflow) => {
        expect(workflow.store.artifact("j1")?.status).toBe("ready");
      }));

    it("marks the author done", () =>
      completed((workflow) => {
        expect(workflow.store.requireTask("t1").status).toBe("done");
      }));
  });

  describe("a job on an issue, with slots left in its stage", () => {
    let result: string;
    const completed = scenario(plannedWorkflow(2), async (workflow) => {
      seedJob(workflow, "j1", "t1", { issue: ENG_1 });
      workflow.store.updateTask("t1", { status: "in_review" });
      const { complete_job } = startTools(workflow);
      result = toolText(await complete_job.execute({ job_id: "j1", result: "done" }, call));
    });

    it("leaves the stage open and counts the free slots", () =>
      completed(() => {
        expect(result).toBe(
          "Job j1 done. Stage implement stays open with 0 running and 2 free slots. Start the next ready issues, or move on when the tracker shows none left.",
        );
      }));
  });
});
