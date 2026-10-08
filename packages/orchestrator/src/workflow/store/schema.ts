import { HARNESSES } from "@artfct-ai/adapters/harness/types";
import type { ArtifactKind, ArtifactStatus, TaskStatus } from "@artfct-ai/contracts/types";
import type { ArtifactRef, RefinerResult } from "../../artifact/types";
import type { TaskRole } from "../task/events";
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { BoardChannel, TodoSnapshot } from "../board/types";
import type { Wake } from "../types";

/** Why a JSON-RPC request was sent to the harness. Decides how its response is handled. */
export type RpcPurpose = "initialize" | "session_new" | "set_effort" | "prompt" | "cancel";

/** The execution of one stage. Its tasks belong to it, and it holds what they produce. */
export const jobs = sqliteTable("jobs", {
  job_id: text().primaryKey(),
  stage: text().notNull(),
  /** The tracker issue the job works from: its id (for event routing) and identifier (for humans). */
  issue_id: text(),
  issue_key: text(),
  /**
   * What identifies the input artifact of the job. `jobInputKey` writes it. Null on a job written
   * before the column existed.
   */
  input_key: text(),
  /** The job whose artifact this job works from. Null when the job works from anything else. */
  preceding_job_id: text(),
  /**
   * The artifact this job works from when its input is one that no job of this workflow
   * produced: what it points at, and the link the request gave. Null when the job works from
   * anything else.
   */
  input_ref: text({ mode: "json" }).$type<ArtifactRef>(),
  input_url: text(),
  /** The branch of the job's pull request. Null on a stage without a branch. */
  branch: text(),
  /** What the agent handed over when it started the job. Every task of the job reads it. */
  brief: text().notNull().default(""),
  /** The harness the agent chose for the job's author over the stage's. Null runs the stage's. */
  author_harness: text({ enum: HARNESSES }),
  /** The model the agent chose for the job's author over the stage's. Null runs the stage's. */
  author_model: text(),
  /** What the job's researcher task found. The author reads it in its first prompt. Null without research. */
  research_payload: text(),
  /** The option a person chose on a stage with a choice ending. Set when the job completes. */
  selection: text(),
  created_at: text().notNull(),
});

/** One execution of a role in a job. The sandbox id is the task id. */
export const tasks = sqliteTable("tasks", {
  task_id: text().primaryKey(),
  job_id: text()
    .notNull()
    .references(() => jobs.job_id),
  /** What the task is for. An `author` produces the artifact of its job. A refiner run runs one refiner of its stage. */
  role: text().$type<TaskRole>().notNull().default("author"),
  /** The position in the stage's refiner list this task runs. Null on an author task. */
  refiner_index: integer(),
  /** What this refiner run filed: a review, or a judge's ruling. Read when its segment settles. */
  result: text({ mode: "json" }).$type<RefinerResult>(),
  model: text().notNull(),
  status: text().$type<TaskStatus>().notNull(),
  /** When a person paused the task. Null while it is not paused. The status stays as it was. */
  paused_at: text(),
  /** What the harness reported over ACP. Zero means no figure arrived yet, so the cost is unknown. */
  cost_usd: real().notNull().default(0),
  started_at: text().notNull(),
  summary: text().notNull().default(""),
});

/** The sandbox and the harness session in it, for one task. */
export const sandboxes = sqliteTable("sandboxes", {
  task_id: text().primaryKey(),
  harness: text({ enum: HARNESSES }).notNull(),
  generation: integer().notNull().default(0),
  bridge_token: text().notNull(),
  session_id: text(),
  /** When the harness last streamed an update. Throttles the no-progress timer. */
  last_progress_at: text().notNull(),
  prompt_in_flight: integer().notNull().default(0),
  /** Tail of the current turn's text output, bounded to `TURN_TEXT_CHARS`. */
  turn_text: text().notNull().default(""),
  /** When the bridge socket last closed. Null while connected or before the first connection. */
  bridge_closed_at: text(),
  no_progress_schedule: text(),
  wall_schedule: text(),
  hello_schedule: text(),
  keepalive_schedule: text(),
  token_schedule: text(),
  /** When the credential written into the sandbox stops working. Null without one. */
  credential_expires_at: text(),
  nudged: integer().notNull().default(0),
  restarts: integer().notNull().default(0),
});

/** One model call the orchestrator made itself: an agent turn step or a named prompt. */
export const modelUsage = sqliteTable("model_usage", {
  id: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  /** `orchestrator` for an agent turn, else the prompt name. */
  purpose: text().notNull(),
  model: text().notNull(),
  input_tokens: integer().notNull().default(0),
  output_tokens: integer().notNull().default(0),
  cost_usd: real().notNull().default(0),
});

/**
 * One board message per job and channel: where it lives and a hash of what it last showed.
 * The board is edited in place, and moves to the end of its thread when a follow-up starts.
 */
export const boards = sqliteTable(
  "boards",
  {
    job_id: text().notNull(),
    /** `chat:<channel>:<thread>`. One board per chat thread. */
    channel_key: text().notNull(),
    channel: text({ mode: "json" }).$type<BoardChannel>().notNull(),
    /** The chat message id. Null until the create succeeds. */
    message_id: text(),
    /** Hash of the last text that reached the channel. Cleared when an edit fails. */
    hash: text(),
    /** How often the message was re-created after someone deleted it. Once at most. */
    recreated: integer().notNull().default(0),
    /** 1 when the next flush posts the board at the end of the thread and deletes this message. */
    relocate: integer().notNull().default(0),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.job_id, table.channel_key] })],
);

/**
 * The harness's latest todo list per task, a board note, and the counters the digest reads.
 * The list tracks the first implementation of the task and ends when it does.
 */
export const taskTodos = sqliteTable("task_todos", {
  task_id: text().primaryKey(),
  todos: text({ mode: "json" }).$type<TodoSnapshot>(),
  /** A one-line note shown on the board, for example the last prompt error. */
  note: text(),
  tool_calls: integer().notNull().default(0),
  tool_failures: integer().notNull().default(0),
  failed_tools: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  /** The schedule id of the coalescing flush alarm, or null when none is pending. */
  flush_schedule: text(),
  updated_at: text().notNull(),
});

/** What a job produced. One per job. The host holds the artifact itself. */
export const artifacts = sqliteTable("artifacts", {
  job_id: text().primaryKey(),
  kind: text().$type<ArtifactKind>().notNull(),
  external_url: text().notNull(),
  ref: text({ mode: "json" }).$type<ArtifactRef>().notNull(),
  status: text().$type<ArtifactStatus>().notNull().default("drafted"),
  /**
   * The refiner run the artifact is on, or the last one that ran. Kept after a refiner ends, so
   * the open segment survives a round trip through the author. Cleared when the artifact
   * leaves the review or the author takes over.
   */
  refiner_task_id: text(),
  /** When the humans first got the artifact. Null until the first handover. */
  delivered_to_humans_at: text(),
  /**
   * The revision the humans last got. Null when the host could not say. It means something only
   * once `delivered_to_humans_at` is set. Only a later revision runs the refiners again.
   */
  delivered_revision: text(),
  updated_at: text().notNull(),
});

/** JSON-RPC requests sent to the harness that have no response yet. */
export const rpc = sqliteTable("rpc", {
  id: integer().primaryKey(),
  task_id: text().notNull(),
  method: text().notNull(),
  purpose: text().$type<RpcPurpose>().notNull(),
  sent_at: text().notNull(),
});

/** Prompts waiting for the harness to finish its current turn. */
export const promptQueue = sqliteTable("prompt_queue", {
  id: integer().primaryKey({ autoIncrement: true }),
  task_id: text().notNull(),
  text: text().notNull(),
  created_at: text().notNull(),
});

/** The `kind` of an outbox row that records a call that failed, rather than a message. */
export const DELIVERY_ERROR = "delivery_error";

/** Messages posted to channels, kept for the debug dump and the smoke test. */
export const outbox = sqliteTable("outbox", {
  id: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  channel: text().notNull(),
  kind: text().notNull(),
  target: text({ mode: "json" }).$type<unknown>().notNull(),
  payload: text({ mode: "json" }).$type<unknown>().notNull(),
});

/** Inbound event ids already handled, for idempotency. */
export const events = sqliteTable("events", {
  id: text().primaryKey(),
  at: text().notNull(),
  kind: text().notNull(),
});

/** Text for the orchestrator agent that arrived since its last turn. */
export const agentInbox = sqliteTable("agent_inbox", {
  id: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  text: text().notNull(),
  wake: text().$type<Wake>().notNull().default("none"),
});

/** The orchestrator agent's conversation. One model message per row, in order. */
export const transcript = sqliteTable("transcript", {
  id: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  message: text({ mode: "json" }).$type<unknown>().notNull(),
});

/** Human-readable workflow log. */
export const log = sqliteTable("log", {
  id: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  task_id: text(),
  line: text().notNull(),
});
