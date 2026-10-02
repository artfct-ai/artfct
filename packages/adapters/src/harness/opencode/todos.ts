import type {
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

/** One item as the `todowrite` tool of the todo plugin takes it. Status and priority are free strings. */
type OpenCodeTodo = { content: string; status: string; priority: string };

const PRIORITIES: readonly PlanEntryPriority[] = ["high", "medium", "low"];

/**
 * The todo list a `todowrite` tool call carries, as ACP plan entries. Null for every other
 * update.
 */
export function todoPlan(update: SessionUpdate): PlanEntry[] | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
    return null;
  const todos = todoList(update.rawInput);
  if (!todos) return null;
  return todos.filter((todo) => todo.status !== "cancelled").map(planEntry);
}

function todoList(rawInput: unknown): OpenCodeTodo[] | null {
  if (typeof rawInput !== "object" || rawInput === null || !("todos" in rawInput)) return null;
  const todos = rawInput.todos;
  if (!Array.isArray(todos) || !todos.every(isTodo)) return null;
  return todos;
}

function isTodo(value: unknown): value is OpenCodeTodo {
  if (typeof value !== "object" || value === null) return false;
  const todo = value as Record<string, unknown>;
  return (
    typeof todo.content === "string" &&
    typeof todo.status === "string" &&
    typeof todo.priority === "string"
  );
}

function planEntry(todo: OpenCodeTodo): PlanEntry {
  return { content: todo.content, priority: priority(todo.priority), status: status(todo.status) };
}

function status(value: string): PlanEntryStatus {
  if (value === "in_progress" || value === "completed") return value;
  return "pending";
}

function priority(value: string): PlanEntryPriority {
  return PRIORITIES.find((known) => known === value) ?? "medium";
}
