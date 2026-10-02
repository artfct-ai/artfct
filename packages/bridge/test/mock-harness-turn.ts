import type { ContentBlock, PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";

/** The stage whose first mock turn opens a PR. Every other stage writes a Notion document. */
export const PR_STAGE = "implement";

/** What the mock reports on its first turn. Read from the ARTFCT_STAGE env the sandbox starts with. */
export type MockStage = { name: string; kind: "pr" | "doc" };

/** The stage for an ARTFCT_STAGE value. No value means the PR stage. */
export function mockStage(stageEnv: string | undefined): MockStage {
  const name = stageEnv ?? PR_STAGE;
  return { name, kind: name === PR_STAGE ? "pr" : "doc" };
}

/** A Notion page URL that is stable per stage. The page id encodes the stage name. */
export function docUrlForStage(stage: string): string {
  return `https://www.notion.so/acme/${stage}-${notionPageId(stage)}`;
}

/** 32 hex chars, as Notion page ids are: the stage name hex-encoded and zero padded. */
function notionPageId(stage: string): string {
  const hex = Array.from(stage, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join(
    "",
  );
  return hex.slice(0, 32).padEnd(32, "0");
}

/** Join the text blocks of a prompt. Non-text blocks contribute an empty line. */
export function promptText(blocks: ContentBlock[]): string {
  return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** The line under the intro of the selection section of a prompt. */
const SELECTION_SECTION = /^## Selection behind the input artifact\n[^\n]*\n([^\n]+)/m;

/** The option a person chose on the stage before, as the prompt carries it. Null without one. */
export function selectionInPrompt(prompt: string): string | null {
  return SELECTION_SECTION.exec(prompt)?.[1]?.trim() ?? null;
}

/**
 * Reply for a turn. Turn 1 reports the artifact of the stage and the selection it worked from.
 * Later turns echo the prompt.
 */
export function replyForTurn(options: {
  turn: number;
  prompt: string;
  prUrl: string;
  stage?: MockStage;
}): string {
  const { turn, prompt, prUrl } = options;
  const stage = options.stage ?? mockStage(undefined);
  if (turn === 1) {
    if (stage.kind === "pr") return `Implemented the change and opened ${prUrl} for review.`;
    const wrote = `Wrote the ${stage.name} document at ${docUrlForStage(stage.name)} for review.`;
    const selection = selectionInPrompt(prompt);
    return selection ? `${wrote} Worked from the selection: ${selection}.` : wrote;
  }
  const where = stage.kind === "pr" ? "PR" : "document";
  if (/resum/i.test(prompt))
    return `Resumed on the existing ${where}. Addressed: ${prompt.slice(0, 80)}`;
  const pushed = stage.kind === "pr" ? "Pushed a new commit." : "Updated the document.";
  return `Addressed the feedback: ${prompt.slice(0, 80)}. ${pushed}`;
}

/** The tool call the mock pretends to run on a turn. */
export function toolCallForTurn(turn: number, stage?: MockStage): SessionUpdate {
  const kind = (stage ?? mockStage(undefined)).kind;
  const first = kind === "pr" ? "git commit && gh pr create" : "notion pages create";
  const later = kind === "pr" ? "git push" : "notion pages update";
  return {
    sessionUpdate: "tool_call",
    toolCallId: `tc-${turn}`,
    title: turn === 1 ? first : later,
    kind: "execute",
    status: "in_progress",
  };
}

/** The todo list the mock reports on a turn. `done` marks every item completed. */
export function planForTurn(turn: number, done: boolean, stage?: MockStage): SessionUpdate {
  const kind = (stage ?? mockStage(undefined)).kind;
  const work = kind === "pr" ? "Open the pull request" : "Write the document";
  const items = turn === 1 ? ["Read the brief", work] : ["Read the feedback", "Address it"];
  const entries: PlanEntry[] = items.map((content, index) => ({
    content,
    priority: "medium",
    status: done ? "completed" : index === 0 ? "in_progress" : "pending",
  }));
  return { sessionUpdate: "plan", entries };
}

/** Marks the turn's tool call as done. */
export function toolCallDoneForTurn(turn: number): SessionUpdate {
  return { sessionUpdate: "tool_call_update", toolCallId: `tc-${turn}`, status: "completed" };
}

/** A text update of the given kind. */
export function textUpdate(
  kind: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
): SessionUpdate {
  return { sessionUpdate: kind, content: { type: "text", text } };
}
