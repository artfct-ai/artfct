import type {
  PermissionOption,
  PermissionOptionId,
  PlanEntry,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

/** Pick the most permissive option the agent offers. */
export function chooseAllowOption(options: PermissionOption[]): PermissionOptionId | null {
  const preferred = ["allow_always", "allow_once"];
  for (const kind of preferred) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match.optionId;
  }
  return options[0]?.optionId ?? null;
}

/** Text of an agent message chunk. Null for every other update. */
export function updateText(update: SessionUpdate): string | null {
  if (update.sessionUpdate !== "agent_message_chunk") return null;
  return update.content.type === "text" ? update.content.text : null;
}

/** The entries of a plan update, as data. Null for every other update. */
export function planEntries(update: SessionUpdate): PlanEntry[] | null {
  return update.sessionUpdate === "plan" ? update.entries : null;
}

/** What a tool update means for a task's counters: a new call, or a call that failed. */
export type ToolActivity = { kind: "call"; title: string } | { kind: "failed"; title: string };

/** The tool activity in an update. Null for other updates and for calls still running. */
export function toolActivity(update: SessionUpdate): ToolActivity | null {
  switch (update.sessionUpdate) {
    case "tool_call":
      return { kind: "call", title: update.title };
    case "tool_call_update":
      if (update.status !== "failed") return null;
      return { kind: "failed", title: update.title ?? update.toolCallId };
    default:
      return null;
  }
}

/** One-line summary of a tool update, for the log. Null when nothing is worth saying. */
export function summarizeUpdate(update: SessionUpdate): string | null {
  switch (update.sessionUpdate) {
    case "tool_call":
      return `${update.kind ?? "tool"}: ${update.title}`;
    case "tool_call_update":
      return update.status === "failed"
        ? `tool failed: ${update.title ?? update.toolCallId}`
        : null;
    default:
      return null;
  }
}
