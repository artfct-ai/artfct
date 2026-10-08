import type { LanguageModelV4 } from "@ai-sdk/provider";
import { FakeDecisions, HangingDecisions } from "@artfct-ai/adapters/test/fake-decisions";
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
import { plainText } from "../../notify/messages";
import type { Wake } from "../../workflow/types";
import { noteMessage } from "../transcript/envelope";
import type { OwedReply } from "../message/owed-reply";
import { PROMPT_TASK } from "../tools/task";
import { runAgentTurn, UNANSWERED_TEXT } from "./turn";
import { onTurnHeadsUp, resumeLostTurn } from "./watchdog";

type InboxRow = { wake: Wake; text: string };
type DecisionsSay = OwedReply | "fails" | "hangs";
type ScriptedTurn = {
  inbox: InboxRow[];
  model: "answers" | "never_answers";
  script: Action[];
  decisions: DecisionsSay;
  screen: "admits" | "quarantines";
  request: "under_the_limit" | "over_the_limit";
  summarization: "answers" | "fails";
  headsUp: "fires" | "waits";
  restart: "none" | "mid_turn";
};

const CONTEXT_TOKENS = 40;
const INPUT_TOKENS = { under_the_limit: 0, over_the_limit: CONTEXT_TOKENS + 1 };

const TURN_TIMEOUT_MINUTES = { answers: 10, hangs: 0.0005 };

const THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;

const RESET = "Durable Object reset because its code was updated.";

const OWED_ANSWERS = {
  answer: { wants_answer: 0.9, wants_work: 0.1 },
  board: { wants_answer: 0.1, wants_work: 0.9 },
};

const SCREEN_ANSWERS = { admits: {}, quarantines: { exfiltrates: 0.9 } };

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
  decisions: fc.constantFrom<DecisionsSay>("answer", "board", "fails", "hangs"),
  screen: fc.constantFrom("admits", "quarantines"),
  request: fc.constantFrom("under_the_limit", "over_the_limit"),
  summarization: fc.constantFrom("answers", "answers", "fails"),
  headsUp: fc.constantFrom("fires", "waits"),
  restart: fc.constantFrom("none", "none", "none", "mid_turn"),
});

function answerDecisionsWith(workflow: FakeRuntime, turn: ScriptedTurn): void {
  workflow.gatewayInstance = new FakeGateway({ decisions: decisionsFor(turn) });
}

function decisionsFor(turn: ScriptedTurn): FakeDecisions | HangingDecisions {
  switch (turn.decisions) {
    case "fails":
      return new FakeDecisions(new Error("decisions model unavailable"));
    case "hangs":
      return new HangingDecisions();
    case "answer":
    case "board":
      return new FakeDecisions({ ...OWED_ANSWERS[turn.decisions], ...SCREEN_ANSWERS[turn.screen] });
    default: {
      const unreachable: never = turn.decisions;
      throw new Error(`unhandled decisions ${String(unreachable)}`);
    }
  }
}

function hangs(turn: ScriptedTurn): boolean {
  return turn.model === "never_answers" || turn.decisions === "hangs";
}

function quarantinedIn(turn: ScriptedTurn, pageText: string): string[] {
  if (turn.decisions === "hangs") return [pageText];
  return turn.decisions !== "fails" && turn.screen === "quarantines" ? [pageText] : [];
}

function personWrote(turn: ScriptedTurn): boolean {
  return turn.inbox.some((row) => row.wake === "message");
}

function owedIn(turn: ScriptedTurn): OwedReply | null {
  if (!personWrote(turn)) return null;
  return turn.decisions === "fails" || turn.decisions === "hangs" ? "answer" : turn.decisions;
}

function firingTheHeadsUpFirst(workflow: FakeRuntime, model: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (options) => {
      const startedAt = workflow.state.turn_started_at;
      if (workflow.state.turn_heads_up && startedAt) {
        await onTurnHeadsUp(workflow, { started_at: startedAt });
      }
      return model.doGenerate(options);
    },
    doStream: (options) => model.doStream(options),
  };
}

function turnModel(workflow: FakeRuntime, turn: ScriptedTurn): LanguageModelV4 {
  const model =
    turn.model === "answers"
      ? new ScriptedFailure(turn.script, "model outage", INPUT_TOKENS[turn.request])
      : new SilentModel();
  return turn.headsUp === "fires" ? firingTheHeadsUpFirst(workflow, model) : model;
}

async function loseTheTurnToARestart(workflow: FakeRuntime): Promise<void> {
  const decisions = workflow.gatewayInstance;
  workflow.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions(OWED_ANSWERS.answer) });
  workflow.modelInstance = new ScriptedFailure(["throw", "throw"], RESET);
  await runAgentTurn(workflow).then(
    () => {
      throw new Error("the turn was meant to be lost to the restart");
    },
    (error: unknown) => {
      if (!String(error).includes(RESET)) throw error;
    },
  );
  workflow.gatewayInstance = decisions;
  const notesBefore = workflow.notes.length;
  await resumeLostTurn(workflow);
  for (const note of workflow.notes.slice(notesBefore)) {
    workflow.transcript.enqueue(note.text, note.wake);
  }
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
      turn_timeout_minutes: TURN_TIMEOUT_MINUTES[hangs(turn) ? "hangs" : "answers"],
    },
  });
  const rowsBefore = workflow.transcript.all();
  const inboxTexts = turn.inbox.map((row) => {
    rowsWritten += 1;
    return noteMessage(`${row.text} (row ${rowsWritten})`);
  });
  turn.inbox.forEach((row, index) => workflow.transcript.enqueue(inboxTexts[index]!, row.wake));
  if (personWrote(turn)) workflow.chatSession = "processing";
  if (turn.restart === "mid_turn") await loseTheTurnToARestart(workflow);
  workflow.modelInstance = turnModel(workflow, turn);
  const started = Date.now();
  await runAgentTurn(workflow);
  const durationMs = Date.now() - started;
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
    postedTexts: posted.map(plainText),
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
    chatSessionAfter: workflow.chatSession,
    durationMs,
    timeoutMinutes: workflow.config().orchestrator.turn_timeout_minutes,
    timedOut: lines.some((line) => line.startsWith("agent turn timed out")),
    resumedLostTurn: turn.restart === "mid_turn",
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
  headsUp: "waits",
  restart: "none",
};

const A_LARGE_TURN: ScriptedTurn = {
  ...BOARD_CHANGE_BEFORE_A_FAILED_MODEL_CALL,
  script: [],
  decisions: "answer",
  request: "over_the_limit",
};

const A_TURN_LOST_AFTER_A_LARGE_TURN: ScriptedTurn = {
  ...A_LARGE_TURN,
  request: "under_the_limit",
  headsUp: "fires",
  restart: "mid_turn",
};

describe("agent turn invariants", () => {
  it(
    "hold after every turn of a random sequence",
    () =>
      fc.assert(
        fc.asyncProperty(fc.array(scriptedTurn, { minLength: 1, maxLength: 6 }), (turns) =>
          freshDurableRuntime(async (workflow) => {
            seedTask(workflow);
            workflow.state.reply_targets = [THREAD];
            for (const turn of turns) {
              const record = await runScriptedTurn(workflow, turn);
              for (const invariant of AGENT_TURN_INVARIANTS) invariant(record);
            }
          }),
        ),
        {
          numRuns: 60,
          examples: [
            [[BOARD_CHANGE_BEFORE_A_FAILED_MODEL_CALL]],
            [[A_LARGE_TURN, A_TURN_LOST_AFTER_A_LARGE_TURN]],
          ],
        },
      ),
    30_000,
  );
});
