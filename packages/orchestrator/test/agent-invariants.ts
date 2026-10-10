import type { SessionStatus } from "@artfct-ai/adapters/chat/types";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { OwedReply } from "../src/agent/message/owed-reply";
import type { TranscriptRow } from "../src/agent/transcript/transcript";
import { RECAP_MARKER, STUCK_TEXT } from "../src/agent/turn/turn";
import { plainText } from "../src/notify/messages";
import type { TaskEvent } from "../src/workflow/task/events";
import { HEADS_UP_TEXT, LOST_PLACE_TEXT, turnTimeoutText } from "../src/agent/turn/watchdog";

/** How long past its timeout a turn may take to stop its work and post. */
const DEADLINE_GRACE_MS = 1000;

/** What happened to one call at the decisions model: it was asked, it answered, or it failed. */
export type DecisionsEvent = "asked" | "answered" | "failed";

/** The tools that give the first reply. Every other tool is work. */
const FIRST_REPLY_TOOLS = ["acknowledge", "ask"];

/**
 * One model step of a turn and what happened while it ran. A post after the last step, such as
 * closing text, counts in the last step.
 */
export type TurnStep = {
  /** The tools the step ran. A call to a tool the step did not offer never runs. */
  ran: string[];
  /** The text of every event the step posted to the channels, in order. */
  postedTexts: string[];
  /** True when the step put the thumbs-up on a chat message a person wrote for the turn. */
  reacted: boolean;
};

/** What one agent turn was given and what it left on the channels. */
export type AgentTurnRecord = {
  /**
   * What the message of the person who wrote is owed. A resumed turn owes the people of the lost
   * turn and anyone who wrote while it was lost. Null on an unprompted turn.
   */
  owed: OwedReply | null;
  /** True when a tool of the turn started or prompted a task. */
  boardChanged: boolean;
  /** The text of every event the turn posted to the channels, in order. */
  postedTexts: string[];
  /** The model steps of the turn, in order, across every pass and attempt. */
  steps: TurnStep[];
  /** True when the turn told the model that the person got nothing, and ran it again. */
  askedAgain: boolean;
  /** How many times the turn posted closing text. */
  closingTextsPosted: number;
  /** The text of every inbox row the turn started with. Each one is unique. */
  inboxTexts: string[];
  /** The text of every inbox row after the turn. */
  inboxLeft: string[];
  /** The content of every user message in the transcript after the turn. */
  userMessages: string[];
  /** The transcript as the turn started, before the inbox moved into it. */
  rowsBefore: TranscriptRow[];
  /** The transcript after the turn. */
  rowsAfter: TranscriptRow[];
  /**
   * The text of every tool result and chat history message the screen quarantined or could not
   * check in the turn. Each one is unique.
   */
  quarantinedTexts: string[];
  /** The session status the chat thread was left in after the turn. Null when it never had one. */
  chatSessionAfter: SessionStatus | null;
  /** How long the turn ran. */
  durationMs: number;
  /** The turn timeout the turn ran under. */
  timeoutMinutes: number;
  /** True when the turn deadline ended the turn. */
  timedOut: boolean;
  /** What the lost turn this turn resumed owed. Null without a lost turn, or for an unprompted one. */
  lostTurnOwed: OwedReply | null;
  /** True when the model of the turn never returns on its own. */
  modelHangs: boolean;
  /**
   * The decisions calls of the turn on configured models that each answer, fail, or hang on every
   * call: how many were asked, the model each answer came from, and the first model that answers.
   * Null when the decisions model changes between calls.
   */
  configuredDecisions: {
    asked: number;
    answeredBy: string[];
    firstAnswering: string | null;
  } | null;
  /** Every call the turn asked the decisions model, and how each ended, in the order it happened. */
  decisionsEvents: DecisionsEvent[];
  /** Every `read_channel` result the turn wrote to the transcript. */
  chatHistoryReads: ChatHistoryRead[];
  /** True when the workflow has a chat thread. */
  chatThread: boolean;
  /** The tracker session the workflow started from, or null. */
  startingSession: string | null;
  /**
   * Every channel post of the turn, with the reply targets it went to and the tracker sessions the
   * people its turn answered wrote from when it posted.
   */
  deliveries: Array<{ event: TaskEvent; targets: ReplyTarget[]; answering: string[] }>;
};

/**
 * One `read_channel` result, and the text of every message of its read that the decisions model
 * answered for and did not flag.
 */
export type ChatHistoryRead = { result: string; admittedTexts: string[] };

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * Closing text is posted only as the answer to a person who wrote. An unprompted turn posts
 * none, a person owed the board alone gets none once the board changed, and no turn posts two.
 */
export function closingTextAnswersOnlyAPersonWhoWrote(turn: AgentTurnRecord): void {
  if (turn.closingTextsPosted === 0) return;
  if (turn.owed === null) {
    violated("closingTextAnswersOnlyAPersonWhoWrote", "an unprompted turn posted closing text");
  }
  if (turn.owed === "board" && turn.boardChanged) {
    violated(
      "closingTextAnswersOnlyAPersonWhoWrote",
      "a turn posted closing text after the board change that was the reply",
    );
  }
  if (turn.closingTextsPosted > 1) {
    violated("closingTextAnswersOnlyAPersonWhoWrote", "a turn posted closing text twice");
  }
}

/**
 * Every inbox row a turn started with is in the transcript exactly once after the turn, and no
 * longer in the inbox. This holds when the model fails and when the turn times out.
 */
export function everyInboxRowReachesTheTranscriptOnce(turn: AgentTurnRecord): void {
  for (const text of turn.inboxTexts) {
    const copies = turn.userMessages.join("\n").split(text).length - 1;
    if (copies !== 1) {
      violated(
        "everyInboxRowReachesTheTranscriptOnce",
        `"${text}" is in the transcript ${copies} times`,
      );
    }
    if (turn.inboxLeft.includes(text)) {
      violated("everyInboxRowReachesTheTranscriptOnce", `"${text}" is still in the inbox`);
    }
  }
}

/**
 * Compaction changes only rows from before this turn. After the turn, those rows are either
 * untouched or replaced, all of them, by one recap.
 */
export function compactionReplacesOnlyEarlierRows(turn: AgentTurnRecord): void {
  const lastEarlierId = turn.rowsBefore.at(-1)?.id ?? 0;
  const earlier = turn.rowsAfter.filter((row) => row.id <= lastEarlierId);
  if (JSON.stringify(earlier) === JSON.stringify(turn.rowsBefore)) return;
  const [recap, ...rest] = earlier;
  const content = recap?.message.content;
  const isRecap = typeof content === "string" && content.startsWith(RECAP_MARKER);
  if (!isRecap || rest.length > 0) {
    violated(
      "compactionReplacesOnlyEarlierRows",
      `the ${turn.rowsBefore.length} earlier rows became ${JSON.stringify(earlier)}`,
    );
  }
}

function toolCallIds(row: TranscriptRow, partType: "tool-call" | "tool-result"): string[] {
  const { content } = row.message;
  if (typeof content === "string") return [];
  return content.flatMap((part) => (part.type === partType ? [part.toolCallId] : []));
}

/**
 * Every tool call in the transcript has its result before the next user or assistant message.
 * A provider refuses a request that holds a tool call with no result.
 */
export function everyToolCallKeepsItsResult(turn: AgentTurnRecord): void {
  const open = new Set<string>();
  for (const row of turn.rowsAfter) {
    if (row.message.role !== "tool" && open.size > 0) {
      violated(
        "everyToolCallKeepsItsResult",
        `row ${row.id} follows the tool calls ${[...open].join(", ")} that have no result`,
      );
    }
    for (const id of toolCallIds(row, "tool-call")) open.add(id);
    for (const id of toolCallIds(row, "tool-result")) open.delete(id);
  }
  if (open.size > 0) {
    violated(
      "everyToolCallKeepsItsResult",
      `the transcript ends on the tool calls ${[...open].join(", ")} that have no result`,
    );
  }
}

/** True for a post that answers the humans. The heads-up and the restart notice are not answers. */
function isAnswerText(text: string): boolean {
  return text !== HEADS_UP_TEXT && text !== LOST_PLACE_TEXT;
}

/** The posts that answer the humans. */
function answersPosted(turn: AgentTurnRecord): string[] {
  return turn.postedTexts.filter(isAnswerText);
}

/** True when the step left the person who wrote a reply: an answer post, or the thumbs-up. */
function repliedIn(step: TurnStep): boolean {
  return step.reacted || step.postedTexts.some(isAnswerText);
}

/**
 * A turn on a person's message leaves them a reply: a post that reaches them, or the thumbs-up
 * reaction on their message. A heads-up or a restart notice is not one. It may end unanswered
 * only after the model was told so and ran once more.
 */
export function aPersonsTurnNeverEndsUnanswered(turn: AgentTurnRecord): void {
  if (turn.owed === null || turn.askedAgain) return;
  if (answersPosted(turn).length > 0 || turn.steps.some((step) => step.reacted)) return;
  violated(
    "aPersonsTurnNeverEndsUnanswered",
    "a person wrote, the turn left them nothing, and the model was not asked again",
  );
}

/**
 * In a turn where a person wrote, the first reply comes before any other tool call of the turn.
 * A step that runs any other tool follows a step that left them a post or the thumbs-up.
 */
export function aPersonHearsBackBeforeAnyWork(turn: AgentTurnRecord): void {
  if (turn.owed === null) return;
  const firstWork = turn.steps.findIndex((step) =>
    step.ran.some((tool) => !FIRST_REPLY_TOOLS.includes(tool)),
  );
  if (firstWork === -1) return;
  if (turn.steps.slice(0, firstWork).some(repliedIn)) return;
  const tools = turn.steps[firstWork]!.ran.join(", ");
  violated(
    "aPersonHearsBackBeforeAnyWork",
    `step ${firstWork + 1} ran ${tools} before the person who wrote heard back`,
  );
}

/**
 * A tool result the screen quarantined, or could not check, does not appear in any row of the
 * transcript. The model reads a fixed text in its place.
 */
export function quarantinedTextNeverEntersTheTranscript(turn: AgentTurnRecord): void {
  const transcript = JSON.stringify(turn.rowsAfter);
  for (const text of turn.quarantinedTexts) {
    if (transcript.includes(text)) {
      violated("quarantinedTextNeverEntersTheTranscript", `"${text}" is in the transcript`);
    }
  }
}

/**
 * After every turn, whatever its outcome, the chat thread is out of its working status. The
 * heads-up and the restart notice keep it up only while the turn runs.
 */
export function theWorkingStatusNeverOutlivesItsTurn(turn: AgentTurnRecord): void {
  if (turn.chatSessionAfter !== "processing") return;
  violated("theWorkingStatusNeverOutlivesItsTurn", "the turn ended with the thread still working");
}

/**
 * A person who wrote hears back by the turn timeout, even when a decisions call or a model
 * request never returns on its own. A turn the deadline ended posts the timeout text.
 */
export function aWaitingPersonHearsBackByTheTimeout(turn: AgentTurnRecord): void {
  if (turn.owed === null) return;
  const timeoutMs = turn.timeoutMinutes * 60_000;
  if (turn.durationMs > timeoutMs + DEADLINE_GRACE_MS) {
    violated(
      "aWaitingPersonHearsBackByTheTimeout",
      `the turn ran ${turn.durationMs} ms under a timeout of ${timeoutMs} ms`,
    );
  }
  if (!turn.timedOut || turn.postedTexts.includes(turnTimeoutText(turn.timeoutMinutes))) return;
  violated(
    "aWaitingPersonHearsBackByTheTimeout",
    "the deadline ended the turn and it said nothing",
  );
}

/**
 * A turn lost with its Durable Object while a person waited is picked up again: their chat thread
 * hears the restart notice, and the resumed turn answers them as the lost turn would have.
 */
export function aResumedTurnAnswersWhatItsLostTurnOwed(turn: AgentTurnRecord): void {
  if (turn.lostTurnOwed === null) return;
  if (turn.chatThread && !turn.postedTexts.includes(LOST_PLACE_TEXT)) {
    violated(
      "aResumedTurnAnswersWhatItsLostTurnOwed",
      "the person did not hear the restart notice",
    );
  }
  if (answersPosted(turn).length > 0 || turn.boardChanged || turn.askedAgain) return;
  violated(
    "aResumedTurnAnswersWhatItsLostTurnOwed",
    "the resumed turn left the person of the lost turn nothing",
  );
}

/**
 * A person who wrote gets the agent's answer, not the timeout text, whenever the model answers.
 * This holds when every decisions call fails or never returns.
 */
export function aPersonGetsTheAnswerDuringADecisionsOutage(turn: AgentTurnRecord): void {
  if (turn.owed === null || turn.modelHangs || !turn.timedOut) return;
  violated(
    "aPersonGetsTheAnswerDuringADecisionsOutage",
    "the model answered and the turn still timed out",
  );
}

/**
 * A decisions call takes its site's fallback only after every configured model failed. While a
 * configured model answers, every call of the turn gets the answer of the first one that does.
 */
export function aDecisionsCallFallsBackOnlyAfterEveryModelFailed(turn: AgentTurnRecord): void {
  const calls = turn.configuredDecisions;
  if (calls === null || calls.firstAnswering === null || turn.timedOut) return;
  const fellBack = calls.asked - calls.answeredBy.length;
  if (fellBack > 0) {
    violated(
      "aDecisionsCallFallsBackOnlyAfterEveryModelFailed",
      `${fellBack} of ${calls.asked} decisions calls took their fallback while ${calls.firstAnswering} answers`,
    );
  }
  const skipped = calls.answeredBy.find((model) => model !== calls.firstAnswering);
  if (skipped === undefined) return;
  violated(
    "aDecisionsCallFallsBackOnlyAfterEveryModelFailed",
    `${skipped} answered a call that ${calls.firstAnswering} answers first`,
  );
}

/**
 * After a decisions call fails in a turn, every later decisions call in that turn takes its
 * fallback at once, without asking the decisions model.
 */
export function laterDecisionsCallsFallBackOnceOneFails(turn: AgentTurnRecord): void {
  const failedAt = turn.decisionsEvents.indexOf("failed");
  if (failedAt === -1) return;
  const askedLater = turn.decisionsEvents.slice(failedAt).filter((event) => event === "asked");
  if (askedLater.length === 0) return;
  violated(
    "laterDecisionsCallsFallBackOnceOneFails",
    `${askedLater.length} decisions calls asked the model after a call of the turn failed`,
  );
}

/**
 * A flagged message never removes another message from a chat history read. Every message the
 * decisions model answered for and did not flag is in its read.
 */
export function aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead(
  turn: AgentTurnRecord,
): void {
  for (const read of turn.chatHistoryReads) {
    const missing = read.admittedTexts.filter((text) => !read.result.includes(text));
    if (missing.length === 0) continue;
    violated(
      "aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead",
      `${missing.length} admitted messages are missing from the read: ${missing.join(" | ")}`,
    );
  }
}

const ASKS_AND_FAILURES: TaskEvent["type"][] = [
  "question",
  "artifact_ready",
  "failed",
  "workflow_failed",
];

function sessionsOf(targets: ReplyTarget[]): string[] {
  return targets.flatMap((target) => (target.source === "tracker" ? [target.session_id] : []));
}

/** True for a post that answers the people who wrote, not a notice about the turn itself. */
function isAnswer(turn: AgentTurnRecord, event: TaskEvent): boolean {
  const text = plainText(event);
  const notices = [
    HEADS_UP_TEXT,
    LOST_PLACE_TEXT,
    STUCK_TEXT,
    turnTimeoutText(turn.timeoutMinutes),
  ];
  return !notices.includes(text);
}

/**
 * The turn arm of the session answer rule. With a chat thread, the turn's answers reach the chat
 * threads and no session. Without one, they reach the sessions people wrote from, and a session
 * gets a post only when a person wrote there, or as the starting session for an ask or failure.
 */
export function sessionMessageWithoutAnAuthorIsAnswered(turn: AgentTurnRecord): void {
  for (const { event, targets, answering } of turn.deliveries) {
    const sessions = sessionsOf(targets);
    if (turn.chatThread) {
      if (sessions.length > 0) {
        violated(
          "sessionMessageWithoutAnAuthorIsAnswered",
          `"${plainText(event)}" reached ${sessions.join(", ")} beside the chat thread`,
        );
      }
      if (isAnswer(turn, event) && !targets.some((target) => target.source === "chat")) {
        violated(
          "sessionMessageWithoutAnAuthorIsAnswered",
          `"${plainText(event)}" did not reach the chat thread`,
        );
      }
      continue;
    }
    const startingAsk = ASKS_AND_FAILURES.includes(event.type) ? turn.startingSession : null;
    const stray = sessions.filter(
      (session) => !answering.includes(session) && session !== startingAsk,
    );
    if (stray.length > 0) {
      violated(
        "sessionMessageWithoutAnAuthorIsAnswered",
        `"${plainText(event)}" reached ${stray.join(", ")}, where nobody wrote`,
      );
    }
    if (!isAnswer(turn, event)) continue;
    const missed = answering.filter((session) => !sessions.includes(session));
    if (missed.length > 0) {
      violated(
        "sessionMessageWithoutAnAuthorIsAnswered",
        `"${plainText(event)}" did not reach ${missed.join(", ")}`,
      );
    }
  }
}

/** Every agent turn invariant. */
export const AGENT_TURN_INVARIANTS = [
  closingTextAnswersOnlyAPersonWhoWrote,
  everyInboxRowReachesTheTranscriptOnce,
  compactionReplacesOnlyEarlierRows,
  everyToolCallKeepsItsResult,
  aPersonsTurnNeverEndsUnanswered,
  aPersonHearsBackBeforeAnyWork,
  quarantinedTextNeverEntersTheTranscript,
  theWorkingStatusNeverOutlivesItsTurn,
  aWaitingPersonHearsBackByTheTimeout,
  aResumedTurnAnswersWhatItsLostTurnOwed,
  aPersonGetsTheAnswerDuringADecisionsOutage,
  aDecisionsCallFallsBackOnlyAfterEveryModelFailed,
  laterDecisionsCallsFallBackOnceOneFails,
  aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead,
  sessionMessageWithoutAnAuthorIsAnswered,
];
