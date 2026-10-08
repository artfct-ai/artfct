import type { PlanEntry } from "@agentclientprotocol/sdk";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ArtifactStatus, TaskStatus } from "@artfct-ai/contracts/types";

/** The harness's latest todo list as ACP reported it. Never merged, always replaced. */
export type TodoSnapshot = { entries: PlanEntry[] };

/** Where one board lives: a message in a chat thread. */
export type BoardChannel = Extract<ReplyTarget, { source: "chat" }>;

/** The two phases a stage runs over its artifact: its reviewers, then its polishers. */
export type RefinerPhase = "review" | "polish";

/**
 * One phase as the board shows it. The open phase says which run of it this is, what its
 * open refiner run is doing, and where a judge's ruling stands.
 */
export type RefinerPhaseView =
  | { phase: RefinerPhase; status: "pending" | "completed" }
  | {
      phase: RefinerPhase;
      status: "in_progress";
      run: number;
      refiner_status: TaskStatus;
      ruling: "awaited" | "rejected" | null;
    };

/** Where the stage's refiners stand on an artifact, as the board shows them. */
export type RefinerBoard = { phases: RefinerPhaseView[]; humans: PlanEntry["status"] };

/** What a board task works on: its stage for an author, its phase for a refiner run. */
export type BoardWork = { stage: string } | { phase: RefinerPhase };

/** What the renderer and the digest know about a task. Built from the task row by code. */
export type BoardTask = {
  task_id: string;
  /** The sequence number of the task's job in its workflow. */
  number: number;
  /** The key of the ticket the task works on, or null when it works on none. */
  ticket_key: string | null;
  /** What the whole workflow is called. The same on every task of it. */
  workflow_name: string;
  work: BoardWork;
  status: TaskStatus;
  /** True while a person holds the task paused. The status stays what it was. */
  paused: boolean;
  started_at: string;
};

/** Everything one board render reads. Pure data, no I/O. */
export type BoardInput = {
  task: BoardTask;
  todos: TodoSnapshot | null;
  /** A one-line note from the orchestrator, for example the last prompt error. Omitted while the humans hold the artifact. */
  note: string | null;
  /** Where the stage's refiners stand, or null when the task shows no phases. */
  refiners: RefinerBoard | null;
  /** The status of the job's artifact now, or null before it has one. The header reads complete while the humans hold it. */
  artifact_status: ArtifactStatus | null;
  /** Where the latest follow-up stands, or null before the first. One in progress reopens the checklist. */
  follow_up: PlanEntry["status"] | null;
  /** The current time in ms. Written as the `updated` stamp whenever the body changed. */
  now: number;
};

/** One board render. The body says whether the board changed. The text is what goes out. */
export type BoardRender = { body: string; text: string };

/** Tool activity since the orchestrator model last woke for this task. */
export type TaskCounters = {
  tool_calls: number;
  tool_failures: number;
  failed_tools: string[];
};

/** Everything the digest reads. Pure data, no I/O. */
export type DigestInput = {
  task: BoardTask & { cost_usd: number };
  artifact: { kind: string; external_url: string; status: string } | null;
  todos: TodoSnapshot | null;
  counters: TaskCounters;
  /** The turn text of the last harness turn, or null when it printed nothing. */
  last: string | null;
  note: string | null;
  now: number;
};
