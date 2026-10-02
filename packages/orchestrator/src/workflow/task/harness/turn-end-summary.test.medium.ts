import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../../test/durable-runtime";
import { EchoModel, ScriptedFailure } from "../../../../test/fake-model";
import { DIGEST_TURN_TEXT_PROMPT } from "../../../prompts/summarization-prompt";
import { onTurnEnd } from "./turn";
import { seedTask, type FakeRuntime } from "../../../../test/fake-runtime";
import { scenario } from "../../../../test/scenario";

const LONG_TURN = `${"y".repeat(2000)} and then some`;

function useModel(workflow: FakeRuntime, model: EchoModel | ScriptedFailure): void {
  workflow.modelInstance = model;
  const config = workflow.config();
  workflow.patchConfig({ orchestrator: { ...config.orchestrator, model: model.modelId } });
}

function afterLongTurn(arrange: (workflow: FakeRuntime) => void, turnText = LONG_TURN) {
  return scenario(freshDurableRuntime, (workflow) => {
    arrange(workflow);
    return onTurnEnd(workflow, seedTask(workflow, {}, { turn_text: turnText }), "end_turn");
  });
}

describe("onTurnEnd", () => {
  describe("turn text too long for the digest", () => {
    describe("summarized by a model that answers inside the budget", () => {
      const ended = afterLongTurn((workflow) => {
        useModel(workflow, new EchoModel("Rewrote the parser. The CLI flag is still open."));
      });

      it("quotes the summary, not a clip of the tail", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).toContain(
            'last: "Rewrote the parser. The CLI flag is still open."',
          );
        }));

      it("drops the text the summary stands for", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).not.toContain("yyyy");
        }));
    });

    describe("summarized by a model that overshot the budget", () => {
      const answer = `Rewrote the ACP parser and added the retry path. ${"z".repeat(400)} LEFTOVER`;
      const ended = afterLongTurn((workflow) => {
        useModel(workflow, new EchoModel(answer));
      });

      it("keeps the opening clause, which says what the turn did", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).toContain('last: "Rewrote the ACP parser');
        }));

      it("cuts the end off", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).not.toContain("LEFTOVER");
        }));

      it("marks where it cut", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).toContain('…"');
        }));
    });

    describe("with a summarization model of its own", () => {
      let summarizer: EchoModel;
      let orchestrator: EchoModel;
      const ended = afterLongTurn((workflow) => {
        summarizer = new EchoModel("Rewrote the parser.");
        orchestrator = new EchoModel("never used");
        workflow.modelInstance = orchestrator;
        workflow.modelsByName = { "summary-model": summarizer };
        const config = workflow.config();
        workflow.patchConfig({
          orchestrator: {
            ...config.orchestrator,
            model: "reasoning-model",
            summarization: { model: "summary-model" },
          },
        });
      });

      it("quotes what that model answered", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).toContain('last: "Rewrote the parser."');
        }));

      it("gives that model the summarize prompt's system text", () =>
        ended(() => {
          expect(summarizer.systems[0]).toContain(DIGEST_TURN_TEXT_PROMPT.system);
        }));

      it("asks the orchestrator's own model for nothing", () =>
        ended(() => {
          expect(orchestrator.systems).toEqual([]);
        }));

      it("asks for the model the prompt names", () =>
        ended((workflow) => {
          expect(workflow.modelRequests).toEqual(["summary-model"]);
        }));
    });

    describe("with a model that cannot summarize", () => {
      const ended = afterLongTurn(
        (workflow) => {
          useModel(workflow, new ScriptedFailure(["throw"]));
        },
        `${"y".repeat(2000)} opened the PR`,
      );

      it("falls back to the clipped tail", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).toContain("opened the PR");
        }));

      it("marks the clip", () =>
        ended((workflow) => {
          expect(workflow.notes[0]?.text).toContain('last: "…');
        }));
    });
  });
});
