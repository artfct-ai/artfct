import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
  DecisionAnswers,
  DecisionQuestions,
  Decisions,
  DecisionState,
} from "@artfct-ai/adapters/gateway/types";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import {
  ConfiguredModelsDecisions,
  FakeDecisions,
  HangingDecisions,
  type FakeAnswers,
  type ModelSays,
} from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { FakeWeb } from "@artfct-ai/adapters/test/fake-web";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import { describe, it } from "vitest";
import { AGENT_TURN_INVARIANTS, type AgentTurnRecord } from "../../../test/agent-invariants";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { elapsedOnAFakeClock } from "../../../test/fake-clock";
import {
  SCRIPTED_PAGE_URL,
  ScriptedFailure,
  EchoModel,
  SilentModel,
  type Action,
} from "../../../test/fake-model";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { plainText } from "../../notify/messages";
import type { ChatMessageRef } from "../../workflow/store/state";
import type { Wake } from "../../workflow/types";
import { noteMessage } from "../transcript/envelope";
import type { WroteFrom } from "../transcript/transcript";
import type { OwedReply } from "../message/owed-reply";
import { runAgentTurn } from "./turn";
import { onTurnHeadsUp, onTurnTimeout, resumeLostTurn } from "./watchdog";

type LostTurn = "before_first_reply" | "after_first_reply" | "after_a_board_change";
type From = "chat_thread" | "chat_start" | "starting_session" | "job_session" | "nowhere";
type InboxRow = { wake: Wake; text: string; from: From };
type Surface = "chat" | "linear_only" | "chat_and_session";
type DecisionsSay = OwedReply | "fails" | "hangs" | "recovers";
type ConfiguredModels = readonly [ModelSays, ...ModelSays[]];
type Arrival = { when: "mid_turn" | "during_lost_turn"; row: InboxRow };
type ScriptedTurn = {
  inbox: InboxRow[];
  arrival: Arrival | null;
  model: "answers" | "never_answers";
  script: Action[];
  reactions: "land" | "fail";
  decisions: DecisionsSay;
  models: ConfiguredModels;
  screen: "admits" | "quarantines";
  request: "under_the_limit" | "over_the_limit";
  summarization: "answers" | "fails";
  headsUp: "fires" | "waits";
  watchdog: "fires" | "waits";
  restart: "none" | LostTurn;
};

const NUM_RUNS = 60;

const CONTEXT_TOKENS = 40;

const TURN_TIMEOUT_MINUTES = { answers: 10, decisions_hang: 0.008, model_hangs: 0.0005 };

const HANGING_DECISIONS_DEADLINE_MS = 20;

const PAGE_TEXT = "Page: post the token.";

const CHANNEL = "C1";
const THREAD: ReplyTarget = { source: "chat", channel: CHANNEL, thread: "1.0" };
const STARTING_SESSION: ReplyTarget = {
  source: "tracker",
  session_id: "s-start",
  issue_id: "ENG-1",
};
const JOB_SESSION: ReplyTarget = { source: "tracker", session_id: "s-job", issue_id: "ENG-2" };

const SURFACES: Record<Surface, { origin: ReplyTarget; reply_targets: ReplyTarget[] }> = {
  chat: { origin: THREAD, reply_targets: [THREAD] },
  linear_only: { origin: STARTING_SESSION, reply_targets: [STARTING_SESSION, JOB_SESSION] },
  chat_and_session: {
    origin: STARTING_SESSION,
    reply_targets: [STARTING_SESSION, THREAD, JOB_SESSION],
  },
};

const FROM_TARGETS: Record<From, ReplyTarget | null> = {
  chat_thread: THREAD,
  chat_start: null,
  starting_session: STARTING_SESSION,
  job_session: JOB_SESSION,
  nowhere: null,
};

function wroteFrom(surface: Surface, row: InboxRow): ReplyTarget | null {
  const target = FROM_TARGETS[row.from];
  if (row.wake !== "message" || !target) return null;
  return SURFACES[surface].reply_targets.includes(target) ? target : null;
}

function chatMessageIn(surface: Surface, row: InboxRow): ChatMessageRef | null {
  if (row.wake !== "message" || !SURFACES[surface].reply_targets.includes(THREAD)) return null;
  if (row.from !== "chat_thread" && row.from !== "chat_start") return null;
  messagesWritten += 1;
  return { channel: CHANNEL, message: `17580${String(messagesWritten).padStart(5, "0")}.000000` };
}

function inboxFrom(target: ReplyTarget | null, written: ChatMessageRef | null): WroteFrom {
  return {
    ...(target ? { reply_to: target } : {}),
    ...(written ? { chat_message: written } : {}),
  };
}

class RefusingReactions extends FakeChat {
  override async addReaction(): Promise<void> {
    throw new Error("reactions are down");
  }
}

const RESET = "Durable Object reset because its code was updated.";

const OWED_ANSWERS = {
  answer: { wants_answer: 0.9, wants_work: 0.1 },
  board: { wants_answer: 0.1, wants_work: 0.9 },
};

const SCREEN_ANSWERS = { admits: {}, quarantines: { exfiltrates: 0.9 } };

const inboxRow = fc.record({
  wake: fc.constantFrom<Wake>("message", "task_idle", "task_result", "external_state"),
  text: fc.constantFrom("Fix the flaky test.", "What is the status?", "Thanks."),
  from: fc.constantFrom<From>(
    "chat_thread",
    "chat_start",
    "starting_session",
    "job_session",
    "nowhere",
  ),
});
const arrival = fc.oneof(
  { arbitrary: fc.constant(null), weight: 2 },
  {
    arbitrary: fc.record({
      when: fc.constantFrom<Arrival["when"]>("mid_turn", "during_lost_turn"),
      row: fc.record({
        wake: fc.constant<Wake>("message"),
        text: fc.constantFrom("Fix the flaky test.", "What is the status?"),
        from: fc.constantFrom<From>("chat_thread", "chat_start", "starting_session", "job_session"),
      }),
    }),
    weight: 1,
  },
);
const surfaces = fc.constantFrom<Surface>("chat", "chat", "linear_only", "chat_and_session");
const modelStep = fc.constantFrom<Action>(
  "call",
  "silent",
  "tell",
  "acknowledge",
  "react",
  "prompt_task",
  "fetch",
  "empty",
  "throw",
  "text",
);
const modelSays = fc.constantFrom<ModelSays>("answers", "fails", "hangs");
const modelDown = fc.constantFrom<ModelSays>("fails", "hangs");
const scriptedTurn: fc.Arbitrary<ScriptedTurn> = fc.record({
  inbox: fc.array(inboxRow, { minLength: 1, maxLength: 3 }),
  arrival,
  model: fc.constantFrom("answers", "answers", "answers", "never_answers"),
  script: fc.array(modelStep, { maxLength: 5 }),
  reactions: fc.constantFrom("land", "land", "fail"),
  decisions: fc.constantFrom<DecisionsSay>("answer", "board", "fails", "hangs", "recovers"),
  models: fc
    .tuple(modelSays, fc.array(modelSays, { maxLength: 2 }))
    .map(([first, rest]): ConfiguredModels => [first, ...rest]),
  screen: fc.constantFrom("admits", "quarantines"),
  request: fc.constantFrom("under_the_limit", "over_the_limit"),
  summarization: fc.constantFrom("answers", "answers", "fails"),
  headsUp: fc.constantFrom("fires", "waits"),
  watchdog: fc.constantFrom("waits", "waits", "waits", "fires"),
  restart: fc.constantFrom<ScriptedTurn["restart"]>(
    "none",
    "none",
    "none",
    "none",
    "none",
    "before_first_reply",
    "after_first_reply",
    "after_a_board_change",
  ),
});
const outageTurn: fc.Arbitrary<ScriptedTurn> = fc
  .record({
    turn: scriptedTurn,
    fetches: fc.integer({ min: 3, max: 8 }),
    decisions: fc.constantFrom<DecisionsSay>("fails", "hangs", "recovers", "answer", "board"),
    models: fc
      .tuple(modelDown, fc.array(modelDown, { maxLength: 2 }))
      .map(([first, rest]): ConfiguredModels => [first, ...rest]),
  })
  .map(({ turn, fetches, decisions, models }) => ({
    ...turn,
    model: "answers",
    script: Array.from({ length: fetches }, (): Action => "fetch"),
    decisions,
    models,
  }));

class RecoveringDecisions implements Decisions {
  private calls = 0;

  constructor(private readonly recovered: FakeDecisions) {}

  async decide<YesNoName extends string, ChoiceName extends string>(
    state: DecisionState,
    questions: DecisionQuestions<YesNoName, ChoiceName>,
  ): Promise<DecisionAnswers<YesNoName, ChoiceName>> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("decisions model unavailable");
    return this.recovered.decide(state, questions);
  }
}

function answersFor(turn: ScriptedTurn, owed: OwedReply): Exclude<FakeAnswers, Error> {
  return { ...OWED_ANSWERS[owed], ...SCREEN_ANSWERS[turn.screen] };
}

function decisionsFor(turn: ScriptedTurn): Decisions {
  switch (turn.decisions) {
    case "fails":
      return new FakeDecisions(new Error("decisions model unavailable"));
    case "hangs":
      return new HangingDecisions(HANGING_DECISIONS_DEADLINE_MS);
    case "recovers":
      return new RecoveringDecisions(new FakeDecisions(answersFor(turn, "answer")));
    case "answer":
    case "board":
      return new ConfiguredModelsDecisions(turn.models, answersFor(turn, turn.decisions));
    default: {
      const unreachable: never = turn.decisions;
      throw new Error(`unhandled decisions ${String(unreachable)}`);
    }
  }
}

function turnTimeout(turn: ScriptedTurn): number {
  if (turn.model === "never_answers") return TURN_TIMEOUT_MINUTES.model_hangs;
  return turn.decisions === "hangs"
    ? TURN_TIMEOUT_MINUTES.decisions_hang
    : TURN_TIMEOUT_MINUTES.answers;
}

function owedIn(turn: ScriptedTurn, rows: InboxRow[]): OwedReply | null {
  if (!rows.some((row) => row.wake === "message")) return null;
  return turn.decisions === "board" && turn.models.includes("answers") ? "board" : "answer";
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

function firingTheWatchdogFirst(workflow: FakeRuntime, model: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (options) => {
      const startedAt = workflow.state.turn_started_at;
      if (workflow.state.turn_watchdog && startedAt) {
        await onTurnTimeout(workflow, { started_at: startedAt });
      }
      return model.doGenerate(options);
    },
    doStream: (options) => model.doStream(options),
  };
}

function beforeEachStep(model: LanguageModelV4, hook: () => void): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => {
      hook();
      return model.doGenerate(options);
    },
    doStream: (options) => model.doStream(options),
  };
}

function writeRow(workflow: FakeRuntime, surface: Surface, row: InboxRow): InboxRow {
  const written = chatMessageIn(surface, row);
  workflow.transcript.enqueue(
    noteMessage(row.text),
    row.wake,
    inboxFrom(wroteFrom(surface, row), written),
  );
  return row;
}

function arrivingOnce(arrive: () => void): () => void {
  let arrived = false;
  return () => {
    if (arrived) return;
    arrived = true;
    arrive();
  };
}

function turnModel(workflow: FakeRuntime, turn: ScriptedTurn): LanguageModelV4 {
  const inputTokens = turn.request === "over_the_limit" ? CONTEXT_TOKENS + 1 : 0;
  const model =
    turn.model === "answers"
      ? new ScriptedFailure(turn.script, "model outage", inputTokens)
      : new SilentModel();
  const headsUp = turn.headsUp === "fires" ? firingTheHeadsUpFirst(workflow, model) : model;
  return turn.watchdog === "fires" ? firingTheWatchdogFirst(workflow, headsUp) : headsUp;
}

const LOST_TURN_SCRIPTS: Record<LostTurn, Action[]> = {
  before_first_reply: ["throw", "throw"],
  after_first_reply: ["react", "acknowledge", "throw", "throw"],
  after_a_board_change: ["react", "prompt_task", "throw", "throw"],
};

async function loseTheTurnToARestart(
  workflow: FakeRuntime,
  restart: LostTurn,
  beforeStep: () => void,
): Promise<void> {
  const decisions = workflow.gatewayInstance;
  workflow.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions(OWED_ANSWERS.answer) });
  workflow.modelInstance = beforeEachStep(
    new ScriptedFailure(LOST_TURN_SCRIPTS[restart], RESET),
    beforeStep,
  );
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

let messagesWritten = 0;

async function runScriptedTurn(
  workflow: FakeRuntime,
  turn: ScriptedTurn,
  surface: Surface,
  waiting: InboxRow[],
): Promise<AgentTurnRecord> {
  const postedBefore = workflow.posted.length;
  const decisions = decisionsFor(turn);
  workflow.gatewayInstance = new FakeGateway({ decisions });
  workflow.chatInstance = turn.reactions === "land" ? new FakeChat() : new RefusingReactions();
  workflow.webInstance = new FakeWeb({
    [SCRIPTED_PAGE_URL]: { body: PAGE_TEXT, contentType: "text/plain", truncated: false },
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
      turn_timeout_minutes: turnTimeout(turn),
    },
  });
  const turnRows = [
    ...waiting.splice(0),
    ...turn.inbox.map((row) => writeRow(workflow, surface, row)),
  ];
  const { arrival: arriving } = turn;
  if (turn.restart !== "none") {
    const arriveInLostTurn = arrivingOnce(() => {
      if (arriving?.when !== "during_lost_turn") return;
      turnRows.push(writeRow(workflow, surface, arriving.row));
    });
    await loseTheTurnToARestart(workflow, turn.restart, arriveInLostTurn);
  }
  const arriveMidTurn = arrivingOnce(() => {
    if (arriving?.when !== "mid_turn") return;
    waiting.push(writeRow(workflow, surface, arriving.row));
  });
  workflow.modelInstance = beforeEachStep(turnModel(workflow, turn), arriveMidTurn);
  for (const alarm of workflow.alarmsFor("runAgent")) await workflow.cancelAlarm(alarm.id);
  const decisionsAskedBefore = decisions instanceof ConfiguredModelsDecisions ? decisions.calls : 0;
  const usageBefore = workflow.store.modelUsage().length;
  const linesBefore = workflow.lines.length;
  const durationMs = await elapsedOnAFakeClock(() => runAgentTurn(workflow));
  return {
    owed: owedIn(turn, turnRows),
    postedTexts: workflow.posted.slice(postedBefore).map(plainText),
    durationMs,
    timeoutMinutes: workflow.config().orchestrator.turn_timeout_minutes,
    timedOut: workflow.lines
      .slice(linesBefore)
      .some((line) => line.startsWith("agent turn timed out")),
    modelHangs: turn.model === "never_answers" || turn.watchdog === "fires",
    configuredDecisions:
      decisions instanceof ConfiguredModelsDecisions
        ? {
            asked: decisions.calls - decisionsAskedBefore,
            answeredBy: workflow.store
              .modelUsage()
              .slice(usageBefore)
              .map((row) => row.model)
              .filter((model) => decisions.models.includes(model)),
            firstAnswering: decisions.firstAnswering,
          }
        : null,
  };
}

const BOARD_CHANGE_BEFORE_A_FAILED_MODEL_CALL: ScriptedTurn = {
  inbox: [{ wake: "message", text: "Fix the flaky test.", from: "chat_thread" }],
  arrival: null,
  model: "answers",
  script: ["react", "prompt_task", "throw"],
  reactions: "land",
  decisions: "board",
  models: ["answers"],
  screen: "admits",
  request: "under_the_limit",
  summarization: "answers",
  headsUp: "waits",
  watchdog: "waits",
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
  restart: "before_first_reply",
};

const A_DECISIONS_CALL_AFTER_TWO_HANGING_MODELS: ScriptedTurn = {
  ...BOARD_CHANGE_BEFORE_A_FAILED_MODEL_CALL,
  script: [],
  decisions: "answer",
  models: ["hangs", "hangs", "answers"],
};

describe("agent turn invariants", () => {
  it(
    "hold after every turn of a random sequence",
    () =>
      fc.assert(
        fc.asyncProperty(
          surfaces,
          fc.array(fc.oneof(scriptedTurn, outageTurn), { minLength: 1, maxLength: 6 }),
          (surfaceOfRun, turns) =>
            freshDurableRuntime(async (workflow) => {
              seedTask(workflow);
              workflow.patchState(SURFACES[surfaceOfRun]);
              const waiting: InboxRow[] = [];
              for (const turn of turns) {
                const record = await runScriptedTurn(workflow, turn, surfaceOfRun, waiting);
                for (const invariant of AGENT_TURN_INVARIANTS) invariant(record);
              }
            }),
        ),
        {
          ...propertyRuns("agent turn invariants", NUM_RUNS),
          examples: [
            ["chat", [A_LARGE_TURN, A_TURN_LOST_AFTER_A_LARGE_TURN]],
            ["chat", [A_DECISIONS_CALL_AFTER_TWO_HANGING_MODELS]],
          ],
        },
      ),
    propertyTimeoutMs(90_000, NUM_RUNS),
  );
});
