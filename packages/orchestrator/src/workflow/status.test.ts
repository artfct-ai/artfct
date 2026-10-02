import type { WorkflowSummary } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../test/fresh-runtime";
import { patchModelExecution, seedModelAuthor, seedTask } from "../../test/fake-runtime";
import { scenario } from "../../test/scenario";
import { debugDump, statusText, summarize } from "./status";

const TASK = "wf_x.1";
const JOB = "wf_x-1";

const summary: WorkflowSummary = {
  workflow_id: "wf_x",
  status: "running",
  stages: ["implement"],
  jobs: [
    {
      job_id: "wf_x-1",
      stage: "implement",
      status: "in_review",
      harness: "opencode",
      branch: null,
      issue: "ENG-1",
      cost_usd: 0.5,
      artifact: {
        kind: "pull",
        url: "https://github.com/acme/app/pull/1",
        status: "drafted",
      },
    },
    {
      job_id: "wf_x-2",
      stage: "implement",
      status: "working",
      harness: "opencode",
      branch: null,
      issue: null,
      cost_usd: 0.1,
      artifact: null,
    },
  ],
  concurrency: 3,
  cost_usd: 1.25,
  repo: { full: "acme/app" },
  reason: "default",
};

describe("statusText", () => {
  describe("a running workflow with two jobs", () => {
    it("renders one line per fact and per job", () => {
      expect(statusText(summary).split("\n")).toEqual([
        "Workflow wf_x: running",
        "Plan: implement",
        "Job wf_x-1 (ENG-1) [implement]: in_review, https://github.com/acme/app/pull/1 (drafted)",
        "Job wf_x-2 [implement]: working",
        "Cost so far: $1.25",
      ]);
    });
  });

  describe("a workflow with no job yet", () => {
    const text = statusText({ ...summary, jobs: [], stages: [] });

    it("says the plan is none", () => {
      expect(text).toContain("Plan: none");
    });

    it("says the jobs are none", () => {
      expect(text).toContain("Jobs: none");
    });
  });
});

describe("summarize", () => {
  describe("one job in review and one done", () => {
    const summarized = scenario(freshRuntime, (workflow) => {
      workflow.patchState({
        stages: ["design", "implement"],
        concurrency: 2,
        repo: { full: "acme/app" },
        reason: "default",
      });
      workflow.store.recordModelUsage({
        purpose: "orchestrator",
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0.75,
      });
      seedTask(workflow, {
        stage: "implement",
        status: "in_review",
        branch: "artfct/wf_x-1-fix",
        issue_key: "ENG-1",
        cost_usd: 0.5,
      });
      workflow.store.upsertArtifact({
        job_id: JOB,
        kind: "pull",
        external_url: "https://github.com/acme/app/pull/1",
        ref: { kind: "pull", repo: "acme/app", number: 1 },
      });
      seedTask(workflow, { task_id: "wf_x.2", status: "done" });
    });

    it("reports the stage, the active job with its artifact, and the cost", () =>
      summarized((workflow) => {
        expect(summarize(workflow)).toEqual({
          workflow_id: "wf_x",
          status: "running",
          stages: ["design", "implement"],
          jobs: [
            {
              job_id: JOB,
              stage: "implement",
              status: "in_review",
              harness: "opencode",
              branch: "artfct/wf_x-1-fix",
              issue: "ENG-1",
              cost_usd: 0.5,
              artifact: {
                kind: "pull",
                url: "https://github.com/acme/app/pull/1",
                status: "drafted",
              },
            },
          ],
          concurrency: 2,
          cost_usd: 1.25,
          repo: { full: "acme/app" },
          reason: "default",
        });
      }));
  });
});

describe("summarize a job whose researcher finished and whose author runs", () => {
  const authoring = scenario(freshRuntime, (workflow) => {
    seedTask(workflow, { stage: "implement", status: "done", cost_usd: 0.25 });
    workflow.store.updateTask(TASK, { role: "researcher" });
    workflow.store.insertTask({
      task_id: "wf_x.2",
      job_id: JOB,
      role: "author",
      sandbox: { harness: "opencode", bridge_token: "tok" },
      model: "mock",
    });
    workflow.store.updateTask("wf_x.2", { status: "working", cost_usd: 0.5 });
  });

  it("reports the author with the cost of the researcher and the author", () =>
    authoring((workflow) => {
      const [job] = summarize(workflow).jobs;
      expect(job).toMatchObject({ job_id: JOB, status: "working", cost_usd: 0.75 });
    }));
});

describe("summarize a job whose author runs as a model call", () => {
  it("reports no harness", () =>
    freshRuntime((workflow) => {
      patchModelExecution(workflow);
      seedModelAuthor(workflow);
      expect(summarize(workflow).jobs[0]).toMatchObject({ job_id: JOB, harness: null });
    }));
});

describe("debugDump", () => {
  describe("a task with a queued prompt, a log line, and a transcript note", () => {
    const dumped = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, {}, { bridge_token: "very-secret" });
      workflow.store.enqueuePrompt(TASK, "later");
      workflow.log(TASK, "hello");
      workflow.transcript.enqueue("[note]\nqueued", "none");
    });

    it("dumps every table", () =>
      dumped((workflow) => {
        expect(Object.keys(debugDump(workflow)).toSorted()).toEqual([
          "artifacts",
          "boards",
          "connections",
          "inbox",
          "jobs",
          "log",
          "model_usage",
          "outbox",
          "queue",
          "state",
          "tasks",
          "todos",
          "transcript",
        ]);
      }));

    it("dumps the workflow state", () =>
      dumped((workflow) => {
        expect(debugDump(workflow).state.workflow_id).toBe("wf_x");
      }));

    it("masks the bridge token", () =>
      dumped((workflow) => {
        const dump = debugDump(workflow);
        expect(dump.tasks.map((task) => [task.task_id, task.sandbox?.bridge_token])).toEqual([
          [TASK, "***"],
        ]);
        expect(JSON.stringify(dump)).not.toContain("very-secret");
      }));

    it("dumps the queued prompt", () =>
      dumped((workflow) => {
        expect(debugDump(workflow).queue.map((row) => row.text)).toEqual(["later"]);
      }));

    it("dumps the log line", () =>
      dumped((workflow) => {
        expect(debugDump(workflow).log.map((row) => row.line)).toEqual(["hello"]);
      }));

    it("dumps the transcript note", () =>
      dumped((workflow) => {
        expect(debugDump(workflow).inbox.map((row) => row.text)).toEqual(["[note]\nqueued"]);
      }));

    it("dumps the empty tables and the open connections", () =>
      dumped((workflow) => {
        expect(debugDump(workflow)).toMatchObject({ artifacts: [], outbox: [], connections: 0 });
      }));
  });
});
