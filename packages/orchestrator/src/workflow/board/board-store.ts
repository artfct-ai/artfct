import { and, eq } from "drizzle-orm";
import { RecordStore } from "../store/records";
import { boards, taskTodos, tasks } from "../store/schema";
import { now } from "../store/state";
import type { BoardChannel, TodoSnapshot } from "./types";

export type BoardRow = typeof boards.$inferSelect;
export type TodoRow = typeof taskTodos.$inferSelect;

/** How many failed tool names the counters keep. The digest names at most this many. */
const MAX_FAILED_TOOLS = 5;

/** Queries over the board tables: one board row per job and channel, one todo row per task. */
export class BoardStore extends RecordStore {
  boards(jobId: string): BoardRow[] {
    return this.db.select().from(boards).where(eq(boards.job_id, jobId)).all();
  }

  allBoards(): BoardRow[] {
    return this.db.select().from(boards).orderBy(boards.created_at).all();
  }

  board(jobId: string, channelKey: string): BoardRow | null {
    return (
      this.db
        .select()
        .from(boards)
        .where(and(eq(boards.job_id, jobId), eq(boards.channel_key, channelKey)))
        .get() ?? null
    );
  }

  insertBoard(jobId: string, channelKey: string, channel: BoardChannel): BoardRow {
    const at = now();
    this.db
      .insert(boards)
      .values({ job_id: jobId, channel_key: channelKey, channel, created_at: at, updated_at: at })
      .run();
    return this.board(jobId, channelKey)!;
  }

  updateBoard(jobId: string, channelKey: string, patch: Partial<BoardRow>): void {
    this.db
      .update(boards)
      .set({ ...patch, updated_at: now() })
      .where(and(eq(boards.job_id, jobId), eq(boards.channel_key, channelKey)))
      .run();
  }

  /** Move every board of the job to the end of its thread on the next flush. */
  relocateBoards(jobId: string): void {
    this.db
      .update(boards)
      .set({ relocate: 1, updated_at: now() })
      .where(eq(boards.job_id, jobId))
      .run();
  }

  todoRow(taskId: string): TodoRow | null {
    return this.db.select().from(taskTodos).where(eq(taskTodos.task_id, taskId)).get() ?? null;
  }

  allTodoRows(): TodoRow[] {
    return this.db.select().from(taskTodos).all();
  }

  /** Patch the todo row of a task, creating it on first use. */
  patchTodoRow(taskId: string, patch: Partial<Omit<TodoRow, "task_id">>): TodoRow {
    const row = { ...patch, updated_at: now() };
    this.db
      .insert(taskTodos)
      .values({ task_id: taskId, ...row })
      .onConflictDoUpdate({ target: taskTodos.task_id, set: row })
      .run();
    return this.todoRow(taskId)!;
  }

  /**
   * Replace a task's todo list. An author's list is fixed once its job has an artifact.
   * Returns true when the list was stored.
   */
  setTodos(taskId: string, todos: TodoSnapshot): boolean {
    const author = this.db
      .select({ job_id: tasks.job_id })
      .from(tasks)
      .where(and(eq(tasks.task_id, taskId), eq(tasks.role, "author")))
      .get();
    if (author && this.artifact(author.job_id)) return false;
    this.patchTodoRow(taskId, { todos });
    return true;
  }

  /** Complete every todo entry. The job's artifact keeps the list from changing afterwards. */
  completeTodos(taskId: string): void {
    const todos = this.todoRow(taskId)?.todos ?? null;
    this.patchTodoRow(taskId, { todos: todos && completeEntries(todos) });
  }

  /** Count one tool call. */
  countToolCall(taskId: string): TodoRow {
    const current = this.todoRow(taskId);
    return this.patchTodoRow(taskId, { tool_calls: (current?.tool_calls ?? 0) + 1 });
  }

  /** Count one failed tool call and keep its name for the digest. */
  countToolFailure(taskId: string, tool: string): TodoRow {
    const current = this.todoRow(taskId);
    const names = [...(current?.failed_tools ?? []), tool].slice(-MAX_FAILED_TOOLS);
    return this.patchTodoRow(taskId, {
      tool_failures: (current?.tool_failures ?? 0) + 1,
      failed_tools: names,
    });
  }

  /** The harness turn ended and the model read the digest. Its next digest counts from here. */
  resetCounters(taskId: string): void {
    this.patchTodoRow(taskId, { tool_calls: 0, tool_failures: 0, failed_tools: [] });
  }
}

/** The snapshot with every entry complete. */
function completeEntries(todos: TodoSnapshot): TodoSnapshot {
  const entries = todos.entries.map((entry) => ({ ...entry, status: "completed" as const }));
  return { ...todos, entries };
}
