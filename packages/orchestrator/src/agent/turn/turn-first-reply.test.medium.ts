import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import type { FakeRuntime } from "../../../test/fake-runtime";
import { ScriptedFailure, type Action } from "../../../test/fake-model";
import type { Scenario } from "../../../test/scenario";
import { THUMBS_UP } from "../tools/channel";
import { eventMessage } from "../transcript/envelope";
import { runAgentTurn } from "./turn";

const THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;

const asked: InboundEvent = {
  id: "evt-asked",
  kind: "prompt",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "Fix the flaky test.",
  reply_to: THREAD,
};

type Ran = { workflow: FakeRuntime; chat: FakeChat };

function turnOn(script: Action[], wake: "message" | "task_result"): Scenario<Ran> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      const chat = new FakeChat();
      workflow.chatInstance = chat;
      workflow.patchState({ status: "running", origin: THREAD, reply_targets: [THREAD] });
      workflow.modelInstance = new ScriptedFailure(script);
      const message = eventMessage(asked, { first: false, job: null, artifact: null, notes: [] });
      if (wake === "message") {
        workflow.transcript.enqueue(message, "message", {
          reply_to: THREAD,
          chat_message: { channel: "C1", message: "1757000001.000100" },
        });
      } else {
        workflow.transcript.enqueue("[note]\nTask wf_x.1 finished.", "task_result");
      }
      await runAgentTurn(workflow);
      await run({ workflow, chat });
    });
}

function refusedTools(workflow: FakeRuntime): string[] {
  return workflow.lines.flatMap((line) => {
    const match = /^agent: (\S+) failed: .*unavailable tool/.exec(line);
    return match ? [match[1]!] : [];
  });
}

describe("a person's message, and a model that dispatches before it replies", () => {
  const dispatched = turnOn(["prompt_task", "react", "text"], "message");

  it("refuses the dispatch", () =>
    dispatched(({ workflow }) => {
      expect(refusedTools(workflow)).toEqual(["prompt_task"]);
    }));

  it("puts the thumbs-up on the person's chat message", () =>
    dispatched(({ chat }) => {
      expect(chat.argsOf("addReaction")).toEqual([["C1", "1757000001.000100", THUMBS_UP]]);
    }));
});

describe("a person's message, and a model that replies with a line first", () => {
  const replied = turnOn(["acknowledge", "finish"], "message");

  it("runs the work after the line", () =>
    replied(({ workflow }) => {
      expect(refusedTools(workflow)).toEqual([]);
      expect(workflow.posted[0]).toEqual({ type: "info", text: "Got it." });
    }));
});

describe("a turn nobody asked for", () => {
  const woken = turnOn(["finish"], "task_result");

  it("offers every tool from the first step", () =>
    woken(({ workflow }) => {
      expect(refusedTools(workflow)).toEqual([]);
    }));
});
