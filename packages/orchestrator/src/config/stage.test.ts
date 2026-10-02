import { describe, expect, it } from "bun:test";
import { Config } from "./config";
import { resolveRefinerSettings, resolveStage, Stage } from "./stage";

const IMPLEMENT = { produce: { execution: "harness", skill: "implement" } };

const config = Config.parse({
  orchestrator: { task: { harness: "opencode", model: "default-model" } },
});

const stages = [
  Stage.parse({
    name: "plan",
    artifact: "issues",
    author: { produce: { execution: "harness", skill: "plan" } },
  }),
  Stage.parse({
    name: "build",
    artifact: "pull",
    author: {
      produce: {
        execution: "harness",
        harness: "opencode",
        model: "m2",
        effort: "low",
        skill: "implement",
      },
    },
  }),
];

describe("Stage", () => {
  describe("a stage with only the required fields", () => {
    const stage = Stage.parse({ name: "s", artifact: "pull", author: IMPLEMENT });

    it("asks for no branch of its own", () => {
      expect(stage.branch).toBe(false);
    });

    it("declares no refiners, so the artifact goes straight to the humans", () => {
      expect(stage.reviewers).toEqual([]);
      expect(stage.polishers).toEqual([]);
    });

    it("leaves the harness to the config", () => {
      expect(stage.author.produce).not.toHaveProperty("harness");
    });

    it("produces in a harness session", () => {
      expect(stage.author.produce.execution).toBe("harness");
    });

    it("declares no revise activity", () => {
      expect(stage.author.revise).toBeUndefined();
    });

    it("completes on acceptance", () => {
      expect(stage.ending).toBe("acceptance");
    });
  });

  it("refuses a stage with no author", () => {
    expect(Stage.safeParse({ name: "s", artifact: "pull" }).success).toBe(false);
  });

  describe("a stage that declares reviewers", () => {
    const rejects_when = { question: "Is the approach wrong?", yes: "A rewrite.", no: "It holds." };
    const judge = {
      name: "alignment",
      mode: "judge" as const,
      rejects_when,
      skill: "implement-approach-judge",
    };

    it("keeps the list in order, with feedback as the default mode", () => {
      const parsed = Stage.parse({
        name: "s",
        artifact: "pull",
        author: IMPLEMENT,
        reviewers: [judge, { name: "review", skill: "implement-review" }],
      });
      expect(parsed.reviewers).toEqual([
        judge,
        { name: "review", mode: "findings", skill: "implement-review" },
      ]);
    });

    it("refuses a judge entry with no rejects_when", () => {
      const reviewers = [{ name: "alignment", mode: "judge", skill: "implement" }];
      expect(
        Stage.safeParse({ name: "s", artifact: "pull", author: IMPLEMENT, reviewers }).success,
      ).toBe(false);
    });

    it("refuses rejects_when on a findings entry", () => {
      const reviewers = [{ name: "review", rejects_when, skill: "implement" }];
      expect(
        Stage.safeParse({ name: "s", artifact: "pull", author: IMPLEMENT, reviewers }).success,
      ).toBe(false);
    });

    it("takes a judge entry on a stage of any artifact kind", () => {
      for (const artifact of ["pull", "page", "issues"]) {
        const stage = { name: "s", artifact, author: IMPLEMENT, reviewers: [judge] };
        expect(Stage.safeParse(stage).success).toBe(true);
      }
    });
  });

  describe("a stage that declares polishers", () => {
    const parsed = Stage.parse({
      name: "s",
      artifact: "pull",
      author: IMPLEMENT,
      polishers: [{ name: "comments", model: "m3", skill: "technical-writer" }],
    });

    it("keeps the entry as declared, with no mode to carry", () => {
      expect(parsed.polishers).toEqual([
        { name: "comments", model: "m3", skill: "technical-writer" },
      ]);
    });

    it("carries no mode, because a polisher files nothing to rule on", () => {
      const withFlag = Stage.parse({
        name: "s",
        artifact: "pull",
        author: IMPLEMENT,
        polishers: [{ name: "comments", skill: "implement", mode: "judge" }],
      });
      expect(withFlag.polishers).toEqual([{ name: "comments", skill: "implement" }]);
    });
  });
});

function modelStage(produce: Record<string, string>, revise?: Record<string, string>) {
  return { name: "design", artifact: "page", author: { produce, ...(revise ? { revise } : {}) } };
}

describe("an author activity with model execution", () => {
  it("is refused without a model of its own", () => {
    expect(Stage.safeParse(modelStage({ execution: "model", skill: "design" })).success).toBe(
      false,
    );
  });

  it("is taken when it names its model", () => {
    const produce = { execution: "model", model: "openrouter/x-ai/grok-4.6", skill: "design" };
    expect(Stage.safeParse(modelStage(produce)).success).toBe(true);
  });

  it("refuses a revise activity without a model of its own", () => {
    const produce = { execution: "model", model: "m1", skill: "design" };
    const revise = { execution: "model", skill: "design-revise" };
    expect(Stage.safeParse(modelStage(produce, revise)).success).toBe(false);
  });
});

describe("a revise activity on an author in a harness", () => {
  const parsed = Stage.safeParse({
    name: "design",
    artifact: "page",
    author: {
      produce: { execution: "harness", skill: "design" },
      revise: { execution: "model", model: "m1", skill: "design-revise" },
    },
  });

  it("is refused", () => {
    expect(parsed.success).toBe(false);
  });

  it("says revise is for model execution today", () => {
    expect(parsed.error?.issues[0]?.message).toContain("revise is for model execution today");
  });
});

describe("a revise activity in a harness on a model-call author", () => {
  it("is refused", () => {
    const author = {
      produce: { execution: "model", model: "m1", skill: "design" },
      revise: { execution: "harness", skill: "design-revise" },
    };
    expect(Stage.safeParse({ name: "design", artifact: "page", author }).success).toBe(false);
  });
});

describe("resolveStage", () => {
  describe("a stage that overrides nothing", () => {
    const { author, reviewers } = resolveStage(config, stages[0]!);

    it("produces on the default harness and model, at the harness's own effort", () => {
      expect(author.produce).toEqual({
        execution: "harness",
        harness: "opencode",
        model: "default-model",
        effort: undefined,
        skill: "plan",
      });
    });

    it("revises with the produce settings", () => {
      expect(author.revise).toEqual(author.produce);
    });

    it("keeps the reviewer list", () => {
      expect(reviewers).toEqual([]);
    });
  });

  describe("a stage whose author sets its own harness, model and effort", () => {
    const resolved = resolveStage(config, stages[1]!);

    it("produces with them", () => {
      expect(resolved.author.produce).toEqual({
        execution: "harness",
        harness: "opencode",
        model: "m2",
        effort: "low",
        skill: "implement",
      });
    });

    it("keeps the stage name and artifact kind", () => {
      expect(resolved).toMatchObject({ name: "build", artifact: "pull" });
    });
  });

  describe("a model-call author with its own revise activity", () => {
    const resolved = resolveStage(
      config,
      Stage.parse({
        name: "design",
        artifact: "page",
        author: {
          produce: { execution: "model", model: "writer", effort: "high", skill: "design" },
          revise: {
            execution: "model",
            model: "editor",
            skill: "design-revise",
            preload_skills: ["working-with-findings"],
          },
        },
      }),
    );

    it("produces on the produce model and skill", () => {
      expect(resolved.author.produce).toEqual({
        execution: "model",
        harness: "opencode",
        model: "writer",
        effort: "high",
        skill: "design",
        preload_skills: [],
      });
    });

    it("revises on the revise model and skill, with the defaults for what it leaves unset", () => {
      expect(resolved.author.revise).toEqual({
        execution: "model",
        harness: "opencode",
        model: "editor",
        effort: undefined,
        skill: "design-revise",
        preload_skills: ["working-with-findings"],
      });
    });
  });

  describe("an author activity that does not say how it executes", () => {
    it("is refused", () => {
      expect(() =>
        Stage.parse({ name: "design", artifact: "page", author: { produce: { skill: "design" } } }),
      ).toThrow();
    });
  });

  describe("a harness activity that preloads skills", () => {
    it("is refused, because a harness session loads every skill", () => {
      expect(() =>
        Stage.parse({
          name: "design",
          artifact: "page",
          author: {
            produce: { execution: "harness", skill: "design", preload_skills: ["review-conduct"] },
          },
        }),
      ).toThrow();
    });
  });
});

describe("resolveStage on a stage with a research step", () => {
  describe("a research step that names only its skill", () => {
    const stage = Stage.parse({
      name: "build",
      artifact: "pull",
      author: {
        produce: {
          execution: "harness",
          harness: "opencode",
          model: "m2",
          effort: "low",
          skill: "implement",
        },
      },
      research: { skill: "research" },
    });

    it("runs in a harness session on the default harness and model, not the author's", () => {
      expect(resolveStage(config, stage).research).toEqual({
        execution: "harness",
        skill: "research",
        harness: "opencode",
        model: "default-model",
        effort: undefined,
      });
    });
  });

  describe("a research step with its own harness, model, and effort", () => {
    const stage = Stage.parse({
      name: "build",
      artifact: "pull",
      author: IMPLEMENT,
      research: { skill: "research", harness: "opencode", model: "r1", effort: "high" },
    });

    it("keeps them", () => {
      expect(resolveStage(config, stage).research).toEqual({
        execution: "harness",
        skill: "research",
        harness: "opencode",
        model: "r1",
        effort: "high",
      });
    });
  });

  describe("a stage with no research step", () => {
    it("resolves no research step", () => {
      expect(resolveStage(config, stages[0]!).research).toBeUndefined();
    });
  });

  it("refuses a research harness it does not know", () => {
    const research = { skill: "research", harness: "vim" };
    expect(
      Stage.safeParse({ name: "s", artifact: "pull", author: IMPLEMENT, research }).success,
    ).toBe(false);
  });
});

describe("resolveRefinerSettings", () => {
  describe("an entry with its own harness and model", () => {
    const resolved = resolveRefinerSettings(config, {
      name: "second opinion",
      harness: "opencode",
      model: "other-model",
      skill: "design-review",
    });

    it("runs in a harness session on the entry's harness, model, and skill", () => {
      expect(resolved).toEqual({
        execution: "harness",
        harness: "opencode",
        model: "other-model",
        effort: undefined,
        skill: "design-review",
      });
    });
  });

  describe("an entry that overrides nothing", () => {
    const resolved = resolveRefinerSettings(config, { name: "review", skill: "implement-review" });

    it("takes the default harness and model", () => {
      expect(resolved).toMatchObject({ harness: "opencode", model: "default-model" });
    });
  });

  it("runs at the entry's effort", () => {
    const entry = { name: "code cleaner", effort: "high" as const, skill: "code-cleaner" };
    expect(resolveRefinerSettings(config, entry).effort).toBe("high");
  });
});

describe("a stage with a choice ending", () => {
  const choiceEndingStage = {
    name: "approach",
    artifact: "page",
    author: { produce: { execution: "harness", skill: "design" } },
    ending: "choice",
  };

  it("completes on a selection", () => {
    expect(resolveStage(config, Stage.parse(choiceEndingStage)).ending).toBe("choice");
  });

  it("is refused when it produces no page", () => {
    expect(Stage.safeParse({ ...choiceEndingStage, artifact: "pull" }).success).toBe(false);
  });
});
