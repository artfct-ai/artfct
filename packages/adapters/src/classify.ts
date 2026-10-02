/** What a free-text reply in an existing conversation asks for. */
export type PromptKind = "status" | "prompt";

/** True when the text only asks for a status update. */
export function isStatus(text: string): boolean {
  return /^\s*(status|progress|where are you|what's the status|whats the status)\s*\??\s*$/i.test(
    text,
  );
}

/** Whether a free-text reply is a bare status question or a prompt for the agent. */
export function classifyPrompt(text: string): PromptKind {
  return isStatus(text) ? "status" : "prompt";
}
