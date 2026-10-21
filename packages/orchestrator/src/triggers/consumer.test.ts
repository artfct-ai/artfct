import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { sqliteD1 } from "../../test/sqlite-d1";
import { loadWorkflowDefinition } from "../config/workflow-definition";
import { createDb, type Database } from "../db/client";
import { conversationIdOf, conversationRecorded } from "../db/conversations";
import { keepFiringThread, recordedFiringThread } from "../db/firing-threads";
import { consumeFiring, type FiringConsumer } from "./consumer";
import type { ConversationFiring, FiringAnswer, TriggerFiring } from "./types";

const DEFINITION = loadWorkflowDefinition(
  "dependency-upgrades",
  [
    "description: Upgrade dependencies.",
    "stages:",
    "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
    "triggers:",
    '  - { schedule: "0 9 * * 1-5", channel: C0123456, prompt: Upgrade the dependencies. }',
    "  - { event: github.pull_request.opened, prompt: Upgrade the pull request's dependencies. }",
  ].join("\n"),
);

const FIRING: TriggerFiring = {
  cause: { kind: "schedule", minute: "2026-10-19T09:00:00.000Z" },
  reports: { kind: "channel", channel: "C0123456" },
  definition: "dependency-upgrades",
  position: 0,
  attempt: 1,
};

const PULL_FIRING: TriggerFiring = {
  cause: {
    kind: "vendor_event",
    delivery_id: "d-1",
    event: "github.pull_request.opened",
    payload: "{}",
  },
  reports: { kind: "pull_request", repo: "acme/app", number: 12 },
  definition: "dependency-upgrades",
  position: 1,
  attempt: 1,
};

const STARTED: FiringAnswer = { kind: "started", workflow_id: "wf_one" };

type Handed = { conversationId: string; firing: ConversationFiring };

class ScriptedConsumer implements FiringConsumer {
  readonly db: Database = createDb(sqliteD1());
  readonly definitions = [DEFINITION];
  readonly handed: Handed[] = [];
  readonly sent: { firing: TriggerFiring; delaySeconds: number }[] = [];
  readonly code = new FakeCodeHost();
  answers: (FiringAnswer | Error)[] = [];

  constructor(readonly chat: FakeChat | null = new FakeChat()) {}

  fire = async (conversationId: string, firing: ConversationFiring): Promise<FiringAnswer> => {
    this.handed.push({ conversationId, firing });
    const answer = this.answers.shift() ?? STARTED;
    if (answer instanceof Error) throw answer;
    return answer;
  };

  sendAttempt = async (firing: TriggerFiring, delaySeconds: number): Promise<void> => {
    this.sent.push({ firing, delaySeconds });
  };
}

beforeEach(() => {
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("consumeFiring", () => {
  describe("a first attempt the conversation takes", () => {
    let consumer: ScriptedConsumer;

    beforeEach(async () => {
      consumer = new ScriptedConsumer();
      await consumeFiring(consumer, FIRING);
    });

    it("posts the start line in the trigger's channel", () => {
      expect(consumer.chat?.argsOf("postChannelMessage")).toEqual([
        ["C0123456", "Starting dependency upgrades."],
      ]);
    });

    it("records the start line as the firing's thread", async () => {
      expect(await recordedFiringThread(consumer.db, FIRING)).toEqual({
        channel: "C0123456",
        thread: "1700000001.000100",
      });
    });

    it("records the conversation of the start line's thread", async () => {
      const place = {
        source: "chat_thread",
        channel: "C0123456",
        thread: "1700000001.000100",
      } as const;
      expect(await conversationRecorded(consumer.db, place)).toBe(true);
    });

    it("hands the firing, its trigger and its thread to that conversation", async () => {
      const conversationId = await conversationIdOf({
        source: "chat_thread",
        channel: "C0123456",
        thread: "1700000001.000100",
      });
      expect(consumer.handed).toEqual([
        {
          conversationId,
          firing: {
            firing: FIRING,
            trigger: DEFINITION.triggers[0]!,
            origin: { source: "chat", channel: "C0123456", thread: "1700000001.000100" },
          },
        },
      ]);
    });

    it("does not send another attempt", () => {
      expect(consumer.sent).toEqual([]);
    });
  });

  describe("an attempt of a firing whose start line is recorded", () => {
    it("reuses the recorded thread and posts nothing", async () => {
      const consumer = new ScriptedConsumer();
      await keepFiringThread(consumer.db, FIRING, { channel: "C0123456", thread: "5.0" });
      await consumeFiring(consumer, { ...FIRING, attempt: 2 });
      expect(consumer.chat?.calls).toEqual([]);
      expect(consumer.handed.map((handed) => handed.firing.origin)).toEqual([
        { source: "chat", channel: "C0123456", thread: "5.0" },
      ]);
    });
  });

  describe("a duplicate answer", () => {
    it("counts as taken", async () => {
      const consumer = new ScriptedConsumer();
      consumer.answers = [{ kind: "duplicate" }];
      await consumeFiring(consumer, FIRING);
      expect(consumer.sent).toEqual([]);
    });
  });

  describe("a prompted answer", () => {
    it("counts as taken", async () => {
      const consumer = new ScriptedConsumer();
      consumer.answers = [{ kind: "prompted", workflow_id: "wf_one" }];
      await consumeFiring(consumer, FIRING);
      expect(consumer.sent).toEqual([]);
    });
  });

  describe("a firing that reports on its pull request", () => {
    let consumer: ScriptedConsumer;

    beforeEach(async () => {
      consumer = new ScriptedConsumer();
      await consumeFiring(consumer, PULL_FIRING);
    });

    it("posts no start line", () => {
      expect(consumer.chat?.calls).toEqual([]);
    });

    it("hands the firing to the conversation of the pull request and its definition", async () => {
      const conversationId = await conversationIdOf({
        source: "pull_request",
        repo: "acme/app",
        number: 12,
        definition: "dependency-upgrades",
      });
      expect(consumer.handed).toEqual([
        {
          conversationId,
          firing: {
            firing: PULL_FIRING,
            trigger: DEFINITION.triggers[1]!,
            origin: { source: "code", repo: "acme/app", pull: 12 },
          },
        },
      ]);
    });

    it("gives each definition its own conversation on the pull request", async () => {
      const other = await conversationIdOf({
        source: "pull_request",
        repo: "acme/app",
        number: 12,
        definition: "release-notes",
      });
      expect(consumer.handed[0]?.conversationId).not.toBe(other);
    });
  });

  describe("a failed last attempt of a pull request firing", () => {
    it("comments the failure line on the pull request", async () => {
      const consumer = new ScriptedConsumer();
      consumer.answers = [new Error("the conversation is unavailable")];
      await consumeFiring(consumer, { ...PULL_FIRING, attempt: 3 });
      expect(consumer.code.argsOf("commentOnPull")).toEqual([
        [
          "acme/app",
          12,
          "Dependency upgrades could not start. The error is in the orchestrator's logs.",
        ],
      ]);
    });
  });

  describe("a failed attempt", () => {
    it("sends the second attempt after 30 seconds", async () => {
      const consumer = new ScriptedConsumer();
      consumer.answers = [new Error("the conversation is unavailable")];
      await consumeFiring(consumer, FIRING);
      expect(consumer.sent).toEqual([{ firing: { ...FIRING, attempt: 2 }, delaySeconds: 30 }]);
    });

    it("sends the third attempt 2 minutes after the second fails", async () => {
      const consumer = new ScriptedConsumer();
      consumer.answers = [new Error("the conversation is unavailable")];
      await consumeFiring(consumer, { ...FIRING, attempt: 2 });
      expect(consumer.sent).toEqual([{ firing: { ...FIRING, attempt: 3 }, delaySeconds: 120 }]);
    });

    it("fails when the conversation has an active workflow of another definition", async () => {
      const consumer = new ScriptedConsumer();
      consumer.answers = [{ kind: "active_workflow", workflow_id: "wf_other" }];
      await consumeFiring(consumer, FIRING);
      expect(consumer.sent.map((sent) => sent.firing.attempt)).toEqual([2]);
    });

    it("fails when the conversation's workflow is ending", async () => {
      const consumer = new ScriptedConsumer();
      consumer.answers = [{ kind: "ending", workflow_id: "wf_ending" }];
      await consumeFiring(consumer, FIRING);
      expect(consumer.sent.map((sent) => sent.firing.attempt)).toEqual([2]);
    });

    it("fails when the chat has no credential", async () => {
      const consumer = new ScriptedConsumer(null);
      await consumeFiring(consumer, FIRING);
      expect(consumer.handed).toEqual([]);
      expect(consumer.sent.map((sent) => sent.firing.attempt)).toEqual([2]);
    });
  });

  describe("a failed last attempt", () => {
    let consumer: ScriptedConsumer;

    beforeEach(async () => {
      consumer = new ScriptedConsumer();
      await keepFiringThread(consumer.db, FIRING, { channel: "C0123456", thread: "5.0" });
      consumer.answers = [new Error("the conversation is unavailable")];
      await consumeFiring(consumer, { ...FIRING, attempt: 3 });
    });

    it("does not send another attempt", () => {
      expect(consumer.sent).toEqual([]);
    });

    it("posts one failure line in the firing's thread", () => {
      expect(consumer.chat?.calls).toEqual([
        {
          method: "postThreadReply",
          args: [
            "C0123456",
            "5.0",
            "Dependency upgrades could not start. The error is in the orchestrator's logs.",
          ],
        },
      ]);
    });

    it("logs the error", () => {
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("failed its last attempt"),
      );
    });
  });

  describe("a last attempt whose start line never posted", () => {
    it("logs the error without a failure line", async () => {
      const consumer = new ScriptedConsumer(new FakeChat({ failing: true }));
      await consumeFiring(consumer, { ...FIRING, attempt: 3 });
      expect(consumer.chat?.argsOf("postThreadReply")).toEqual([]);
      expect(console.error).toHaveBeenCalledTimes(1);
    });
  });

  describe("a firing whose trigger a deploy removed", () => {
    it("is dropped with an error", async () => {
      const consumer = new ScriptedConsumer();
      await consumeFiring(consumer, { ...FIRING, position: 2 });
      expect(consumer.handed).toEqual([]);
      expect(consumer.sent).toEqual([]);
    });
  });
});
