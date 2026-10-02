import type { TaskEvent } from "../workflow/task/events";

/** The line every ending message closes with. A tag after the end starts a new workflow. */
export const TAG_TO_START_AGAIN = "This workflow is finished. Tag me again to start new work.";

/** Tracker agent activity content for a task event. */
export function trackerContent(event: TaskEvent) {
  switch (event.type) {
    case "started":
      return {
        type: "thought",
        body: `Starting stage **${event.stage}** (job ${event.job_id}).`,
      } as const;
    case "progress":
      return { type: "action", action: "working", parameter: event.text.slice(0, 200) } as const;
    case "question":
      return { type: "elicitation", body: event.text } as const;
    case "artifact_ready":
      return { type: "response", body: event.text } as const;
    case "failed":
      return { type: "error", body: event.reason } as const;
    case "workflow_failed":
      return { type: "error", body: `${event.reason}\n\n${TAG_TO_START_AGAIN}` } as const;
    case "done":
      return { type: "response", body: `${event.result}\n\n${TAG_TO_START_AGAIN}` } as const;
    case "status":
    case "info":
      return { type: "response", body: event.text } as const;
    default: {
      const unhandled: never = event;
      throw new Error(`unhandled task event ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Plain-text rendering of a task event for the chat and document channels. */
export function plainText(event: TaskEvent): string {
  switch (event.type) {
    case "started":
      return `Starting stage *${event.stage}*.`;
    case "progress":
    case "question":
    case "status":
    case "info":
    case "artifact_ready":
      return event.text;
    case "failed":
      return `❌ ${event.reason}`;
    case "workflow_failed":
      return `❌ ${event.reason}\n\n${TAG_TO_START_AGAIN}`;
    case "done":
      return `Done. ${event.result}\n\n${TAG_TO_START_AGAIN}`;
    default: {
      const unhandled: never = event;
      throw new Error(`unhandled task event ${JSON.stringify(unhandled)}`);
    }
  }
}
