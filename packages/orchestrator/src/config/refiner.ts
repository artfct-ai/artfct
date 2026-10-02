import { EFFORTS, HARNESSES } from "@artfct-ai/adapters/harness/types";
import { z } from "zod";
import { SkillRef } from "./skill-frontmatter";

/**
 * One agent step inside a stage: a named run with its own harness, model, effort, and skill. The
 * list position orders the refiners; `name` is a board and routing label only.
 */
export const RefinerEntry = z.object({
  name: z.string().min(1),
  harness: z.enum(HARNESSES).optional(),
  model: z.string().optional(),
  effort: z.enum(EFFORTS).optional(),
  /** Skill the refiner is told to run. */
  skill: SkillRef,
});
export type RefinerEntry = z.infer<typeof RefinerEntry>;

/** A reviewer whose findings go to the author to weigh. The default mode. */
const FindingsEntry = RefinerEntry.extend({
  mode: z.literal("findings").default("findings"),
}).strict();

/**
 * A reviewer that rejects or approves and posts nothing. `rejects_when` is the yes or no
 * question code asks about its conclusion. A judge entry ends its segment.
 */
const JudgeEntry = RefinerEntry.extend({
  mode: z.literal("judge"),
  rejects_when: z.object({
    question: z.string().min(1),
    yes: z.string().min(1),
    no: z.string().min(1),
  }),
}).strict();
export type JudgeEntry = z.infer<typeof JudgeEntry>;

/** One reviewer, in one of the two modes. */
export const ReviewerEntry = z.union([JudgeEntry, FindingsEntry]);
export type ReviewerEntry = z.infer<typeof ReviewerEntry>;
