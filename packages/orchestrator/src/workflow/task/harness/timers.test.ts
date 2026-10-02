import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { LOST_SANDBOX_TEXT } from "./bridge";
import {
  fakeConnection,
  seedTask,
  sentMethods,
  type FakeRuntime,
  type FakeSocket,
} from "../../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../../test/scenario";
import { RECONNECT_CEILING_MS } from "./prompt-queue";
import {
  armKeepAlive,
  armWallClock,
  keepSandboxAlive,
  keepAliveSeconds,
  NUDGE_TEXT,
  onHelloTimeout,
  onNoProgress,
  onWallClock,
  touchProgress,
} from "./timers";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const ALARM = { task_id: TASK, generation: 1 };

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function longGone(): string {
  return new Date(Date.now() - RECONNECT_CEILING_MS - 5000).toISOString();
}

describe("touchProgress", () => {
  describe("progress inside the window the alarm already covers", () => {
    const touched = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, {}, { no_progress_schedule: "old", last_progress_at: secondsAgo(5) });
      return touchProgress(workflow, workflow.store.requireSandbox(TASK));
    });

    it("schedules no alarm", () =>
      touched((workflow) => {
        expect(workflow.alarms).toEqual([]);
      }));

    it("cancels no alarm", () =>
      touched((workflow) => {
        expect(workflow.cancelled).toEqual([]);
      }));

    describe("and then progress a window later", () => {
      const rescheduled = scenario(touched, async (workflow) => {
        workflow.store.updateSandbox(TASK, { last_progress_at: secondsAgo(60), nudged: 1 });
        await touchProgress(workflow, workflow.store.requireSandbox(TASK));
      });

      it("cancels the old alarm", () =>
        rescheduled((workflow) => {
          expect(workflow.cancelled).toEqual(["old"]);
        }));

      it("records the new alarm on the task", () =>
        rescheduled((workflow) => {
          const [alarm] = workflow.alarmsFor("onNoProgress");
          expect(workflow.store.requireSandbox(TASK).no_progress_schedule).toBe(alarm!.id);
        }));

      it("forgets the earlier nudge", () =>
        rescheduled((workflow) => {
          expect(workflow.store.requireSandbox(TASK).nudged).toBe(0);
        }));
    });
  });
});

const inFlight: Scenario<{ workflow: FakeRuntime; socket: FakeSocket }> = (run) =>
  freshRuntime(async (workflow) => {
    seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
    const socket = fakeConnection(TASK, 1);
    workflow.sockets.push(socket.connection);
    await run({ workflow, socket });
  });

describe("onNoProgress", () => {
  describe("a silent turn with the bridge connected", () => {
    const nudged = scenario(inFlight, ({ workflow }) => onNoProgress(workflow, ALARM));

    it("cancels the turn", () =>
      nudged(({ socket }) => {
        expect(sentMethods(socket)).toEqual(["session/cancel"]);
      }));

    it("queues a nudge", () =>
      nudged(({ workflow }) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([NUDGE_TEXT]);
      }));

    it("counts the nudge on the task", () =>
      nudged(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).nudged).toBe(1);
      }));

    describe("and then a second silence", () => {
      const restarted = scenario(nudged, ({ workflow }) => onNoProgress(workflow, ALARM));

      it("restarts the task in a fresh sandbox", () =>
        restarted(({ workflow }) => {
          expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`, `start ${TASK}`]);
        }));

      it("counts the restart and clears the nudge", () =>
        restarted(({ workflow }) => {
          expect(workflow.store.requireSandbox(TASK)).toMatchObject({ restarts: 1, nudged: 0 });
        }));
    });
  });

  describe("a second silence with no restarts left", () => {
    const givenUp = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1, restarts: 2 });
      workflow.sockets.push(fakeConnection(TASK, 1).connection);
      await onNoProgress(workflow, ALARM);
      await onNoProgress(workflow, ALARM);
    });

    it("fails the task", () =>
      givenUp((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
      }));

    it("drops the queued nudge", () =>
      givenUp((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("destroys the sandbox", () =>
      givenUp((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`]);
      }));
  });

  describe("a silent turn after the bridge went away", () => {
    const restarted = scenario(freshRuntime, async (workflow) => {
      seedTask(
        workflow,
        {},
        { session_id: "s1", prompt_in_flight: 1, bridge_closed_at: longGone() },
      );
      await onNoProgress(workflow, ALARM);
    });

    it("restarts the sandbox instead of nudging", () =>
      restarted((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`start ${TASK}`]);
      }));

    it("provisions the task on a new generation", () =>
      restarted((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "provisioning" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          generation: 2,
          prompt_in_flight: 0,
          nudged: 0,
        });
      }));

    it("queues the lost-sandbox prompt", () =>
      restarted((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([LOST_SANDBOX_TEXT]);
      }));

    it("logs why it restarted", () =>
      restarted((workflow) => {
        expect(workflow.lines).toContain(
          "bridge lost with a prompt in flight. restarting the sandbox.",
        );
      }));
  });
});

describe("armKeepAlive", () => {
  describe("the first arm on a task", () => {
    const armed = scenario(freshRuntime, (workflow) => {
      seedTask(workflow);
      return armKeepAlive(workflow, workflow.store.requireSandbox(TASK));
    });

    it("touches the sandbox at once", () =>
      armed((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`keepAlive ${TASK}`]);
      }));

    it("starts one alarm chain", () =>
      armed((workflow) => {
        expect(workflow.alarmsFor("keepSandboxAlive")).toHaveLength(1);
      }));

    describe("and a second arm on the same task", () => {
      const rearmed = scenario(armed, (workflow) =>
        armKeepAlive(workflow, workflow.store.requireSandbox(TASK)),
      );

      it("touches the sandbox again", () =>
        rearmed((workflow) => {
          expect(workflow.sandboxProvider.calls).toEqual([
            `keepAlive ${TASK}`,
            `keepAlive ${TASK}`,
          ]);
        }));

      it("keeps one alarm chain", () =>
        rearmed((workflow) => {
          expect(workflow.alarmsFor("keepSandboxAlive")).toHaveLength(1);
        }));
    });
  });
});

describe("keepSandboxAlive", () => {
  describe("a task with a prompt in flight", () => {
    const touched = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, {}, { prompt_in_flight: 1, keepalive_schedule: "k1" });
      await keepSandboxAlive(workflow, ALARM);
    });

    it("touches the sandbox", () =>
      touched((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`keepAlive ${TASK}`]);
      }));

    it("schedules the next touch a keep-alive interval away", () =>
      touched((workflow) => {
        expect(workflow.alarmsFor("keepSandboxAlive")[0]?.delay).toBe(keepAliveSeconds(workflow));
      }));

    it("records the next alarm on the task", () =>
      touched((workflow) => {
        const [next] = workflow.alarmsFor("keepSandboxAlive");
        expect(workflow.store.requireSandbox(TASK).keepalive_schedule).toBe(next!.id);
      }));

    describe("and then the turn ends", () => {
      const stopped = scenario(touched, async (workflow) => {
        workflow.store.updateSandbox(TASK, { prompt_in_flight: 0 });
        await keepSandboxAlive(workflow, ALARM);
      });

      it("touches the sandbox no further", () =>
        stopped((workflow) => {
          expect(workflow.sandboxProvider.calls).toHaveLength(1);
        }));

      it("schedules no further alarm", () =>
        stopped((workflow) => {
          expect(workflow.alarmsFor("keepSandboxAlive")).toHaveLength(1);
        }));

      it("forgets the alarm on the task", () =>
        stopped((workflow) => {
          expect(workflow.store.requireSandbox(TASK).keepalive_schedule).toBeNull();
        }));
    });
  });
});

describe("keepAliveSeconds", () => {
  it("fires three times per sleep window", () =>
    freshRuntime((workflow) => {
      const sleepAfterMs = workflow.config().orchestrator.sandbox.sleep_after;
      expect(keepAliveSeconds(workflow) * 3000).toBeGreaterThanOrEqual(sleepAfterMs);
      expect(keepAliveSeconds(workflow) * 1000).toBeLessThan(sleepAfterMs);
    }));
});

describe("armWallClock", () => {
  describe("a prompt to a task that holds the alarm of an earlier turn", () => {
    const armed = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, {}, { wall_schedule: "earlier" });
      return armWallClock(workflow, workflow.store.requireSandbox(TASK));
    });

    it("cancels the alarm of the earlier turn", () =>
      armed((workflow) => {
        expect(workflow.cancelled).toEqual(["earlier"]);
      }));

    it("records the new alarm on the task", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onWallClock");
        expect(workflow.store.requireSandbox(TASK).wall_schedule).toBe(alarm!.id);
      }));

    it("gives the turn the configured minutes", () =>
      armed((workflow) => {
        const minutes = workflow.config().orchestrator.task.timeouts.time_elapsed_minutes;
        expect(workflow.alarmsFor("onWallClock")[0]!.delay).toBe(minutes * 60);
      }));
  });
});

describe("onWallClock", () => {
  describe("a task whose turn ended before the alarm fired", () => {
    const idle = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { status: "in_review" }, { wall_schedule: "w1", prompt_in_flight: 0 });
      await onWallClock(workflow, { task_id: TASK });
    });

    it("leaves the task as it is", () =>
      idle((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("in_review");
        expect(workflow.posted).toEqual([]);
      }));
  });

  describe("a paused task whose turn is still in flight", () => {
    const paused = scenario(freshRuntime, async (workflow) => {
      seedTask(
        workflow,
        { paused_at: secondsAgo(60) },
        { wall_schedule: "w1", prompt_in_flight: 1 },
      );
      await onWallClock(workflow, { task_id: TASK });
    });

    it("leaves the task as it is", () =>
      paused((workflow) => {
        expect(workflow.store.requireTask(TASK).status).not.toBe("failed");
        expect(workflow.posted).toEqual([]);
      }));
  });

  describe("a task whose turn is still in flight at the limit", () => {
    const expired = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, {}, { wall_schedule: "w1", prompt_in_flight: 1 });
      await onWallClock(workflow, { task_id: TASK });
    });

    it("fails the task and forgets the alarm", () =>
      expired((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "failed" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ wall_schedule: null });
      }));

    it("tells the channels why", () =>
      expired((workflow) => {
        expect(workflow.posted).toEqual([
          {
            type: "failed",
            job_id: JOB,
            reason: `A turn ran longer than the limit of ${workflow.config().orchestrator.task.timeouts.time_elapsed_minutes} minutes.`,
          },
        ]);
      }));

    describe("and the alarm fires again on the finished task", () => {
      const again = scenario(expired, (workflow) => onWallClock(workflow, { task_id: TASK }));

      it("says nothing a second time", () =>
        again((workflow) => {
          expect(workflow.posted).toHaveLength(1);
        }));
    });
  });
});

describe("onHelloTimeout", () => {
  describe("a task still provisioning", () => {
    const restarted = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { status: "provisioning" }, { hello_schedule: "h1" });
      await onHelloTimeout(workflow, ALARM);
    });

    it("starts the task again in a fresh sandbox", () =>
      restarted((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`, `start ${TASK}`]);
      }));

    it("counts the restart on a new generation", () =>
      restarted((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "provisioning" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ generation: 2, restarts: 1 });
      }));

    it("records the new hello alarm on the task", () =>
      restarted((workflow) => {
        expect(workflow.store.requireSandbox(TASK).hello_schedule).toBe(
          workflow.alarmsFor("onHelloTimeout")[0]!.id,
        );
      }));

    it("logs why it restarted", () =>
      restarted((workflow) => {
        expect(workflow.lines).toContain(
          "The sandbox bridge never connected. restarting in a fresh sandbox.",
        );
      }));

    describe("and the alarm of the old generation fires", () => {
      const stale = scenario(restarted, (workflow) => onHelloTimeout(workflow, ALARM));

      it("leaves the task provisioning", () =>
        stale((workflow) => {
          expect(workflow.store.requireTask(TASK).status).toBe("provisioning");
        }));
    });

    describe("and every later generation stays silent too", () => {
      const givenUp = scenario(restarted, async (workflow) => {
        await onHelloTimeout(workflow, { task_id: TASK, generation: 2 });
        await onHelloTimeout(workflow, { task_id: TASK, generation: 3 });
      });

      it("fails the task", () =>
        givenUp((workflow) => {
          expect(workflow.store.requireTask(TASK).status).toBe("failed");
        }));

      it("says the bridge never connected", () =>
        givenUp((workflow) => {
          expect(workflow.posted).toEqual([
            {
              type: "failed",
              job_id: JOB,
              reason: expect.stringMatching(/^The sandbox bridge never connected/),
            },
          ]);
        }));

      it("destroys the sandbox after the second restart", () =>
        givenUp((workflow) => {
          expect(workflow.sandboxProvider.calls).toEqual([
            `destroy ${TASK}`,
            `start ${TASK}`,
            `destroy ${TASK}`,
            `start ${TASK}`,
            `destroy ${TASK}`,
          ]);
        }));
    });
  });

  describe("a task that already said hello", () => {
    const ignored = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow);
      await onHelloTimeout(workflow, ALARM);
    });

    it("leaves the task working and unrestarted", () =>
      ignored((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "working" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ restarts: 0 });
      }));

    it("leaves the sandbox alone", () =>
      ignored((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));
  });
});
