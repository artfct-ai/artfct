import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { type FakeRuntime } from "../../../test/fake-runtime";
import { EchoModel, ScriptedFailure, SilentModel } from "../../../test/fake-model";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import {
  COMPACT_PROMPT,
  DIGEST_TURN_TEXT_PROMPT,
  type SummarizationPrompt,
} from "../../prompts/summarization-prompt";
import { ScriptedModel } from "../../../test/scripted-model";
import { runPrompt, SUMMARIZATION_TIMEOUT_MS } from "./run-prompt";

const TEXT = "a".repeat(4000);

type Summarization = { model?: string };

const OWN_MODEL: Summarization = { model: "summary-model" };
const ON_ORCHESTRATOR: Summarization = {};

type Models = () => Record<string, LanguageModel>;

function withSummarization(workflow: FakeRuntime, summarization: Summarization): void {
  const config = workflow.config();
  workflow.patchConfig({
    orchestrator: {
      ...config.orchestrator,
      model: "reasoning-model",
      model_params: { reasoning: { effort: "high" } },
      summarization,
    },
  });
}

function promptRuntime(summarization: Summarization, models: Models): Scenario<FakeRuntime> {
  return scenario(freshDurableRuntime, (workflow) => {
    workflow.modelsByName = models();
    withSummarization(workflow, summarization);
  });
}

type PromptRun = { workflow: FakeRuntime; answer: string | null };

function promptRun(
  summarization: Summarization,
  models: Models,
  prompt: SummarizationPrompt = DIGEST_TURN_TEXT_PROMPT,
  options?: Parameters<typeof runPrompt>[3],
): Scenario<PromptRun> {
  return (run) =>
    promptRuntime(
      summarization,
      models,
    )(async (workflow) => {
      const answer = await runPrompt(workflow, prompt, TEXT, options);
      await run({ workflow, answer });
    });
}

const failingThenOrchestrator: Models = () => ({
  "summary-model": new ScriptedFailure(["throw"]),
  "reasoning-model": new EchoModel("Rewrote the parser."),
});

function timedOutRun(models: Models): Scenario<PromptRun> {
  return (run) =>
    promptRuntime(
      OWN_MODEL,
      models,
    )(async (workflow) => {
      vi.useFakeTimers();
      try {
        const pending = runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, TEXT);
        await vi.advanceTimersByTimeAsync(SUMMARIZATION_TIMEOUT_MS);
        await run({ workflow, answer: await pending });
      } finally {
        vi.useRealTimers();
      }
    });
}

describe("runPrompt", () => {
  describe("a config that names a summarization model", () => {
    let summarizer: EchoModel;
    const ran = promptRun(OWN_MODEL, () => {
      summarizer = new EchoModel("Rewrote the parser.");
      return { "summary-model": summarizer };
    });

    it("answers with what that model said", () =>
      ran(({ answer }) => {
        expect(answer).toBe("Rewrote the parser.");
      }));

    it("asks for that model by name", () =>
      ran(({ workflow }) => {
        expect(workflow.modelRequests).toEqual(["summary-model"]);
      }));

    it("sends none of the orchestrator model's request fields", () =>
      ran(({ workflow }) => {
        expect(workflow.modelParams).toEqual([{}]);
      }));

    it("sends the system text of the prompt", () =>
      ran(() => {
        expect(summarizer.systems[0]).toBe(DIGEST_TURN_TEXT_PROMPT.system);
      }));
  });

  describe("another prompt under the same config", () => {
    let summarizer: EchoModel;
    const ran = promptRun(
      OWN_MODEL,
      () => {
        summarizer = new EchoModel("The humans asked for a parser.");
        return { "summary-model": summarizer };
      },
      COMPACT_PROMPT,
    );

    it("runs on the same model", () =>
      ran(({ workflow }) => {
        expect(workflow.modelRequests).toEqual(["summary-model"]);
      }));

    it("sends its own system text", () =>
      ran(() => {
        expect(summarizer.systems[0]).toBe(COMPACT_PROMPT.system);
      }));
  });

  describe("a config that names no summarization model", () => {
    const ran = promptRun(ON_ORCHESTRATOR, () => ({
      "reasoning-model": new EchoModel("Rewrote the parser."),
    }));

    it("answers on the orchestrator model", () =>
      ran(({ answer }) => {
        expect(answer).toBe("Rewrote the parser.");
      }));

    it("asks for the orchestrator model", () =>
      ran(({ workflow }) => {
        expect(workflow.modelRequests).toEqual(["reasoning-model"]);
      }));
  });

  describe("a call the caller gave a character budget", () => {
    let summarizer: EchoModel;
    const models: Models = () => {
      summarizer = new EchoModel("Rewrote the parser.");
      return { "summary-model": summarizer };
    };
    const withBudget = promptRun(OWN_MODEL, models, DIGEST_TURN_TEXT_PROMPT, { maxChars: 120 });

    it("tells the model how long the answer may be", () =>
      withBudget(() => {
        expect(summarizer.systems[0]).toContain("at most 120 characters");
      }));

    describe("and a second call without one", () => {
      const withoutBudget = scenario(withBudget, ({ workflow }) =>
        runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, TEXT).then(() => undefined),
      );

      it("says nothing about a limit", () =>
        withoutBudget(() => {
          expect(summarizer.systems[1]).not.toContain("at most");
        }));
    });
  });

  describe("a provider that could hold the turn open", () => {
    let summarizer: EchoModel;
    const ran = promptRun(OWN_MODEL, () => {
      summarizer = new EchoModel("Rewrote the parser.");
      return { "summary-model": summarizer };
    });

    it("bounds the call with a signal that is still open", () =>
      ran(() => {
        expect(summarizer.signals[0]).toBeInstanceOf(AbortSignal);
        expect(summarizer.signals[0]?.aborted).toBe(false);
      }));
  });

  describe("a model that never answers, with another model in the config", () => {
    const ran = timedOutRun(() => ({
      "summary-model": new SilentModel(),
      "reasoning-model": new EchoModel("never used"),
    }));

    it("gives up at the summarization timeout", () =>
      ran(({ answer }) => {
        expect(answer).toBeNull();
      }));

    it("says in the log how long it waited", () =>
      ran(({ workflow }) => {
        expect(workflow.lines).toContain(
          `prompt summarize gave up after ${SUMMARIZATION_TIMEOUT_MS} ms`,
        );
      }));

    it("does not fall back, since a second model would only cost the turn more", () =>
      ran(({ workflow }) => {
        expect(workflow.modelRequests).toEqual(["summary-model"]);
      }));
  });

  describe("a caller whose own deadline already passed", () => {
    const ran = promptRun(
      ON_ORCHESTRATOR,
      () => ({ "reasoning-model": new SilentModel() }),
      DIGEST_TURN_TEXT_PROMPT,
      { abortSignal: AbortSignal.abort() },
    );

    it("stops on that deadline too", () =>
      ran(({ answer }) => {
        expect(answer).toBeNull();
      }));

    it("says in the log that the prompt failed", () =>
      ran(({ workflow }) => {
        expect(workflow.lines.some((line) => line.startsWith("prompt summarize failed"))).toBe(
          true,
        );
      }));
  });

  describe("a failing model that is the orchestrator's own", () => {
    const ran = promptRun(ON_ORCHESTRATOR, () => ({
      "reasoning-model": new ScriptedFailure(["throw"]),
    }));

    it("returns nothing", () =>
      ran(({ answer }) => {
        expect(answer).toBeNull();
      }));

    it("does not fall back, since the prompt already runs on that model", () =>
      ran(({ workflow }) => {
        expect(workflow.modelRequests).toEqual(["reasoning-model"]);
      }));
  });

  describe("a summarization model that fails", () => {
    const ran = promptRun(OWN_MODEL, failingThenOrchestrator);

    it("answers from the orchestrator model", () =>
      ran(({ answer }) => {
        expect(answer).toBe("Rewrote the parser.");
      }));

    it("asks for the summarization model first, then the orchestrator's", () =>
      ran(({ workflow }) => {
        expect(workflow.modelRequests).toEqual(["summary-model", "reasoning-model"]);
      }));

    it("sends the orchestrator model its own request fields", () =>
      ran(({ workflow }) => {
        expect(workflow.modelParams).toEqual([{}, { reasoning: { effort: "high" } }]);
      }));

    it("says in the log which model it fell back to", () =>
      ran(({ workflow }) => {
        expect(workflow.lines).toContain("prompt summarize falls back to reasoning-model");
      }));
  });

  describe("both models failing", () => {
    const ran = promptRun(OWN_MODEL, () => ({
      "summary-model": new ScriptedFailure(["throw"]),
      "reasoning-model": new ScriptedFailure(["throw"]),
    }));

    it("returns nothing", () =>
      ran(({ answer }) => {
        expect(answer).toBeNull();
      }));
  });

  describe("an answer the model gave", () => {
    const ran = promptRun(OWN_MODEL, () => ({
      "summary-model": new EchoModel("Rewrote the parser."),
    }));

    it("records what it used under the prompt's name", () =>
      ran(({ workflow }) => {
        expect(workflow.store.modelUsage()).toEqual([
          expect.objectContaining({ purpose: "summarize", model: "summary-model" }),
        ]);
      }));
  });

  describe("the scripted model", () => {
    let summary: string | null;
    let compacted: string | null;
    const ran = scenario(freshDurableRuntime, async (workflow) => {
      workflow.modelInstance = new ScriptedModel();
      summary = await runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, TEXT);
      compacted = await runPrompt(workflow, COMPACT_PROMPT, TEXT);
    });

    it("takes nothing for a prompt the scripted model has no answer for", () =>
      ran(() => {
        expect(summary).toBeNull();
      }));

    it("takes the answer the scripted model does have", () =>
      ran(() => {
        expect(compacted).toBe("Summary of the earlier conversation.");
      }));

    it("counts a missing answer as an answer, not a failure", () =>
      ran((workflow) => {
        expect(workflow.lines.some((line) => line.startsWith("prompt summarize failed"))).toBe(
          false,
        );
      }));
  });

  describe("a call with nothing to say", () => {
    let model: EchoModel;
    const ready = promptRuntime(OWN_MODEL, () => {
      model = new EchoModel("never used");
      return { "summary-model": model };
    });

    it("returns nothing for text that is only spaces", () =>
      ready(async (workflow) => {
        expect(await runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, "   ")).toBeNull();
      }));

    it("returns nothing for a budget of no characters", () =>
      ready(async (workflow) => {
        expect(
          await runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, "something", { maxChars: 0 }),
        ).toBeNull();
      }));

    it("asks no model in either case", () =>
      ready(async (workflow) => {
        await runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, "   ");
        await runPrompt(workflow, DIGEST_TURN_TEXT_PROMPT, "something", { maxChars: 0 });
        expect(model.systems).toEqual([]);
      }));
  });
});
