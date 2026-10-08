import type { YesNoQuestion } from "@artfct-ai/adapters/gateway/types";
import { describe, expect, it } from "bun:test";
import { ScriptedDecisions, scriptedChoice, scriptedProbability } from "./scripted-decisions";
import { SCRIPTED_NO_REVIEW, SCRIPTED_REVIEW_REQUEST } from "./scripted-model";

const QUESTION: YesNoQuestion = { instructions: "Is it so?", yes: "It is.", no: "It is not." };

describe("scriptedProbability", () => {
  describe("the acceptance question", () => {
    it("says yes when one message approves", () => {
      expect(scriptedProbability("accepts", { messages: "tighten it\n\nlooks good" })).toBe(1);
    });

    it("says no when no message approves", () => {
      expect(scriptedProbability("accepts", { messages: "tighten the intro" })).toBe(0);
    });
  });

  describe("the selection question", () => {
    const question = {
      instructions: "Which option?",
      options: { "Feature flag": "Option 1.", "Direct fix": "Option 2.", none: "Neither." },
    };

    it("picks the option the messages name", () => {
      expect(scriptedChoice("selected", { messages: "go with feature flag" }, question)).toEqual({
        option: "Feature flag",
        probability: 1,
      });
    });

    it("picks none when the messages name no option", () => {
      expect(scriptedChoice("selected", { messages: "not sure yet" }, question).option).toBe(
        "none",
      );
    });
  });

  describe("the review-again question", () => {
    it("says yes when the closing text asks for another review", () => {
      expect(scriptedProbability("review_again", { closing_text: SCRIPTED_REVIEW_REQUEST })).toBe(
        1,
      );
    });

    it("says no when the closing text needs no review", () => {
      expect(scriptedProbability("review_again", { closing_text: SCRIPTED_NO_REVIEW })).toBe(0);
    });
  });

  describe("a question with no script", () => {
    it("stays undecided", () => {
      expect(scriptedProbability("gave_up", { messages: "looks good" })).toBe(0.5);
    });
  });
});

describe("ScriptedDecisions", () => {
  it("answers every question asked at no cost", async () => {
    const answers = await new ScriptedDecisions().decide(
      { messages: "approved" },
      { yesNo: { accepts: QUESTION, owed: QUESTION }, choices: {} },
    );
    expect(answers).toEqual({
      probabilities: { accepts: 1, owed: 0.5 },
      choices: {},
      usage: { model: "scripted", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    });
  });
});
