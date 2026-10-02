import { describe, expect, it } from "bun:test";
import {
  docUrlForStage,
  mockStage,
  promptText,
  replyForTurn,
  selectionInPrompt,
  toolCallForTurn,
} from "./mock-harness-turn";

const SELECTION_PROMPT = [
  "Break it down.",
  "",
  "## Selection behind the input artifact",
  "The input artifact lists options. A person chose this option from it.",
  "Feature flag",
  "",
  "## Brief",
].join("\n");

describe("selectionInPrompt", () => {
  it("reads the option under the intro of the selection section", () => {
    expect(selectionInPrompt(SELECTION_PROMPT)).toBe("Feature flag");
  });

  it("is null for a prompt with no selection", () => {
    expect(selectionInPrompt("Break it down.")).toBeNull();
  });
});

describe("promptText", () => {
  describe("a prompt of blocks of several types", () => {
    it("joins the text blocks and skips the others", () => {
      expect(
        promptText([
          { type: "text", text: "a" },
          { type: "image", data: "", mimeType: "image/png" },
          { type: "text", text: "b" },
        ]),
      ).toBe("a\n\nb");
    });
  });
});

describe("mockStage", () => {
  describe("no ARTFCT_STAGE in the environment", () => {
    it("is the PR stage", () => {
      expect(mockStage(undefined)).toEqual({ name: "implement", kind: "pr" });
    });
  });

  describe("the name of the PR stage", () => {
    it("is the PR stage", () => {
      expect(mockStage("implement")).toEqual({ name: "implement", kind: "pr" });
    });
  });

  describe("any other stage name", () => {
    it("is a document stage", () => {
      expect(mockStage("design")).toEqual({ name: "design", kind: "doc" });
    });
  });
});

describe("docUrlForStage", () => {
  it("is a Notion page URL for the stage", () => {
    expect(docUrlForStage("design")).toBe(
      "https://www.notion.so/acme/design-64657369676e00000000000000000000",
    );
  });

  it("ends in a 32 hex character page id", () => {
    expect(docUrlForStage("breakdown")).toMatch(
      /^https:\/\/www\.notion\.so\/acme\/breakdown-[0-9a-f]{32}$/,
    );
  });

  it("gives each stage its own page", () => {
    expect(docUrlForStage("breakdown")).not.toBe(docUrlForStage("design"));
  });
});

describe("replyForTurn", () => {
  const prUrl = "https://github.com/acme/app/pull/9";

  describe("turn 1 of the PR stage", () => {
    it("reports the PR when no stage is given", () => {
      expect(replyForTurn({ turn: 1, prompt: "build it", prUrl })).toContain(prUrl);
    });

    it("reports the PR for the named PR stage", () => {
      const stage = mockStage("implement");
      expect(replyForTurn({ turn: 1, prompt: "build it", prUrl, stage })).toContain(prUrl);
    });
  });

  describe("turn 1 of a document stage", () => {
    const stage = mockStage("design");
    const reply = replyForTurn({ turn: 1, prompt: "design it", prUrl, stage });

    it("reports the document", () => {
      expect(reply).toContain(`${docUrlForStage("design")} `);
    });

    it("does not report a PR", () => {
      expect(reply).not.toContain(prUrl);
    });
  });

  describe("turn 1 of a document stage that works from a selection", () => {
    it("names the selection it worked from", () => {
      const stage = mockStage("breakdown");
      expect(replyForTurn({ turn: 1, prompt: SELECTION_PROMPT, prUrl, stage })).toEndWith(
        " Worked from the selection: Feature flag.",
      );
    });
  });

  describe("a later turn of a document stage", () => {
    const stage = mockStage("design");

    it("says it updated the document", () => {
      expect(replyForTurn({ turn: 2, prompt: "add a diagram", prUrl, stage })).toBe(
        "Addressed the feedback: add a diagram. Updated the document.",
      );
    });

    it("acknowledges a resume prompt on the existing document", () => {
      expect(replyForTurn({ turn: 2, prompt: "Resume where you left off.", prUrl, stage })).toMatch(
        /^Resumed on the existing document/,
      );
    });
  });

  describe("a later turn of the PR stage", () => {
    it("acknowledges a resume prompt", () => {
      expect(replyForTurn({ turn: 2, prompt: "Resume where you left off.", prUrl })).toMatch(
        /^Resumed/,
      );
    });

    it("echoes the feedback", () => {
      expect(replyForTurn({ turn: 3, prompt: "fix lint", prUrl })).toContain("fix lint");
    });
  });
});

describe("toolCallForTurn", () => {
  describe("the PR stage", () => {
    it("opens the PR on turn 1", () => {
      expect(toolCallForTurn(1)).toMatchObject({ title: "git commit && gh pr create" });
    });

    it("pushes on a later turn", () => {
      expect(toolCallForTurn(2)).toMatchObject({ title: "git push" });
    });
  });

  describe("a document stage", () => {
    const stage = mockStage("design");

    it("creates the page on turn 1", () => {
      expect(toolCallForTurn(1, stage)).toMatchObject({ title: "notion pages create" });
    });

    it("updates the page on a later turn", () => {
      expect(toolCallForTurn(2, stage)).toMatchObject({ title: "notion pages update" });
    });
  });
});
