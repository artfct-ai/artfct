import type { CommitChecks } from "@artfct-ai/adapters/code/types";
import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import { describe, expect, it } from "bun:test";
import {
  patchStagePolishers,
  patchStageReviewers,
  seedPullRequestTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import {
  CHECKS_GRACE_MS,
  CHECKS_LIMIT_MS,
  CHECKS_QUIET_MS,
  RECHECK_SECONDS,
  checksGate,
  type ChecksGate,
} from "./checks-gate";
import { recheckChecks, settleChecks } from "./checks-recheck";
import { settleRefinersForAuthor, startRefiner } from "./loop";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const REVISION = "abc123";
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const ALARM = { job_id: JOB };
const PASSED: CommitChecks = { state: "passed", settled_at: new Date(0).toISOString() };
const UNIT_FAILED = { name: "unit", conclusion: "failure", detail: "", url: null };
const DEPLOY_CANCELLED = { name: "deploy", conclusion: "cancelled", detail: "", url: null };

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function hostWith(checks: CommitChecks, mergeable: boolean | null = true): FakeCodeHost {
  return new FakeCodeHost({
    pulls: [
      pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: REVISION }, mergeable }),
    ],
    commitChecks: { [REVISION]: checks },
  });
}

function seeded(checks: CommitChecks, mergeable: boolean | null = true): Scenario<FakeRuntime> {
  return scenario(freshRuntime, (workflow) => {
    workflow.clock = NOW;
    workflow.codeHostInstance = hostWith(checks, mergeable);
    seedQuietAuthor(workflow);
  });
}

function seedQuietAuthor(workflow: FakeRuntime): void {
  seedPullRequestTask(workflow);
  workflow.store.updateSandbox(TASK, { last_progress_at: at(0) });
}

function gateOf(workflow: FakeRuntime): Promise<ChecksGate> {
  const artifact = workflow.store.artifact(JOB);
  if (!artifact) throw new Error("the job has no artifact");
  return checksGate(workflow, workflow.store.requireTask(TASK), artifact);
}

function recheckAlarms(workflow: FakeRuntime) {
  return workflow.alarms.filter((alarm) => alarm.method === "recheckChecks");
}

describe("checksGate", () => {
  describe("checks that passed a while ago", () => {
    const passed = seeded({ state: "passed", settled_at: at(-CHECKS_QUIET_MS) });

    it("opens", () =>
      passed(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "open" });
      }));

    it("schedules no recheck", () =>
      passed(async (workflow) => {
        await gateOf(workflow);
        expect(recheckAlarms(workflow)).toEqual([]);
      }));
  });

  describe("checks that passed a moment ago", () => {
    const fresh = seeded({ state: "passed", settled_at: at(-1000) });

    it("waits, so a pipeline the pass starts can report", () =>
      fresh(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "waiting" });
      }));

    it("starts one recheck alarm however often the gate is read", () =>
      fresh(async (workflow) => {
        await gateOf(workflow);
        await gateOf(workflow);
        expect(recheckAlarms(workflow)).toMatchObject([{ delay: RECHECK_SECONDS, payload: ALARM }]);
      }));
  });

  describe("a revision no check reported on", () => {
    const silent = seeded({ state: "unreported" });

    it("waits through the grace period", () =>
      silent(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "waiting" });
      }));

    it("opens once the grace period is over", () =>
      silent(async (workflow) => {
        await gateOf(workflow);
        workflow.clock = NOW + CHECKS_GRACE_MS;
        expect(await gateOf(workflow)).toEqual({ gate: "open" });
      }));

    it("stops the recheck alarm when it opens", () =>
      silent(async (workflow) => {
        await gateOf(workflow);
        workflow.clock = NOW + CHECKS_GRACE_MS;
        await gateOf(workflow);
        expect(recheckAlarms(workflow)).toEqual([]);
      }));

    it("measures the grace period from the last work of the task that pushed", () =>
      silent(async (workflow) => {
        workflow.store.updateSandbox(TASK, { last_progress_at: at(-CHECKS_GRACE_MS) });
        expect(await gateOf(workflow)).toEqual({ gate: "open" });
      }));
  });

  describe("checks that still run", () => {
    const running = seeded({ state: "running" });

    it("waits", () =>
      running(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "waiting" });
      }));

    it("blocks once they outlast the limit", () =>
      running(async (workflow) => {
        await gateOf(workflow);
        workflow.clock = NOW + CHECKS_LIMIT_MS;
        expect(await gateOf(workflow)).toEqual({
          gate: "blocked",
          reason: "The checks did not finish within 120 minutes.",
        });
      }));
  });

  describe("checks the host cannot give", () => {
    const unreadable = scenario(freshRuntime, (workflow) => {
      workflow.clock = NOW;
      workflow.codeHostInstance = new UnreadableChecks();
      seedQuietAuthor(workflow);
    });

    it("waits as if they still ran", () =>
      unreadable(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "waiting" });
      }));
  });

  describe("failed checks", () => {
    const failed = seeded({ state: "failed", failures: [UNIT_FAILED] });

    it("go back to the task that pushed the revision", () =>
      failed(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "sent_back" });
        expect(workflow.store.queue()).toMatchObject([
          { task_id: TASK, text: expect.stringContaining("- unit: failure") },
        ]);
      }));

    it("go back once per revision", () =>
      failed(async (workflow) => {
        await gateOf(workflow);
        expect(await gateOf(workflow)).toEqual({ gate: "waiting" });
        expect(workflow.store.queue()).toHaveLength(1);
      }));

    it("block the artifact when the quiet task already answered them", () =>
      failed(async (workflow) => {
        workflow.store.markEventSeen({ id: `checks_failed:${JOB}:${REVISION}`, kind: "ci_event" });
        expect(await gateOf(workflow)).toEqual({
          gate: "blocked",
          reason: `The checks still fail after ${TASK} answered them: unit (failure).`,
        });
      }));
  });

  describe("a revision that conflicts with its base branch", () => {
    const conflicted = seeded(PASSED, false);

    it("goes back to the task that pushed it, to merge the base branch in", () =>
      conflicted(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "sent_back" });
        expect(workflow.store.queue()).toMatchObject([
          { task_id: TASK, text: expect.stringContaining("merge it into your branch") },
        ]);
      }));

    it("goes back once per revision", () =>
      conflicted(async (workflow) => {
        await gateOf(workflow);
        expect(await gateOf(workflow)).toEqual({ gate: "waiting" });
        expect(workflow.store.queue()).toHaveLength(1);
      }));

    it("blocks the artifact when the quiet task already answered it", () =>
      conflicted(async (workflow) => {
        workflow.store.markEventSeen({ id: `conflicted:${JOB}:${REVISION}`, kind: "pr_event" });
        expect(await gateOf(workflow)).toEqual({
          gate: "blocked",
          reason: `The artifact still conflicts with main after ${TASK} answered the conflict.`,
        });
      }));
  });

  describe("a merge the host has not worked out", () => {
    const unknown = seeded(PASSED, null);

    it("waits and reads again", () =>
      unknown(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "waiting" });
        expect(recheckAlarms(workflow)).toHaveLength(1);
      }));
  });

  describe("checks that stopped for a reason a code change does not fix", () => {
    const stopped = seeded({ state: "stopped", failures: [DEPLOY_CANCELLED] });

    it("block the artifact and go to nobody", () =>
      stopped(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({
          gate: "blocked",
          reason: "The checks stopped in a way a code change does not fix: deploy (cancelled).",
        });
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("an artifact kind on a host that cannot name the revision", () => {
    const hostless = scenario(freshRuntime, (workflow) => {
      seedPullRequestTask(workflow);
    });

    it("opens", () =>
      hostless(async (workflow) => {
        expect(await gateOf(workflow)).toEqual({ gate: "open" });
      }));
  });
});

class UnreadableChecks extends FakeCodeHost {
  constructor() {
    super({
      pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: REVISION } })],
    });
  }

  override async commitChecks(): Promise<CommitChecks> {
    throw new Error("github GET /commits/abc123/check-runs: 403 Forbidden");
  }
}

describe("settleRefinersForAuthor behind the checks gate", () => {
  describe("while the checks run", () => {
    const held = scenario(seeded({ state: "running" }), async (workflow) => {
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
    });

    it("starts no reviewer", () =>
      held((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toEqual([]);
      }));

    it("keeps the artifact a draft", () =>
      held((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));
  });

  describe("once the checks stopped", () => {
    const blocked = scenario(
      seeded({ state: "stopped", failures: [DEPLOY_CANCELLED] }),
      async (workflow) => {
        await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
      },
    );

    it("hands the artifact to the humans with the reason", () =>
      blocked((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
        expect(workflow.posted).toMatchObject([
          { type: "artifact_ready", text: expect.stringContaining("deploy (cancelled)") },
        ]);
      }));
  });
});

function waitingOn(checks: Record<string, CommitChecks>): Scenario<FakeRuntime> {
  return scenario(freshRuntime, async (workflow) => {
    workflow.clock = NOW;
    workflow.codeHostInstance = new FakeCodeHost({
      pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: REVISION } })],
      commitChecks: checks,
    });
    seedQuietAuthor(workflow);
    await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
  });
}

describe("recheckChecks", () => {
  describe("while the checks still run", () => {
    const running = waitingOn({ [REVISION]: { state: "running" } });

    it("keeps its one alarm", () =>
      running(async (workflow) => {
        await recheckChecks(workflow, ALARM);
        expect(recheckAlarms(workflow)).toMatchObject([{ delay: RECHECK_SECONDS, payload: ALARM }]);
      }));
  });

  describe("once the checks passed and stood", () => {
    const passed = scenario(freshRuntime, async (workflow) => {
      const answers: Record<string, CommitChecks> = { [REVISION]: { state: "running" } };
      workflow.clock = NOW;
      workflow.codeHostInstance = new FakeCodeHost({
        pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: REVISION } })],
        commitChecks: answers,
      });
      seedQuietAuthor(workflow);
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
      answers[REVISION] = { state: "passed", settled_at: at(0) };
      workflow.clock = NOW + CHECKS_QUIET_MS;
      await recheckChecks(workflow, ALARM);
    });

    it("starts the first reviewer", () =>
      passed((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
      }));

    it("stops the recheck alarm", () =>
      passed((workflow) => {
        expect(recheckAlarms(workflow)).toEqual([]);
      }));
  });

  describe("an artifact the humans took while it waited", () => {
    const taken = waitingOn({ [REVISION]: { state: "running" } });

    it("stops the recheck alarm", () =>
      taken(async (workflow) => {
        workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
        await recheckChecks(workflow, ALARM);
        expect(recheckAlarms(workflow)).toEqual([]);
      }));
  });

  describe("a workflow that finished while the host worked the merge out", () => {
    const finished = scenario(heldByHumans(null), async (workflow) => {
      workflow.patchState({ status: "cancelled" });
      workflow.store.updateTask(TASK, { status: "cancelled" });
      workflow.codeHostInstance = hostWith(PASSED, false);
      await recheckChecks(workflow, ALARM);
    });

    it("stops the recheck alarm", () =>
      finished((workflow) => {
        expect(recheckAlarms(workflow)).toEqual([]);
      }));

    it("tells nobody of the conflict", () =>
      finished((workflow) => {
        expect(workflow.notes).toEqual([]);
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("an artifact the host accepted while it waited", () => {
    const accepted = waitingOn({ [REVISION]: { state: "running" } });

    it("stops the recheck alarm without reading the host", () =>
      accepted(async (workflow) => {
        const host = workflow.codeHostInstance;
        if (!(host instanceof FakeCodeHost)) throw new Error("the runtime has no fake code host");
        const readsBefore = host.argsOf("commitChecks").length;
        workflow.store.advanceArtifact(JOB, ["drafted"], "accepted");
        await recheckChecks(workflow, ALARM);
        expect(host.argsOf("commitChecks")).toHaveLength(readsBefore);
        expect(recheckAlarms(workflow)).toEqual([]);
      }));
  });
});

function heldByHumans(mergeable: boolean | null): Scenario<FakeRuntime> {
  return scenario(freshRuntime, async (workflow) => {
    workflow.clock = NOW;
    workflow.codeHostInstance = hostWith(PASSED, mergeable);
    seedQuietAuthor(workflow);
    workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
    await settleChecks(workflow, JOB);
  });
}

describe("settleChecks outside the gate", () => {
  describe("an artifact the humans hold that conflicts with its base branch", () => {
    const conflicted = heldByHumans(false);

    it("goes to the idle author", () =>
      conflicted((workflow) => {
        expect(workflow.store.queue()).toMatchObject([
          { task_id: TASK, text: expect.stringContaining("Do not rebase") },
        ]);
      }));

    it("goes to the author once per revision", () =>
      conflicted(async (workflow) => {
        await settleChecks(workflow, JOB);
        expect(workflow.store.queue()).toHaveLength(1);
      }));
  });

  describe("a conflict on an artifact whose author is cancelled", () => {
    const orphaned = scenario(freshRuntime, async (workflow) => {
      workflow.clock = NOW;
      workflow.codeHostInstance = hostWith(PASSED, false);
      seedQuietAuthor(workflow);
      workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
      workflow.store.updateTask(TASK, { status: "cancelled" });
      await settleChecks(workflow, JOB);
      await settleChecks(workflow, JOB);
    });

    it("goes to the agent once, to tell the humans", () =>
      orphaned((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.notes).toMatchObject([
          { text: expect.stringContaining(`${TASK} is cancelled`), wake: "external_state" },
        ]);
      }));
  });

  describe("an artifact the humans hold whose merge the host has not worked out", () => {
    const unknown = heldByHumans(null);

    it("starts the recheck alarm", () =>
      unknown((workflow) => {
        expect(recheckAlarms(workflow)).toMatchObject([{ payload: ALARM }]);
      }));

    it("stops the alarm and prompts nobody once the host says it merges", () =>
      unknown(async (workflow) => {
        workflow.codeHostInstance = hostWith(PASSED);
        await recheckChecks(workflow, ALARM);
        expect(recheckAlarms(workflow)).toEqual([]);
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("a conflict that appears while a reviewer reads the artifact", () => {
    const reviewing = scenario(freshRuntime, async (workflow) => {
      workflow.clock = NOW;
      workflow.codeHostInstance = hostWith(PASSED);
      seedQuietAuthor(workflow);
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
      workflow.codeHostInstance = hostWith(PASSED, false);
      await settleChecks(workflow, JOB);
    });

    it("goes to the idle author while the reviewer runs", () =>
      reviewing((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
        expect(workflow.store.queue()).toMatchObject([
          { task_id: TASK, text: expect.stringContaining("conflicts with its base branch main") },
        ]);
      }));
  });
});

describe("settleChecks on a polisher whose turn has not run", () => {
  const polisherId = "wf_x.2";
  const pending = scenario(freshRuntime, async (workflow) => {
    workflow.clock = NOW;
    workflow.codeHostInstance = hostWith({ state: "stopped", failures: [DEPLOY_CANCELLED] });
    patchStageReviewers(workflow, []);
    patchStagePolishers(workflow, [{ name: "comments", skill: "technical-writer" }]);
    seedQuietAuthor(workflow);
    await startRefiner(workflow, workflow.store.requireTask(TASK), 0);
  });

  for (const status of ["queued", "provisioning"] as const) {
    it(`leaves a ${status} polisher to run its turn`, () =>
      pending(async (workflow) => {
        workflow.store.updateTask(polisherId, { status });
        await settleChecks(workflow, JOB);
        expect(workflow.store.requireTask(polisherId).status).toBe(status);
        expect(workflow.store.artifact(JOB)).toMatchObject({
          status: "drafted",
          refiner_task_id: polisherId,
        });
      }));
  }

  it("leaves a polisher whose harness session opens to run its turn", () =>
    pending(async (workflow) => {
      workflow.store.updateTask(polisherId, { status: "working" });
      workflow.store.insertRpc(polisherId, "initialize", "initialize");
      await settleChecks(workflow, JOB);
      expect(workflow.store.requireTask(polisherId).status).toBe("working");
      expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
    }));

  it("blocks the artifact once the polisher's turn is over", () =>
    pending(async (workflow) => {
      workflow.store.updateTask(polisherId, { status: "working" });
      await settleChecks(workflow, JOB);
      expect(workflow.store.requireTask(polisherId).status).toBe("done");
      expect(workflow.store.artifact(JOB)?.status).toBe("ready");
    }));
});
