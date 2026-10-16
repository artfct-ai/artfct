import type { OwedReply } from "../src/agent/message/owed-reply";
import { turnTimeoutText } from "../src/agent/turn/watchdog";

/** What one agent turn was given and what it left on the channels. */
export type AgentTurnRecord = {
  /**
   * What the message of the person who wrote is owed. A resumed turn owes the people of the lost
   * turn and anyone who wrote while it was lost. Null on an unprompted turn.
   */
  owed: OwedReply | null;
  /** The text of every event the turn posted to the channels, in order. */
  postedTexts: string[];
  /** How long the turn ran on a fake clock that moves only when a timer fires. */
  durationMs: number;
  /** The turn timeout the turn ran under. */
  timeoutMinutes: number;
  /** True when the turn deadline ended the turn. */
  timedOut: boolean;
  /**
   * True when the turn timeout passed while the model ran: it never returns on its own, or it ran
   * long enough for the watchdog to fire.
   */
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
};

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * A person who wrote hears back by the turn timeout, even when a decisions call or a model
 * request never returns on its own. A turn the deadline ended posts the timeout text. A turn
 * that ran past its timeout on the fake clock waited on a timer after the deadline aborted it.
 */
function aWaitingPersonHearsBackByTheTimeout(turn: AgentTurnRecord): void {
  if (turn.owed === null) return;
  const timeoutMs = turn.timeoutMinutes * 60_000;
  if (turn.durationMs > timeoutMs) {
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
 * A person who wrote gets the agent's answer, not the timeout text, whenever the model answers.
 * This holds when every decisions call fails or never returns.
 */
function aPersonGetsTheAnswerDuringADecisionsOutage(turn: AgentTurnRecord): void {
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
function aDecisionsCallFallsBackOnlyAfterEveryModelFailed(turn: AgentTurnRecord): void {
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

/** Every agent turn invariant. */
export const AGENT_TURN_INVARIANTS = [
  aWaitingPersonHearsBackByTheTimeout,
  aPersonGetsTheAnswerDuringADecisionsOutage,
  aDecisionsCallFallsBackOnlyAfterEveryModelFailed,
];
