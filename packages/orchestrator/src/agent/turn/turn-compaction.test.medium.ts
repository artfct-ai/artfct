import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { type FakeRuntime } from "../../../test/fake-runtime";
import { EchoModel, ScriptedFailure, SilentModel } from "../../../test/fake-model";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { scenario } from "../../../test/scenario";
import { ScriptedModel } from "../../../test/scripted-model";
import { COMPACT_PROMPT } from "../../prompts/summarization-prompt";
import { RECAP_MARKER, runAgentTurn } from "./turn";

function bulky(role: "user" | "assistant", chars: number): ModelMessage {
  return { role, content: "x".repeat(chars) };
}

function fillTranscript(workflow: FakeRuntime, rowChars: number): number[] {
  for (let index = 0; index < 6; index += 1) {
    workflow.transcript.append([bulky(index % 2 === 0 ? "user" : "assistant", rowChars)]);
  }
  return workflow.transcript.all().map((row) => row.id);
}

function historyRowChars(workflow: FakeRuntime): number {
  return Math.floor(workflow.config().orchestrator.context_tokens / 5);
}

async function takeTurn(workflow: FakeRuntime, note: string): Promise<void> {
  workflow.transcript.enqueue(note, "task_result");
  await runAgentTurn(workflow);
}

function reportingModel(tokens: number): EchoModel {
  return new EchoModel("Working on it.", tokens);
}

function withCompactModel(workflow: FakeRuntime, model: string): void {
  const config = workflow.config();
  workflow.patchConfig({
    orchestrator: { ...config.orchestrator, model: "reasoning-model", summarization: { model } },
  });
}

describe("agent turn compaction", () => {
  describe("a request over the token limit", () => {
    let before: number[];
    const compacted = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelsByName = { "compact-model": new EchoModel("They asked for a parser.") };
      withCompactModel(workflow, "compact-model");
      workflow.modelInstance = reportingModel(workflow.config().orchestrator.context_tokens + 1000);
      before = fillTranscript(workflow, historyRowChars(workflow));
      await takeTurn(workflow, "[note]\nthe first request");
      await takeTurn(workflow, "[note]\nthe second request");
    });

    it("replaces every row before this turn with a recap", () =>
      compacted((workflow) => {
        expect(workflow.transcript.all()[0]?.message).toEqual({
          role: "user",
          content: `${RECAP_MARKER}\nThey asked for a parser.`,
        });
      }));

    it("keeps the recap and the message that woke this turn", () =>
      compacted((workflow) => {
        const kept = workflow.transcript.all().slice(0, 2);
        expect(kept.map((row) => row.message.content)).toEqual([
          `${RECAP_MARKER}\nThey asked for a parser.`,
          "[note]\nthe second request",
        ]);
      }));

    it("keeps nothing older than the recap", () =>
      compacted((workflow) => {
        expect(workflow.transcript.all().some((row) => before.includes(row.id))).toBe(false);
      }));

    it("logs how many messages it summarized", () =>
      compacted((workflow) => {
        expect(workflow.lines).toContain("agent transcript compacted: 8 messages summarized");
      }));
  });

  describe("a compact prompt with a model of its own", () => {
    let compactor: EchoModel;
    const compacted = scenario(freshDurableRuntime, async (workflow) => {
      compactor = new EchoModel("They asked for a parser and a CLI flag.");
      workflow.modelsByName = { "compact-model": compactor };
      withCompactModel(workflow, "compact-model");
      workflow.modelInstance = reportingModel(workflow.config().orchestrator.context_tokens + 1000);
      fillTranscript(workflow, historyRowChars(workflow));
      await takeTurn(workflow, "[note]\nthe first request");
      await takeTurn(workflow, "[note]\nthe second request");
    });

    it("summarizes with what that model answered", () =>
      compacted((workflow) => {
        expect(workflow.transcript.all()[0]?.message.content).toBe(
          `${RECAP_MARKER}\nThey asked for a parser and a CLI flag.`,
        );
      }));

    it("sends it the system prompt of the compact prompt", () =>
      compacted(() => {
        expect(compactor.systems[0]).toBe(COMPACT_PROMPT.system);
      }));

    it("asks for that model by name, not the one the turn runs on", () =>
      compacted((workflow) => {
        expect(workflow.modelRequests).toContain("compact-model");
      }));
  });

  describe("a compact prompt that cannot answer on two turns running", () => {
    let before: number[];
    const tried = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelsByName = {
        "compact-model": new ScriptedFailure(["throw", "throw"]),
        "reasoning-model": new ScriptedFailure(["throw", "throw"]),
      };
      withCompactModel(workflow, "compact-model");
      workflow.modelInstance = reportingModel(workflow.config().orchestrator.context_tokens + 1000);
      before = fillTranscript(workflow, historyRowChars(workflow));
      await takeTurn(workflow, "[note]\nthe first request");
      await takeTurn(workflow, "[note]\nthe second request");
      await takeTurn(workflow, "[note]\nthe third request");
    });

    it("keeps every message, since no recap is worth the conversation", () =>
      tried((workflow) => {
        const kept = workflow.transcript.all().map((row) => row.id);
        expect(kept.slice(0, 6)).toEqual(before);
      }));

    it("tries the prompt again on the next turn", () =>
      tried((workflow) => {
        expect(
          workflow.lines.filter((line) => line === "prompt compact falls back to reasoning-model"),
        ).toHaveLength(2);
      }));

    it("fails on the compact model and on the fallback both times", () =>
      tried((workflow) => {
        expect(
          workflow.lines.filter((line) => line.startsWith("prompt compact failed")),
        ).toHaveLength(4);
      }));

    it("says the next turn will ask again", () =>
      tried((workflow) => {
        expect(workflow.lines).toContain(
          "agent transcript compaction found no recap, the next turn asks again",
        );
      }));

    it("replaces nothing", () =>
      tried((workflow) => {
        expect(workflow.lines.some((line) => line.startsWith("agent transcript compacted:"))).toBe(
          false,
        );
      }));
  });

  describe("a turn that times out while it compacts, then the next turn", () => {
    let linesAtTimeout: string[];
    let nextModel: EchoModel;
    const ran = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelsByName = { "compact-model": new ScriptedFailure(["throw"]) };
      withCompactModel(workflow, "compact-model");
      const { orchestrator } = workflow.config();
      workflow.modelInstance = reportingModel(orchestrator.context_tokens + 1000);
      fillTranscript(workflow, historyRowChars(workflow));
      await takeTurn(workflow, "[note]\nthe first request");
      workflow.modelInstance = new SilentModel();
      workflow.patchConfig({ orchestrator: { ...orchestrator, turn_timeout_minutes: 0.0005 } });
      await takeTurn(workflow, "[note]\nthe second request");
      linesAtTimeout = [...workflow.lines];
      nextModel = reportingModel(0);
      workflow.modelInstance = nextModel;
      workflow.patchConfig({ orchestrator });
      await takeTurn(workflow, "[note]\nthe third request");
    });

    it("stops compacting before it ends", () =>
      ran(() => {
        expect(linesAtTimeout).toContain(
          "agent transcript compaction found no recap, the next turn asks again",
        );
      }));

    it("ends on its timeout", () =>
      ran(() => {
        expect(linesAtTimeout.at(-1)).toBe("agent turn timed out after 0.0005 minutes");
      }));

    it("leaves the next turn's model to the next turn alone", () =>
      ran(() => {
        expect(nextModel.systems).toHaveLength(1);
      }));
  });

  describe("a request over the token limit on every turn after that", () => {
    const compacted = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelsByName = { "compact-model": new EchoModel("They asked for a parser.") };
      withCompactModel(workflow, "compact-model");
      workflow.modelInstance = reportingModel(workflow.config().orchestrator.context_tokens + 1000);
      fillTranscript(workflow, historyRowChars(workflow));
      await takeTurn(workflow, "[note]\nthe first request");
      await takeTurn(workflow, "[note]\nthe second request");
      await takeTurn(workflow, "[note]\nthe third request");
      await takeTurn(workflow, "[note]\nthe fourth request");
    });

    it("compacts once, since the token count also counts what compaction cannot shrink", () =>
      compacted((workflow) => {
        expect(
          workflow.lines.filter((line) => line.startsWith("agent transcript compacted")),
        ).toEqual(["agent transcript compacted: 8 messages summarized"]);
      }));

    it("summarizes no recap of its own a second time", () =>
      compacted((workflow) => {
        expect(workflow.transcript.all()[0]?.message.content).toBe(
          `${RECAP_MARKER}\nThey asked for a parser.`,
        );
      }));
  });

  describe("a request over the token limit with almost no history", () => {
    const ran = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelsByName = { "compact-model": new EchoModel("never used") };
      withCompactModel(workflow, "compact-model");
      workflow.modelInstance = reportingModel(workflow.config().orchestrator.context_tokens + 1000);
      await takeTurn(workflow, "[note]\nthe first request");
      await takeTurn(workflow, "[note]\nthe second request");
    });

    it("compacts nothing, since a recap cannot save what the call would cost", () =>
      ran((workflow) => {
        expect(workflow.lines.some((line) => line.startsWith("agent transcript compacted"))).toBe(
          false,
        );
      }));
  });

  describe("a request under the token limit", () => {
    const ran = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelsByName = { "compact-model": new EchoModel("never used") };
      withCompactModel(workflow, "compact-model");
      workflow.modelInstance = reportingModel(workflow.config().orchestrator.context_tokens - 1000);
      fillTranscript(workflow, historyRowChars(workflow));
      await takeTurn(workflow, "[note]\nthe first request");
      await takeTurn(workflow, "[note]\nthe second request");
    });

    it("compacts nothing", () =>
      ran((workflow) => {
        expect(workflow.lines.some((line) => line.startsWith("agent transcript compacted"))).toBe(
          false,
        );
      }));
  });

  describe("a model that reports no input tokens", () => {
    let before: number[];
    const ran = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelInstance = new ScriptedModel();
      before = fillTranscript(workflow, historyRowChars(workflow));
      await takeTurn(workflow, "[note]\nnothing to do");
      await takeTurn(workflow, "[note]\nstill nothing to do");
    });

    it("keeps the rows it had", () =>
      ran((workflow) => {
        expect(
          workflow.transcript
            .all()
            .map((row) => row.id)
            .slice(0, 6),
        ).toEqual(before);
      }));

    it("compacts nothing, since nothing says the request is too large", () =>
      ran((workflow) => {
        expect(workflow.lines.some((line) => line.startsWith("agent transcript compacted"))).toBe(
          false,
        );
      }));
  });
});
