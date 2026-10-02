import type { Choice, ChoiceQuestion } from "@artfct-ai/adapters/gateway/types";
import { ARTIFACT_KINDS, type ArtifactKind } from "@artfct-ai/contracts/types";
import type { Stage } from "../../config/stage";

/** The option for a message without an input artifact. */
const NO_ARTIFACT = "none";

/** A pick below this probability does not set the start stage. */
const CLEAR_CHOICE = 0.7;

const INSTRUCTIONS =
  "A person writes `message` to a software engineering assistant. Which kind of existing artifact does `message` link or name as the thing to work from?";

/** What each kind covers. Each description separates its kind from the others. */
const KIND_OPTIONS: Record<ArtifactKind, string> = {
  pull: "A pull request to keep working on, by link or by number, such as 'PR #47'.",
  page: "A document to work from, by link, such as a design doc, a plan, or a spec. A tracker issue or a tracker project is not a document.",
  issues:
    "One tracker issue named by key, such as ENG-42, or by link. Or a tracker project whose issues are the work.",
};

const NO_ARTIFACT_OPTION =
  "The message does not link or name an artifact to work from. It describes the work in words, links something as background only, or does not ask for work.";

/**
 * The choice question that asks which kind of input artifact a person's message links or names. It
 * offers only the kinds that one of the stages produces.
 */
export function inputArtifactQuestion(stages: readonly Stage[]): ChoiceQuestion {
  const kinds = [...new Set(stages.map((stage) => stage.artifact))];
  return {
    instructions: INSTRUCTIONS,
    options: {
      ...Object.fromEntries(kinds.map((kind) => [kind, KIND_OPTIONS[kind]])),
      [NO_ARTIFACT]: NO_ARTIFACT_OPTION,
    },
  };
}

/** The kind of input artifact a pick names. Returns null for a pick of none or an unclear pick. */
export function inputArtifactFrom(choice: Choice): ArtifactKind | null {
  if (choice.probability < CLEAR_CHOICE) return null;
  return ARTIFACT_KINDS.find((kind) => kind === choice.option) ?? null;
}

/**
 * The stage where a plan starts for a request with an artifact of `kind`. It is the stage after
 * the last stage that produces that kind. Returns null when no such stage exists.
 */
export function stageAfterInput(stages: readonly Stage[], kind: ArtifactKind): string | null {
  const producer = stages.findLastIndex((stage) => stage.artifact === kind);
  if (producer === -1) return null;
  return stages[producer + 1]?.name ?? null;
}
