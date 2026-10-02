import type { TaskEvent } from "../workflow/task/events";

/**
 * Where a task event lands. `channel` is a message the humans read now. `board` edits the
 * per-task board message in place. `internal` reaches no channel and is only recorded.
 */
export type Destination = "channel" | "board" | "internal";

/**
 * The channel budget. Between a task's launch and its artifact the requester's thread hears
 * nothing but the board.
 */
export function destinationFor(event: TaskEvent): Destination {
  switch (event.type) {
    case "started":
      return "board";
    case "progress":
      return "internal";
    case "question":
    case "artifact_ready":
    case "failed":
    case "workflow_failed":
    case "done":
    case "status":
    case "info":
      return "channel";
    default: {
      const unhandled: never = event;
      throw new Error(`unhandled task event ${JSON.stringify(unhandled)}`);
    }
  }
}
