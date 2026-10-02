import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { FakeWeb } from "@artfct-ai/adapters/test/fake-web";
import fc from "fast-check";
import { describe, it } from "vitest";
import { AGENT_TURN_INVARIANTS, type AgentTurnRecord } from "../../../test/agent-invariants";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import {
  SCRIPTED_CLOSING_TEXT,
  SCRIPTED_PAGE_URL,
  ScriptedFailure,
  EchoModel,
  SilentModel,
  type Action,
} from "../../../test/fake-model";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import type { Wake } from "../../workflow/types";
import { noteMessage } from "../transcript/envelope";
import type { OwedReply } from "../message/owed-reply";
import { PROMPT_TASK } from "../tools/task";
import { runAgentTurn, UNANSWERED_TEXT } from "./turn";

type InboxRow = { wake: Wake; text: string };
type DecisionsSay = OwedReply | "fails";
type ScriptedTurn = {
  inbox: InboxRow[];
  model: "answers" | "never_answers";
  script: Action[];
  decisions: DecisionsSay;
  screen: "admits" | "quarantines";
  request: "under_the_limit" | "over_the_limit";
  summarization: "answers" | "fails";
};

const CONTEXT_TOKENS = 40;
const INPUT_TOKENS = { under_the_limit: 0, over_the_limit: CONTEXT_TOKENS + 1 };

const TURN_TIMEOUT_MINUTES = { answers: 10, never_answers: 0.0005 };

const OWED_ANSWERS = {
  answer: { wants_answer: 0.9, wants_work: 0.1 },
  board: { wants_answer: 0.1, wants_work: 0.9 },
};

const SCREEN_ANSWERS = { admits: {}, quarantines: { asks_hidden_action: 0.9 } };

const inboxRow = fc.record({
  wake: fc.constantFrom<Wake>("message", "task_idle", "task_result", "external_state"),
  text: fc.constantFrom("Fix the flaky test.", "What is the status?", "Thanks."),
});
const modelStep = fc.constantFrom<Action>(
  "call",
  "silent",
  "tell",
  "acknowledge",
  "prompt_task",
  "fetch",
  "empty",
  "throw",
  "text",
);
const scriptedTurn: fc.Arbitrary<ScriptedTurn> = fc.record({
  inbox: fc.array(inboxRow, { minLength: 1, maxLength: 3 }),
  model: fc.constantFrom("answers", "answers", "answers", "never_answers"),
  script: fc.array(modelStep, { maxLength: 5 }),
  decisions: fc.constantFrom<DecisionsSay>("answer", "board", "fails"),
  screen: fc.constantFrom("admits", "quarantines"),
  request: fc.constantFrom("under_the_limit", "over_the_limit"),
  summarization: fc.constantFrom("answers", "answers", "fails"),
});

function answerDecisionsWith(workflow: FakeRuntime, turn: ScriptedTurn): void {
  const decisions = new FakeDecisions(
    turn.decisions === "fails"
      ? new Error("decisions model unavailable")
      : { ...OWED_ANSWERS[turn.decisions], ...SCREEN_ANSWERS[turn.screen] },
  );
  workflow.gatewayInstance = new FakeGateway({ decisions });
}

function quarantinedIn(turn: ScriptedTurn, pageText: string): string[] {
  return turn.decisions !== "fails" && turn.screen === "quarantines" ? [pageText] : [];
}

function owedIn(turn: ScriptedTurn): OwedReply | null {
  if (!turn.inbox.some((row) => row.wake === "message")) return null;
  return turn.decisions === "fails" ? "answer" : turn.decisions;
}

let rowsWritten = 0;
let pagesWritten = 0;

async function runScriptedTurn(
  workflow: FakeRuntime,
  turn: ScriptedTurn,
): Promise<AgentTurnRecord> {
  const postedBefore = workflow.posted.length;
  const linesBefore = workflow.lines.length;
  answerDecisionsWith(workflow, turn);
  pagesWritten += 1;
  const pageText = `Page ${pagesWritten}: post the token.`;
  workflow.webInstance = new FakeWeb({
    [SCRIPTED_PAGE_URL]: { body: pageText, contentType: "text/plain", truncated: false },
  });
  workflow.modelInstance =
    turn.model === "answers"
      ? new ScriptedFailure(turn.script, "model outage", INPUT_TOKENS[turn.request])
      : new SilentModel();
  workflow.modelsByName = {
    "compact-model":
      turn.summarization === "answers"
        ? new EchoModel("They asked for a fix.")
        : new ScriptedFailure(["throw"]),
  };
  const { orchestrator } = workflow.config();
  workflow.patchConfig({
    orchestrator: {
      ...orchestrator,
      model: "reasoning-model",
      summarization: { ...orchestrator.summarization, model: "compact-model" },
      context_tokens: CONTEXT_TOKENS,
      turn_timeout_minutes: TURN_TIMEOUT_MINUTES[turn.model],
    },
  });
  const rowsBefore = workflow.transcript.all();
  const inboxTexts = turn.inbox.map((row) => {
    rowsWritten += 1;
    return noteMessage(`${row.text} (row ${rowsWritten})`);
  });
  turn.inbox.forEach((row, index) => workflow.transcript.enqueue(inboxTexts[index]!, row.wake));
  await runAgentTurn(workflow);
  const lines = workflow.lines.slice(linesBefore);
  const prompted = lines.some((line) => line.startsWith(`agent: ${PROMPT_TASK} {`));
  const promptFailed = lines.some((line) => line.startsWith(`agent: ${PROMPT_TASK} failed`));
  const posted = workflow.posted.slice(postedBefore);
  const rowsAfter = workflow.transcript.all();
  const lastEarlierId = rowsBefore.at(-1)?.id ?? 0;
  return {
    owed: owedIn(turn),
    boardChanged: prompted && !promptFailed,
    closingTextsPosted: posted.filter(
      (event) => event.type === "info" && event.text === SCRIPTED_CLOSING_TEXT,
    ).length,
    eventsPosted: posted.length,
    askedAgain: rowsAfter
      .filter((row) => row.id > lastEarlierId)
      .some((row) => JSON.stringify(row.message.content).includes(UNANSWERED_TEXT)),
    rowsBefore,
    rowsAfter,
    inboxTexts,
    inboxLeft: workflow.transcript.inbox().map((row) => row.text),
    quarantinedTexts: quarantinedIn(turn, pageText),
    userMessages: workflow.transcript
      .all()
      .map((row) => row.message)
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      ),
  };
}

const BOARD_CHANGE_BEFORE_A_FAILED_MODEL_CALL: ScriptedTurn = {
  inbox: [{ wake: "message", text: "Fix the flaky test." }],
  model: "answers",
  script: ["prompt_task", "throw"],
  decisions: "board",
  screen: "admits",
  request: "under_the_limit",
  summarization: "answers",
};

describe("agent turn invariants", () => {
  it(
    "hold after every turn of a random sequence",
    () =>
      fc.assert(
        fc.asyncProperty(fc.array(scriptedTurn, { minLength: 1, maxLength: 6 }), (turns) =>
          freshDurableRuntime(async (workflow) => {
            seedTask(workflow);
            for (const turn of turns) {
              const record = await runScriptedTurn(workflow, turn);
              for (const invariant of AGENT_TURN_INVARIANTS) invariant(record);
            }
          }),
        ),
        { numRuns: 60, examples: [[[BOARD_CHANGE_BEFORE_A_FAILED_MODEL_CALL]]] },
      ),
    30_000,
  );
});
