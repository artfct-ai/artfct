import type { ChatMessageRef } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";
import { artifactTools } from "./artifact";
import { channelTools } from "./channel";
import { heldCommentTools } from "./held-comments";
import { historyTools } from "./history";
import { trackerTools } from "./tracker";
import { planTools } from "./plan";
import { readTools } from "./read";
import { rootPageTools } from "./root-page";
import { startTools, type StartTurn } from "./start/start";
import { taskTools } from "./task";
import { webTools } from "./web";

/** What a turn gives the tools: what the start tools take, and the chat messages people wrote. */
export type ToolTurn = StartTurn & { chatMessages?: ChatMessageRef[] };

/** Every deterministic tool the orchestrator agent gets, bound to one workflow and one turn. */
export function workflowTools(
  workflow: WorkflowRuntime,
  personMessages: string[] = [],
  turn: ToolTurn = {},
) {
  return {
    ...planTools(workflow),
    ...startTools(workflow, personMessages, turn),
    ...trackerTools(workflow),
    ...taskTools(workflow),
    ...artifactTools(workflow),
    ...heldCommentTools(workflow, turn.decisions),
    ...rootPageTools(workflow),
    ...readTools(workflow),
    ...historyTools(workflow, turn.decisions),
    ...channelTools(workflow, turn.chatMessages),
    ...webTools(workflow),
  };
}

/** Names of the deterministic tools. MCP tools must not shadow them. */
export type WorkflowToolName = keyof ReturnType<typeof workflowTools>;
