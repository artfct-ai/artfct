import { describe, expect, it } from "bun:test";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { seedEndedWorkflow, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario } from "../../../test/scenario";
import {
  armTurnWatchdog,
  disarmTurnWatchdog,
  HEADS_UP_SECONDS,
  HEADS_UP_TEXT,
  LOST_PLACE_TEXT,
  LOST_TURN_TEXT,
  onTurnHeadsUp,
  onTurnTimeout,
  resumeLostTurn,
  turnTimeoutText,
  type TurnStart,
} from "./watchdog";

const THREAD: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };
const ISSUE: ReplyTarget = { source: "tracker", session_id: "s1", issue_id: "i1" };
const MESSAGES = ["What is the status?"];
const FIRST_ROW = 7;
const LATER_ROW = 9;

function takeMessage(workflow: FakeRuntime): void {
  workflow.transcript.enqueue(MESSAGES[0]!, "message", {
    body: MESSAGES[0]!,
    links: [],
    reply_to: THREAD,
  });
  workflow.transcript.takeInbox();
}

async function workingThread(workflow: FakeRuntime): Promise<void> {
  workflow.postThroughChat();
  workflow.store.addReplyTarget(THREAD);
  workflow.store.addReplyTarget(ISSUE);
  await workflow.working("reading the board");
}

describe("turn watchdog", () => {
  describe("a turn with the watchdog armed", () => {
    const armed = scenario(freshRuntime, async (workflow) => {
      await armTurnWatchdog(workflow, FIRST_ROW);
    });

    it("returns the start it recorded", () =>
      freshRuntime(async (workflow) => {
        const start = await armTurnWatchdog(workflow, FIRST_ROW);
        const turn = workflow.store.agentTurn();
        expect(start).toEqual({
          startedAt: turn!.started_at,
          firstRow: FIRST_ROW,
          boardChanged: false,
        });
        expect(turn).toMatchObject({
          status: "running",
          first_row: FIRST_ROW,
          board_changed: false,
        });
      }));

    it("arms one alarm at the configured timeout", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onTurnTimeout");
        expect(alarm?.delay).toBe(workflow.config().orchestrator.turn_timeout_minutes * 60);
      }));

    it("carries the turn's start time on the alarm", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onTurnTimeout");
        expect(alarm?.payload).toEqual({ started_at: workflow.store.agentTurn()!.started_at });
      }));

    it("records the alarm id with the running turn", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onTurnTimeout");
        expect(workflow.store.agentTurn()!.watchdog_schedule).toBe(alarm!.id);
      }));

    describe("when the turn ends in time", () => {
      let armedAlarm = "";
      let stopped: boolean | undefined;
      const disarmed = scenario(armed, async (workflow) => {
        armedAlarm = workflow.alarmsFor("onTurnTimeout")[0]!.id;
        stopped = await disarmTurnWatchdog(workflow, workflow.store.agentTurn()!.started_at);
      });

      it("reports that it stopped the watchdog", () =>
        disarmed(() => {
          expect(stopped).toBe(true);
        }));

      it("cancels the alarm it armed", () =>
        disarmed((workflow) => {
          expect(workflow.cancelled).toEqual([armedAlarm]);
        }));

      it("deletes the turn record", () =>
        disarmed((workflow) => {
          expect(workflow.store.agentTurn()).toBeNull();
        }));

      it("tells nobody about the turn", () =>
        disarmed((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));
    });

    describe("when the alarm fires on a turn that still runs", () => {
      let startedAt = "";
      const fired = scenario(armed, async (workflow) => {
        startedAt = workflow.store.agentTurn()!.started_at;
        await onTurnTimeout(workflow, { started_at: startedAt });
      });

      it("reports the lost turn", () =>
        fired((workflow) => {
          const minutes = workflow.config().orchestrator.turn_timeout_minutes;
          expect(workflow.posted).toEqual([
            { type: "turn_failed", text: turnTimeoutText(minutes) },
          ]);
        }));

      it("deletes the turn record", () =>
        fired((workflow) => {
          expect(workflow.store.agentTurn()).toBeNull();
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
        await workingThread(workflow);
        const startedAt = workflow.store.agentTurn()!.started_at;
        seedEndedWorkflow(workflow, "cancelled");
        await onTurnTimeout(workflow, { started_at: startedAt });
      });

      it("stays silent", () =>
        firedOnFinished((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("takes the thread out of its working status", () =>
        firedOnFinished((workflow) => {
          expect(workflow.released).toEqual([null]);
          expect(workflow.chatSession).toBe("closed");
        }));

      it("deletes the turn record", () =>
        firedOnFinished((workflow) => {
          expect(workflow.store.agentTurn()).toBeNull();
        }));
    });

    describe("when the turn started a task in a chat thread and ended", () => {
      let next: TurnStart | undefined;
      const endedAfterABoardChange = scenario(armed, async (workflow) => {
        workflow.store.markTurnBoardChanged();
        await disarmTurnWatchdog(workflow, workflow.store.agentTurn()!.started_at);
        workflow.clock = workflow.now() + 1000;
        next = await armTurnWatchdog(workflow, LATER_ROW);
      });

      it("starts the next turn without the board change", () =>
        endedAfterABoardChange(() => {
          expect(next).toMatchObject({ firstRow: LATER_ROW, boardChanged: false });
        }));
    });
  });

  describe("an alarm for a turn that already ended", () => {
    let first = "";
    const staleAlarm = scenario(freshRuntime, async (workflow) => {
      first = (await armTurnWatchdog(workflow, FIRST_ROW)).startedAt;
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
        second = (await armTurnWatchdog(workflow, LATER_ROW)).startedAt;
        await onTurnTimeout(workflow, { started_at: first });
      });

      it("reports nothing", () =>
        laterTurn((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("leaves the later turn running", () =>
        laterTurn((workflow) => {
          expect(workflow.store.agentTurn()).toMatchObject({
            status: "running",
            started_at: second,
          });
        }));
    });
  });
});

describe("turn heads-up", () => {
  describe("a turn on a person's message", () => {
    const armed = scenario(freshRuntime, async (workflow) => {
      await workingThread(workflow);
      takeMessage(workflow);
      await armTurnWatchdog(workflow, FIRST_ROW);
    });

    it("arms the heads-up a minute in, with the turn's start time", () =>
      armed((workflow) => {
        const [alarm] = workflow.alarmsFor("onTurnHeadsUp");
        const turn = workflow.store.agentTurn()!;
        expect(alarm?.delay).toBe(HEADS_UP_SECONDS);
        expect(alarm?.payload).toEqual({ started_at: turn.started_at });
        expect(turn.heads_up_schedule).toBe(alarm!.id);
      }));

    it("keeps what the person wrote in the rows the turn took", () =>
      armed((workflow) => {
        expect(workflow.transcript.taken().map((row) => row.text)).toEqual(MESSAGES);
      }));

    describe("when the heads-up fires while the turn runs", () => {
      let startedAt = "";
      const fired = scenario(armed, async (workflow) => {
        startedAt = workflow.store.agentTurn()!.started_at;
        await onTurnHeadsUp(workflow, { started_at: startedAt });
      });

      it("tells the chat thread and no other target", () =>
        fired((workflow) => {
          expect(workflow.posted).toEqual([{ type: "info", text: HEADS_UP_TEXT }]);
        }));

      it("keeps the thread in its working status", () =>
        fired((workflow) => {
          expect(workflow.chatSession).toBe("processing");
        }));

      it("records that the heads-up is no longer armed", () =>
        fired((workflow) => {
          expect(workflow.store.agentTurn()!.heads_up_schedule).toBeNull();
        }));

      it("leaves the reply to the turn", () =>
        fired(async (workflow) => {
          expect(await disarmTurnWatchdog(workflow, startedAt)).toBe(true);
        }));
    });

    describe("when the turn ends in time", () => {
      let headsUpAlarm = "";
      const ended = scenario(armed, async (workflow) => {
        headsUpAlarm = workflow.alarmsFor("onTurnHeadsUp")[0]!.id;
        const startedAt = workflow.store.agentTurn()!.started_at;
        await disarmTurnWatchdog(workflow, startedAt);
        await onTurnHeadsUp(workflow, { started_at: startedAt });
      });

      it("cancels the heads-up", () =>
        ended((workflow) => {
          expect(workflow.cancelled).toContain(headsUpAlarm);
        }));

      it("deletes the rows the turn took and the turn record", () =>
        ended((workflow) => {
          expect(workflow.transcript.taken()).toEqual([]);
          expect(workflow.store.agentTurn()).toBeNull();
        }));

      it("posts nothing for a late heads-up", () =>
        ended((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));
    });

    describe("when a later turn armed the watchdog again", () => {
      let first = "";
      const laterTurn = scenario(armed, async (workflow) => {
        first = workflow.store.agentTurn()!.started_at;
        await disarmTurnWatchdog(workflow, first);
        workflow.clock = workflow.now() + 1000;
        takeMessage(workflow);
        await armTurnWatchdog(workflow, LATER_ROW);
        await onTurnHeadsUp(workflow, { started_at: first });
      });

      it("ignores the old turn's heads-up", () =>
        laterTurn((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));
    });

    describe("when the watchdog fires first", () => {
      let headsUpAlarm = "";
      const timedOut = scenario(armed, async (workflow) => {
        headsUpAlarm = workflow.alarmsFor("onTurnHeadsUp")[0]!.id;
        await onTurnTimeout(workflow, { started_at: workflow.store.agentTurn()!.started_at });
      });

      it("cancels the heads-up", () =>
        timedOut((workflow) => {
          expect(workflow.cancelled).toEqual([headsUpAlarm]);
        }));

      it("deletes the rows the turn took", () =>
        timedOut((workflow) => {
          expect(workflow.transcript.taken()).toEqual([]);
        }));
    });
  });

  describe("a turn nobody wrote to", () => {
    const unprompted = scenario(freshRuntime, async (workflow) => {
      await armTurnWatchdog(workflow, FIRST_ROW);
    });

    it("arms no heads-up", () =>
      unprompted((workflow) => {
        expect(workflow.alarmsFor("onTurnHeadsUp")).toEqual([]);
        expect(workflow.store.agentTurn()!.heads_up_schedule).toBeNull();
      }));
  });
});

describe("resumeLostTurn", () => {
  describe("a turn lost while a person waited", () => {
    let alarms: string[] = [];
    const lostTurn = scenario(freshRuntime, async (workflow) => {
      await workingThread(workflow);
      takeMessage(workflow);
      await armTurnWatchdog(workflow, FIRST_ROW);
      workflow.store.markTurnBoardChanged();
      alarms = workflow.alarms.map((alarm) => alarm.id);
      await resumeLostTurn(workflow);
    });

    it("tells the chat thread it picks the turn up again", () =>
      lostTurn((workflow) => {
        expect(workflow.posted).toEqual([{ type: "info", text: LOST_PLACE_TEXT }]);
      }));

    it("keeps the thread in its working status", () =>
      lostTurn((workflow) => {
        expect(workflow.chatSession).toBe("processing");
      }));

    it("leaves what the person wrote and the lost turn's rows for the resumed turn", () =>
      lostTurn((workflow) => {
        expect(workflow.transcript.taken().map((row) => row.text)).toEqual(MESSAGES);
        expect(workflow.store.agentTurn()).toMatchObject({ status: "lost", first_row: FIRST_ROW });
      }));

    it("cancels the watchdog and the heads-up", () =>
      lostTurn((workflow) => {
        expect(workflow.cancelled).toEqual(alarms);
        expect(workflow.store.agentTurn()).toMatchObject({
          watchdog_schedule: null,
          heads_up_schedule: null,
        });
      }));

    describe("when the resumed turn starts", () => {
      let resumedStart: TurnStart | undefined;
      const resumedTurn = scenario(lostTurn, async (workflow) => {
        workflow.clock = workflow.now() + 1000;
        resumedStart = await armTurnWatchdog(workflow, LATER_ROW);
      });

      it("keeps the lost turn's first row and board change", () =>
        resumedTurn(() => {
          expect(resumedStart).toMatchObject({ firstRow: FIRST_ROW, boardChanged: true });
        }));

      it("records the resumed turn as running", () =>
        resumedTurn((workflow) => {
          expect(workflow.store.agentTurn()).toMatchObject({
            status: "running",
            started_at: resumedStart!.startedAt,
            first_row: FIRST_ROW,
            board_changed: true,
          });
        }));
    });
  });

  describe("a turn the watchdog armed", () => {
    let armedAlarm = "";
    let startedAt = "";
    let resumed: boolean | undefined;
    const lostTurn = scenario(freshRuntime, async (workflow) => {
      startedAt = (await armTurnWatchdog(workflow, FIRST_ROW)).startedAt;
      armedAlarm = workflow.alarmsFor("onTurnTimeout")[0]!.id;
      resumed = await resumeLostTurn(workflow);
    });

    it("reports that it resumed the turn", () =>
      lostTurn(() => {
        expect(resumed).toBe(true);
      }));

    it("marks the turn lost without its alarm", () =>
      lostTurn((workflow) => {
        expect(workflow.store.agentTurn()).toMatchObject({
          status: "lost",
          watchdog_schedule: null,
        });
      }));

    it("cancels the alarm", () =>
      lostTurn((workflow) => {
        expect(workflow.cancelled).toEqual([armedAlarm]);
      }));

    it("wakes the agent with a note", () =>
      lostTurn((workflow) => {
        expect(workflow.notes).toEqual([{ text: `[note]\n${LOST_TURN_TEXT}`, wake: "blocked" }]);
      }));

    it("posts nothing when nobody waited on the turn", () =>
      lostTurn((workflow) => {
        expect(workflow.posted).toEqual([]);
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

  describe("a finished workflow that lost a turn nobody waited on", () => {
    let resumed: boolean | undefined;
    const finished = scenario(freshRuntime, async (workflow) => {
      await workingThread(workflow);
      workflow.transcript.enqueue("The author finished.", "blocked");
      workflow.transcript.takeInbox();
      await armTurnWatchdog(workflow, FIRST_ROW);
      seedEndedWorkflow(workflow, "done");
      resumed = await resumeLostTurn(workflow);
    });

    it("takes the thread out of its working status", () =>
      finished((workflow) => {
        expect(workflow.chatSession).toBe("closed");
        expect(workflow.posted).toEqual([]);
      }));

    it("deletes the rows the turn took and the turn record", () =>
      finished((workflow) => {
        expect(workflow.transcript.taken()).toEqual([]);
        expect(workflow.store.agentTurn()).toBeNull();
      }));

    it("reports that it resumed nothing", () =>
      finished(() => {
        expect(resumed).toBe(false);
      }));

    it("wakes nobody", () =>
      finished((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));
  });

  describe("a finished workflow that lost a turn a person waited on", () => {
    let resumed: boolean | undefined;
    const finished = scenario(freshRuntime, async (workflow) => {
      await workingThread(workflow);
      takeMessage(workflow);
      await armTurnWatchdog(workflow, FIRST_ROW);
      seedEndedWorkflow(workflow, "done");
      resumed = await resumeLostTurn(workflow);
    });

    it("resumes the turn", () =>
      finished((workflow) => {
        expect(resumed).toBe(true);
        expect(workflow.notes.map((note) => note.wake)).toEqual(["blocked"]);
      }));

    it("keeps the person's message for the resumed turn", () =>
      finished((workflow) => {
        expect(workflow.transcript.takenMessages().map((row) => row.text)).toEqual(MESSAGES);
      }));

    it("tells the thread it picks the turn up again", () =>
      finished((workflow) => {
        expect(workflow.posted).toEqual([{ type: "info", text: LOST_PLACE_TEXT }]);
      }));
  });
});
