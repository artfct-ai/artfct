import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Workflow } from "../../workflow";
import { ScriptedFailure, type Action } from "../../../test/fake-model";
import type { Scenario } from "../../../test/scenario";
import { ACK_TEXT } from "../../../test/scripted-model";
import { testServices } from "../../../test/worker";
import { STUCK_TEXT, UNANSWERED_TEXT } from "./turn";
import { LOST_PLACE_TEXT, LOST_TURN_TEXT } from "./watchdog";

const start: InboundEvent = {
  id: "evt-start",
  kind: "start",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "fix the flaky test",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
};

type Debug = {
  state: {
    status: string;
    turn_started_at: string | null;
    turn_watchdog: string | null;
    turn_messages: string[];
  };
  log: Array<{ line: string }>;
  outbox: Array<{ kind: string; payload: { text?: string } | null }>;
  transcript: Array<{ message: { role: string; content: unknown } }>;
  inbox: Array<{ text: string }>;
};

function unansweredNotes(debug: Debug): number {
  return debug.transcript.filter((row) =>
    JSON.stringify(row.message.content).includes(UNANSWERED_TEXT),
  ).length;
}

function heardText(debug: Debug): Array<string | undefined> {
  return debug.outbox.filter((entry) => entry.kind === "info").map((entry) => entry.payload?.text);
}

function noteLanded(debug: Debug): { inbox: boolean; transcript: boolean } {
  return {
    inbox: debug.inbox.some((row) => row.text === `[note]\n${LOST_TURN_TEXT}`),
    transcript: debug.transcript.some((row) =>
      JSON.stringify(row.message.content).includes(LOST_TURN_TEXT),
    ),
  };
}

const RESET = "Durable Object reset because its code was updated.";

let opened = 0;

function settledWorkflow(
  script: Action[] | null,
  act?: (workflow: Workflow) => Promise<unknown>,
): Scenario<Debug> {
  return async (run) => {
    opened += 1;
    const name = `wf_turn_${opened}`;
    const stub = env.Workflow.getByName(name);
    await runInDurableObject(stub, async (workflow: Workflow) => {
      if (script) {
        const model = new ScriptedFailure(script);
        workflow.services = { ...workflow.services, model: async () => model };
      }
      await workflow.create(name, start, null);
      await workflow.settle();
      if (act) {
        await act(workflow);
        await workflow.settle();
      }
      await run((await workflow.debug()) as Debug);
    });
  };
}

async function loseTurn() {
  opened += 1;
  const name = `wf_turn_${opened}`;
  const stub = env.Workflow.getByName(name);
  let debug!: Debug;
  await runInDurableObject(stub, async (workflow: Workflow) => {
    workflow.services = {
      ...workflow.services,
      model: async () => new ScriptedFailure(["throw", "throw"], RESET),
    };
    await workflow.create(name, start, null);
    await workflow.settle().catch(() => undefined);
    workflow.transcript.enqueue("[note]\nA task result arrived.", "task_result");
    await expect(workflow.runAgent()).rejects.toThrow(RESET);
    debug = (await workflow.debug()) as Debug;
  });
  return { stub, debug };
}

async function withNewInstanceModel(model: ScriptedFailure, act: () => Promise<void>) {
  const previous = testServices.model;
  testServices.model = async () => model;
  try {
    await act();
  } finally {
    testServices.model = previous;
  }
}

const lost: Scenario<Debug> = async (run) => {
  const { debug } = await loseTurn();
  await run(debug);
};

describe("agent turn", () => {
  describe("a silent turn", () => {
    const silent = settledWorkflow(null);

    it("ends the turn", () =>
      silent((debug) => {
        expect(debug.state.turn_started_at).toBeNull();
      }));

    it("disarms the watchdog", () =>
      silent((debug) => {
        expect(debug.state.turn_watchdog).toBeNull();
      }));

    it("releases the Slack session", () =>
      silent((debug) => {
        expect(debug.outbox.at(-1)?.kind).toBe("release");
      }));
  });

  describe("a turn woken by the harness, with no human message pending", () => {
    const woken = settledWorkflow(["text"], (workflow) =>
      workflow.tellAgent("[note]\nHarness turn ended.", "task_result"),
    );

    it("posts the model's text, as any other turn does", () =>
      woken((debug) => {
        expect(debug.outbox.map((entry) => entry.payload?.text)).toContain("done");
      }));
  });

  describe("a turn woken by the harness with nothing to say", () => {
    const woken = settledWorkflow(null, (workflow) =>
      workflow.tellAgent("[note]\nHarness turn ended.", "task_idle"),
    );

    it("ends the turn", () =>
      woken((debug) => {
        expect(debug.state.turn_started_at).toBeNull();
      }));

    it("releases the Slack session", () =>
      woken((debug) => {
        expect(debug.outbox.at(-1)?.kind).toBe("release");
      }));
  });

  describe("a message from a person, and a model that tries to stay silent", () => {
    const answered = settledWorkflow(["silent", "text"]);

    it("is not offered stay_silent, so the call fails", () =>
      answered((debug) => {
        expect(debug.log.some((entry) => entry.line.startsWith("agent: stay_silent failed"))).toBe(
          true,
        );
      }));

    it("posts the text the model wrote next", () =>
      answered((debug) => {
        expect(debug.outbox.map((entry) => entry.payload?.text)).toContain("done");
      }));
  });

  describe("a message from a person, and a model that ends with nothing for them", () => {
    const nudged = settledWorkflow(["empty", "text"]);

    it("asks the model once more, with a note that says so", () =>
      nudged((debug) => {
        expect(unansweredNotes(debug)).toBe(1);
      }));

    it("posts the text the model wrote next", () =>
      nudged((debug) => {
        expect(heardText(debug)).toContain("done");
      }));
  });

  describe("a message from a person, and a model with nothing for them twice", () => {
    const quiet = settledWorkflow(["empty", "empty"]);

    it("asks once and then lets the turn end", () =>
      quiet((debug) => {
        expect(unansweredNotes(debug)).toBe(1);
        expect(debug.state.turn_started_at).toBeNull();
      }));

    it("posts nothing", () =>
      quiet((debug) => {
        expect(heardText(debug)).toEqual([]);
      }));
  });

  describe("a message from a person, and a model that acknowledges twice", () => {
    const twice = settledWorkflow(["acknowledge", "acknowledge", "text"]);

    it("posts the first line and the closing text, not the second line", () =>
      twice((debug) => {
        expect(heardText(debug)).toEqual(["Got it.", "done"]);
      }));

    it("refuses the second line as a tool error", () =>
      twice((debug) => {
        expect(debug.log.some((entry) => entry.line.startsWith("agent: acknowledge failed"))).toBe(
          true,
        );
      }));
  });

  describe("a turn woken by the harness, and a model that acknowledges", () => {
    const woken = settledWorkflow(["text", "acknowledge", "text"], (workflow) =>
      workflow.tellAgent("[note]\nHarness turn ended.", "task_result"),
    );

    it("is not offered acknowledge, so the call fails", () =>
      woken((debug) => {
        expect(debug.log.some((entry) => entry.line.startsWith("agent: acknowledge failed"))).toBe(
          true,
        );
      }));

    it("posts the answer to the person and keeps the woken turn's closing text off the channels", () =>
      woken((debug) => {
        expect(heardText(debug)).toEqual(["done"]);
      }));

    it("logs the text it did not post", () =>
      woken((debug) => {
        expect(
          debug.log.some((entry) => entry.line.startsWith("closing text not posted, nobody wrote")),
        ).toBe(true);
      }));
  });

  describe("a turn woken by the harness, and a model that tells the humans", () => {
    const told = settledWorkflow(["text", "tell"], (workflow) =>
      workflow.tellAgent("[note]\nHarness turn ended.", "task_result"),
    );

    it("posts what the model told them, and ends the turn there", () =>
      told((debug) => {
        expect(heardText(debug)).toEqual(["done", "The harness is stuck."]);
      }));
  });

  describe("a person's turn, and a model that calls tell", () => {
    const refused = settledWorkflow(["tell", "text"]);

    it("is not offered tell, so the call fails and the closing text is the reply", () =>
      refused((debug) => {
        expect(heardText(debug)).toEqual(["done"]);
      }));
  });

  describe("a model that fails twice", () => {
    const stuck = settledWorkflow(["throw", "throw"]);

    it("tells the humans to retry", () =>
      stuck((debug) => {
        expect(debug.outbox.map((entry) => entry.payload?.text)).toContain(STUCK_TEXT);
      }));

    it("ends the turn", () =>
      stuck((debug) => {
        expect(debug.state.turn_started_at).toBeNull();
      }));
  });

  describe("a request that names no repository", () => {
    const asked = settledWorkflow(null);

    it("stays in planning while it waits for the answer", () =>
      asked((debug) => {
        expect(debug.state.status).toBe("planning");
      }));

    it("acknowledges the request first, then asks its question", () =>
      asked((debug) => {
        const heard = debug.outbox.filter(
          (entry) => entry.kind === "info" || entry.kind === "question",
        );
        expect(heard.map((entry) => entry.kind)).toEqual(["info", "question"]);
        expect(heard[0]?.payload?.text).toBe(ACK_TEXT);
      }));

    it("shows each step as a status line, not as a message", () =>
      asked((debug) => {
        const working = debug.outbox.filter((entry) => entry.kind === "working");
        expect(working.map((entry) => entry.payload?.text)).toEqual([
          "Step 1: acknowledge",
          "Step 2: ask",
        ]);
      }));

    it("stores the calls and their results, since the turn ends with no text", () =>
      asked((debug) => {
        expect(debug.transcript.map((row) => row.message.role)).toEqual([
          "user",
          "assistant",
          "tool",
          "assistant",
          "tool",
        ]);
      }));
  });

  describe("a status question", () => {
    const answered = settledWorkflow(null, (workflow) =>
      workflow.handle({ ...start, id: "evt-status", kind: "status", text: "status?" }),
    );

    it("answers with the cost so far", () =>
      answered((debug) => {
        expect(
          debug.outbox.some(
            (entry) => entry.kind === "info" && entry.payload?.text?.includes("Cost so far"),
          ),
        ).toBe(true);
      }));

    it("leaves nothing in the inbox", () =>
      answered((debug) => {
        expect(debug.inbox).toHaveLength(0);
      }));
  });

  describe("a turn on a superseded isolate", () => {
    it("tells the humans nothing, since the turn is not this instance's to finish", () =>
      lost((debug) => {
        expect(debug.outbox.map((entry) => entry.payload?.text)).not.toContain(STUCK_TEXT);
      }));

    it("leaves the turn open", () =>
      lost((debug) => {
        expect(debug.state.turn_started_at).not.toBeNull();
      }));

    describe("once the next instance starts and its turn settles", () => {
      const resumed: Scenario<Debug> = async (run) => {
        const { stub } = await loseTurn();
        const model = new ScriptedFailure(["text"]);
        await withNewInstanceModel(model, async () => {
          await evictDurableObject(stub);
          await runInDurableObject(stub, async (workflow: Workflow) => {
            await workflow.status();
            await workflow.settle();
            await run((await workflow.debug()) as Debug);
          });
        });
      };

      it("ends the lost turn", () =>
        resumed((debug) => {
          expect(debug.state.turn_started_at).toBeNull();
        }));

      it("disarms the watchdog", () =>
        resumed((debug) => {
          expect(debug.state.turn_watchdog).toBeNull();
        }));

      it("wakes the agent with a note about the lost turn", () =>
        resumed((debug) => {
          expect(debug.log.map((entry) => entry.line)).toContain("agent wake: blocked");
        }));

      it("runs the turn that reads the note", () =>
        resumed((debug) => {
          expect(noteLanded(debug)).toEqual({ inbox: false, transcript: true });
        }));

      it("tells the person's thread it picks the turn up again, then answers them", () =>
        resumed((debug) => {
          expect(heardText(debug)).toEqual([LOST_PLACE_TEXT, "done"]);
        }));

      it("forgets the person's message once it is answered", () =>
        resumed((debug) => {
          expect(debug.state.turn_messages).toEqual([]);
        }));
    });
  });
});
