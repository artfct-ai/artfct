import type { SessionStatus } from "@artfct-ai/adapters/chat/types";
import type { OwedReply } from "../src/agent/message/owed-reply";
import type { TranscriptRow } from "../src/agent/transcript/transcript";
import { RECAP_MARKER } from "../src/agent/turn/turn";
import { HEADS_UP_TEXT, LOST_PLACE_TEXT, turnTimeoutText } from "../src/agent/turn/watchdog";

/** How long past its timeout a turn may take to stop its work and post. */
const DEADLINE_GRACE_MS = 1000;

/** What one agent turn was given and what it left on the channels. */
export type AgentTurnRecord = {
  /** What the message of the person who wrote is owed. Null on an unprompted turn. */
  owed: OwedReply | null;
  /** True when a tool of the turn started or prompted a task. */
  boardChanged: boolean;
  /** The text of every event the turn posted to the channels, in order. */
  postedTexts: string[];
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
  /** The text of every tool result the screen quarantined in the turn. Each one is unique. */
  quarantinedTexts: string[];
  /** The session status the chat thread was left in after the turn. Null when it never had one. */
  chatSessionAfter: SessionStatus | null;
  /** How long the turn ran. */
  durationMs: number;
  /** The turn timeout the turn ran under. */
  timeoutMinutes: number;
  /** True when the turn deadline ended the turn. */
  timedOut: boolean;
  /** True when the turn resumed a turn lost to a restart. Its `owed` is the lost turn's. */
  resumedLostTurn: boolean;
};

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

/** The posts that answer the humans. The heads-up and the restart notice are not answers. */
function answersPosted(turn: AgentTurnRecord): string[] {
  return turn.postedTexts.filter((text) => text !== HEADS_UP_TEXT && text !== LOST_PLACE_TEXT);
}

/**
 * A turn on a person's message leaves them a reply: an answer, or a board change. A heads-up or
 * a restart notice is not one. It may end with nothing only after the model was told so and ran
 * once more.
 */
export function aPersonsTurnNeverEndsUnanswered(turn: AgentTurnRecord): void {
  if (turn.owed === null || turn.boardChanged || turn.askedAgain) return;
  if (answersPosted(turn).length > 0) return;
  violated(
    "aPersonsTurnNeverEndsUnanswered",
    "a person wrote, the turn left them nothing, and the model was not asked again",
  );
}

/**
 * A tool result the screen quarantined does not appear in any row of the transcript. The model
 * reads a fixed text in its place.
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
 * A turn lost to a restart while a person waited is picked up again: their thread hears the
 * restart notice, and the resumed turn answers them as the lost turn would have.
 */
export function aResumedTurnAnswersWhatItsLostTurnOwed(turn: AgentTurnRecord): void {
  if (!turn.resumedLostTurn || turn.owed === null) return;
  if (!turn.postedTexts.includes(LOST_PLACE_TEXT)) {
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

/** Every agent turn invariant. */
export const AGENT_TURN_INVARIANTS = [
  closingTextAnswersOnlyAPersonWhoWrote,
  everyInboxRowReachesTheTranscriptOnce,
  compactionReplacesOnlyEarlierRows,
  everyToolCallKeepsItsResult,
  aPersonsTurnNeverEndsUnanswered,
  quarantinedTextNeverEntersTheTranscript,
  theWorkingStatusNeverOutlivesItsTurn,
  aWaitingPersonHearsBackByTheTimeout,
  aResumedTurnAnswersWhatItsLostTurnOwed,
];
