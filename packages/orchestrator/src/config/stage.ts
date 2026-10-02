import { EFFORTS, HARNESSES, type Effort, type Harness } from "@artfct-ai/adapters/harness/types";
import { ARTIFACT_KINDS } from "@artfct-ai/contracts/types";
import { z } from "zod";
import type { Config } from "./config";
import { RefinerEntry, ReviewerEntry } from "./refiner";
import { SkillRef } from "./skill-frontmatter";

/**
 * The research step of a stage: a researcher task that runs the skill before the author starts.
 * Unset harness, model, and effort fall back to the task settings of the config.
 */
export const StageResearch = z.object({
  skill: SkillRef,
  harness: z.enum(HARNESSES).optional(),
  model: z.string().optional(),
  effort: z.enum(EFFORTS).optional(),
});

/** How a task runs: in a harness session in a sandbox, or as one model call. */
const Execution = z.enum(["harness", "model"]);
type Execution = z.infer<typeof Execution>;

/**
 * What the author does in one turn, and how it runs. Unset harness, model, and effort fall back
 * to the task settings of the config. A model execution names its gateway model id. `preload_skills` are skills
 * whose text the model call reads after its own skill.
 */
const AuthorActivity = z.discriminatedUnion("execution", [
  z.strictObject({
    execution: z.literal("harness"),
    harness: z.enum(HARNESSES).optional(),
    model: z.string().optional(),
    effort: z.enum(EFFORTS).optional(),
    skill: SkillRef,
  }),
  z.strictObject({
    execution: z.literal("model"),
    model: z.string(),
    effort: z.enum(EFFORTS).optional(),
    skill: SkillRef,
    preload_skills: z.array(SkillRef).default([]),
  }),
]);

/** The author activities of a stage. An absent `revise` revises with the `produce` settings. */
const StageAuthor = z
  .object({ produce: AuthorActivity, revise: AuthorActivity.optional() })
  .refine(
    (author) =>
      author.revise === undefined ||
      (author.produce.execution === "model" && author.revise.execution === "model"),
    {
      message:
        "revise is for model execution today. An author in a harness revises in its own harness session.",
      path: ["revise"],
    },
  );

/** How a job of a stage completes: when a person accepts its artifact, or on a verified selection. */
const StageEnding = z.enum(["acceptance", "choice"]);

/**
 * One step of a workflow. Every stage gets the workflow's repository checked out when one is
 * known. `branch: true` gives the task its own branch in it and makes the plan require a
 * repository. The refiners run over the stage's artifact before a human looks at it: the
 * reviewers in list order, then the polishers. Two empty lists hand the artifact straight to the
 * humans.
 */
export const Stage = z
  .object({
    name: z.string(),
    artifact: z.enum(ARTIFACT_KINDS),
    branch: z.boolean().default(false),
    author: StageAuthor,
    reviewers: z.array(ReviewerEntry).default([]),
    /** Refiners that change the artifact in place once the reviewers settle. They file nothing. */
    polishers: z.array(RefinerEntry).default([]),
    /** One sentence saying when this stage belongs in a plan. Absent means it always does. */
    when: z.string().optional(),
    /** A researcher task that runs before the author. Absent means the author starts at once. */
    research: StageResearch.optional(),
    /** `choice` completes a job only on a selection among the options on its page. */
    ending: StageEnding.default("acceptance"),
  })
  .refine((stage) => stage.ending === "acceptance" || stage.artifact === "page", {
    message: "a stage with a choice ending produces a page, where its options are listed",
    path: ["ending"],
  });
export type Stage = z.infer<typeof Stage>;

/** The harness, model, effort, and skill one task runs with, task settings applied. */
type SettingsBase = {
  harness: Harness;
  model: string;
  effort: Effort | undefined;
  skill: string;
};

/** How one task runs. A model call also reads its preloaded skills. */
export type TaskSettings =
  | (SettingsBase & { execution: "harness" })
  | (SettingsBase & { execution: "model"; preload_skills: readonly string[] });

/** A stage with the task settings applied to its author activities and its research step. */
export type ResolvedStage = Omit<Stage, "author" | "research"> & {
  author: { produce: TaskSettings; revise: TaskSettings };
  research: TaskSettings | undefined;
};

/** Resolve the effective settings for one stage, its author activities, and its research step. */
export function resolveStage(config: Config, stage: Stage): ResolvedStage {
  const { author, research } = stage;
  const produce = resolveSettings(config, author.produce);
  return {
    ...stage,
    author: { produce, revise: author.revise ? resolveSettings(config, author.revise) : produce },
    research: research && resolveSettings(config, { ...research, execution: "harness" }),
  };
}

/** How a refiner runs: with its entry's own settings, always in a harness session. */
export function resolveRefinerSettings(config: Config, entry: RefinerEntry): TaskSettings {
  return resolveSettings(config, { ...entry, execution: "harness" });
}

/** Settings as a stage declares them, before the task settings apply. */
type DeclaredSettings = { skill: string; harness?: Harness; model?: string; effort?: Effort } & (
  | { execution: "harness" }
  | { execution: "model"; preload_skills: readonly string[] }
);

function resolveSettings(config: Config, declared: DeclaredSettings): TaskSettings {
  const settings = {
    harness: declared.harness ?? config.orchestrator.task.harness,
    model: declared.model ?? config.orchestrator.task.model,
    effort: declared.effort ?? config.orchestrator.task.effort,
    skill: declared.skill,
  };
  if (declared.execution === "harness") return { ...settings, execution: "harness" };
  return { ...settings, execution: "model", preload_skills: declared.preload_skills };
}
