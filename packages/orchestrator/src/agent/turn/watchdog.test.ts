import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario } from "../../../test/scenario";
import {
  armTurnWatchdog,
  disarmTurnWatchdog,
  LOST_TURN_TEXT,
  onTurnTimeout,
  resumeLostTurn,
  turnTimeoutText,
} from "./watchdog";

describe("turn watchdog", () => {
  describe("a turn with the watchdog armed", () => {
    const armed = scenario(freshRuntime, async (workflow) => {
      await armTurnWatchdog(workflow);
    });

    it("returns the start time it wrote to the state", () =>
      freshRuntime(async (workflow) => {
        expect(await armTurnWatchdog(workflow)).toBe(workflow.state.turn_started_at!);
      }));

    it("arms one alarm at the configured timeout", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onTurnTimeout");
        expect(alarm?.delay).toBe(workflow.config().orchestrator.turn_timeout_minutes * 60);
      }));

    it("carries the turn's start time on the alarm", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onTurnTimeout");
        expect(alarm?.payload).toEqual({ started_at: workflow.state.turn_started_at });
      }));

    it("holds the alarm id in the state", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onTurnTimeout");
        expect(workflow.state.turn_watchdog).toBe(alarm!.id);
      }));

    describe("when the turn ends in time", () => {
      let armedAlarm = "";
      let stopped: boolean | undefined;
      const disarmed = scenario(armed, async (workflow) => {
        armedAlarm = workflow.alarmsFor("onTurnTimeout")[0]!.id;
        stopped = await disarmTurnWatchdog(workflow, workflow.state.turn_started_at!);
      });

      it("reports that it stopped the watchdog", () =>
        disarmed(() => {
          expect(stopped).toBe(true);
        }));

      it("cancels the alarm it armed", () =>
        disarmed((workflow) => {
          expect(workflow.cancelled).toEqual([armedAlarm]);
        }));

      it("forgets the turn and its alarm", () =>
        disarmed((workflow) => {
          expect(workflow.state.turn_started_at).toBeNull();
          expect(workflow.state.turn_watchdog).toBeNull();
        }));

      it("tells nobody about the turn", () =>
        disarmed((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));
    });

    describe("when the alarm fires on a turn that still runs", () => {
      let startedAt = "";
      const fired = scenario(armed, async (workflow) => {
        startedAt = workflow.state.turn_started_at!;
        await onTurnTimeout(workflow, { started_at: startedAt });
      });

      it("reports the lost turn", () =>
        fired((workflow) => {
          const minutes = workflow.config().orchestrator.turn_timeout_minutes;
          expect(workflow.posted).toEqual([{ type: "info", text: turnTimeoutText(minutes) }]);
        }));

      it("forgets the turn", () =>
        fired((workflow) => {
          expect(workflow.state.turn_started_at).toBeNull();
        }));

      describe("when the late turn ends after that", () => {
        let stopped: boolean | undefined;
        const lateEnd = scenario(fired, async (workflow) => {
          stopped = await disarmTurnWatchdog(workflow, startedAt);
        });

        it("tells the late turn the watchdog already spoke", () =>
          lateEnd(() => {
            expect(stopped).toBe(false);
          }));

        it("says nothing more about the turn", () =>
          lateEnd((workflow) => {
            expect(workflow.posted).toHaveLength(1);
          }));
      });
    });

    describe("when the workflow finished while the turn was lost", () => {
      const firedOnFinished = scenario(armed, async (workflow) => {
        const startedAt = workflow.state.turn_started_at!;
        workflow.patchState({ status: "cancelled" });
        await onTurnTimeout(workflow, { started_at: startedAt });
      });

      it("stays silent", () =>
        firedOnFinished((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("forgets the turn", () =>
        firedOnFinished((workflow) => {
          expect(workflow.state.turn_started_at).toBeNull();
        }));
    });
  });

  describe("an alarm for a turn that already ended", () => {
    let first = "";
    const staleAlarm = scenario(freshRuntime, async (workflow) => {
      first = await armTurnWatchdog(workflow);
      await disarmTurnWatchdog(workflow, first);
      await onTurnTimeout(workflow, { started_at: first });
    });

    it("reports nothing", () =>
      staleAlarm((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    describe("once a later turn armed the watchdog again", () => {
      let second = "";
      const laterTurn = scenario(staleAlarm, async (workflow) => {
        workflow.clock = workflow.now() + 1000;
        second = await armTurnWatchdog(workflow);
        await onTurnTimeout(workflow, { started_at: first });
      });

      it("reports nothing", () =>
        laterTurn((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("leaves the later turn running", () =>
        laterTurn((workflow) => {
          expect(workflow.state.turn_started_at).toBe(second);
        }));
    });
  });
});

describe("resumeLostTurn", () => {
  describe("a turn the watchdog armed", () => {
    let armedAlarm = "";
    let startedAt = "";
    let resumed: boolean | undefined;
    const lostTurn = scenario(freshRuntime, async (workflow) => {
      startedAt = await armTurnWatchdog(workflow);
      armedAlarm = workflow.alarmsFor("onTurnTimeout")[0]!.id;
      resumed = await resumeLostTurn(workflow);
    });

    it("reports that it resumed the turn", () =>
      lostTurn(() => {
        expect(resumed).toBe(true);
      }));

    it("forgets the turn and its alarm", () =>
      lostTurn((workflow) => {
        expect(workflow.state.turn_started_at).toBeNull();
        expect(workflow.state.turn_watchdog).toBeNull();
      }));

    it("cancels the alarm", () =>
      lostTurn((workflow) => {
        expect(workflow.cancelled).toEqual([armedAlarm]);
      }));

    it("wakes the agent with a note", () =>
      lostTurn((workflow) => {
        expect(workflow.notes).toEqual([{ text: `[note]\n${LOST_TURN_TEXT}`, wake: "blocked" }]);
      }));

    it("logs the lost turn's start time", () =>
      lostTurn((workflow) => {
        expect(workflow.lines.at(-1)).toContain(startedAt);
      }));

    describe("when the stale alarm fires after that", () => {
      const staleAlarm = scenario(lostTurn, async (workflow) => {
        await onTurnTimeout(workflow, { started_at: startedAt });
      });

      it("finds nothing to report", () =>
        staleAlarm((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));
    });
  });

  describe("a workflow between turns", () => {
    let resumed: boolean | undefined;
    const idle = scenario(freshRuntime, async (workflow) => {
      resumed = await resumeLostTurn(workflow);
    });

    it("reports that it resumed nothing", () =>
      idle(() => {
        expect(resumed).toBe(false);
      }));

    it("wakes nobody", () =>
      idle((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));

    it("cancels no alarm", () =>
      idle((workflow) => {
        expect(workflow.cancelled).toEqual([]);
      }));
  });

  describe("a finished workflow whose turn was lost", () => {
    let resumed: boolean | undefined;
    const finished = scenario(freshRuntime, async (workflow) => {
      await armTurnWatchdog(workflow);
      workflow.patchState({ status: "done" });
      resumed = await resumeLostTurn(workflow);
    });

    it("reports that it resumed nothing", () =>
      finished(() => {
        expect(resumed).toBe(false);
      }));

    it("forgets the turn", () =>
      finished((workflow) => {
        expect(workflow.state.turn_started_at).toBeNull();
      }));

    it("wakes nobody", () =>
      finished((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));
  });
});
