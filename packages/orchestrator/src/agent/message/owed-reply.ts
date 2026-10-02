import type { YesNoQuestion } from "@artfct-ai/adapters/gateway/types";
import type { ArtifactKind } from "@artfct-ai/contracts/types";
import { askDecisions } from "../../decisions/ask";
import { inputArtifactFrom, inputArtifactQuestion } from "./input-artifact";
import type { WorkflowRuntime } from "../../workflow/types";

/**
 * What a person's message is owed at the end of the turn. `answer` is words back. `board` is
 * the board alone, so closing text after a board change is noise.
 */
export type OwedReply = "answer" | "board";

/** The `purpose` a owed-reply call records its usage under. */
export const OWED_REPLY_PURPOSE = "owed_reply";

/**
 * What the decisions model reads in a person's message: the owed reply, whether the message
 * requests work, whether it names a model for the work, and the kind of input artifact it links
 * or names. A message that does not request work leaves the planning rules out of the prompt.
 */
export type PersonMessage = {
  owed: OwedReply;
  requestsWork: boolean;
  namesModel: boolean;
  inputArtifact: ArtifactKind | null;
};

/** How a message reads when the decisions model gives no answer. Nothing is dropped or hidden on a guess. */
export const UNREAD_MESSAGE: PersonMessage = {
  owed: "answer",
  requestsWork: true,
  namesModel: false,
  inputArtifact: null,
};

/** At or above this, a question's answer is clearly yes. */
const CLEARLY_YES = 0.6;
/** At or below this, a question's answer is clearly no. */
const CLEARLY_NO = 0.4;

/** The questions asked of every message a person writes. */
export const OWED_REPLY_QUESTIONS = {
  wants_answer: {
    instructions:
      "Does `message` ask the assistant for information that must be given back in words, such as a question, a status check, or a request for options or an opinion?",
    yes: "The person wants to be told something: an answer, a status, an explanation, or suggestions.",
    no: "The person only gives an instruction, a decision, feedback to apply, an approval, or thanks.",
  },
  wants_work: {
    instructions:
      "Does `message` tell the assistant to start work, change work that exists, apply feedback, or move on to the next stage?",
    yes: "The person requests a task, gives a change or decision to fold into a document or code, approves, or says to continue.",
    no: "The person only asks for information, or makes small talk, or writes to someone else.",
  },
  names_model: {
    instructions:
      "Does `message` name an AI model for the work to run on? A model can be named by family alone, such as Opus, Sonnet, Haiku, Fable, GLM, Gemini, GPT, Kimi, or DeepSeek, or with a version, such as glm 5.3 or opus-5-5.",
    yes: "The person names a model or a model family the work should use.",
    no: "The person names no model.",
  },
} satisfies Record<string, YesNoQuestion>;

/** The owed reply two probabilities stand for. Anything short of clear work with no question is `answer`. */
export function owedReplyFrom(probabilities: {
  wants_answer: number;
  wants_work: number;
}): OwedReply {
  const workOnly =
    probabilities.wants_work >= CLEARLY_YES && probabilities.wants_answer <= CLEARLY_NO;
  return workOnly ? "board" : "answer";
}

/** True unless the probability says the message clearly requests no work. */
export function requestsWorkFrom(probabilities: { wants_work: number }): boolean {
  return probabilities.wants_work > CLEARLY_NO;
}

/**
 * Why a turn's closing text stays off the channels, or null when it is the person's answer.
 * `owed` is null when nobody wrote. `boardChanged` is true when the turn started or prompted a task.
 */
export function closingTextWithheld(owed: OwedReply | null, boardChanged: boolean): string | null {
  if (owed === null) return "nobody wrote";
  if (owed === "board" && boardChanged) return "the board is the reply";
  return null;
}

/** True when the probability says the message clearly names a model. */
export function namesModelFrom(probabilities: { names_model: number }): boolean {
  return probabilities.names_model >= CLEARLY_YES;
}

/**
 * Ask the decisions model what the person's message is owed, whether it requests work, whether it
 * names a model, and which kind of input artifact it links or names.
 */
export async function readPersonMessage(
  workflow: WorkflowRuntime,
  message: string,
): Promise<PersonMessage> {
  const answers = await askDecisions(
    workflow,
    OWED_REPLY_PURPOSE,
    { message },
    {
      yesNo: OWED_REPLY_QUESTIONS,
      choices: { artifact: inputArtifactQuestion(workflow.workflowDefinition().stages) },
    },
  );
  if (!answers) return UNREAD_MESSAGE;
  const { probabilities, choices } = answers;
  const owed = owedReplyFrom(probabilities);
  const requestsWork = requestsWorkFrom(probabilities);
  const namesModel = namesModelFrom(probabilities);
  const inputArtifact = inputArtifactFrom(choices.artifact);
  const answer = probabilities.wants_answer.toFixed(2);
  const work = probabilities.wants_work.toFixed(2);
  const model = probabilities.names_model.toFixed(2);
  const artifact = `${choices.artifact.option} ${choices.artifact.probability.toFixed(2)}`;
  workflow.log(
    null,
    `owed reply ${owed}, requests work ${requestsWork ? "yes" : "no"}, names a model ${namesModel ? "yes" : "no"}, input artifact ${inputArtifact ?? "none"}: answer=${answer} work=${work} model=${model} artifact=${artifact}`,
  );
  return { owed, requestsWork, namesModel, inputArtifact };
}
