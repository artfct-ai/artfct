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

/** Every deterministic tool the orchestrator agent gets, bound to one workflow and one turn. */
export function workflowTools(
  workflow: WorkflowRuntime,
  personMessages: string[] = [],
  turn: StartTurn = {},
) {
  return {
    ...planTools(workflow),
    ...startTools(workflow, personMessages, turn),
    ...trackerTools(workflow),
    ...taskTools(workflow),
    ...artifactTools(workflow),
    ...heldCommentTools(workflow),
    ...rootPageTools(workflow),
    ...readTools(workflow),
    ...historyTools(workflow),
    ...channelTools(workflow),
    ...webTools(workflow),
  };
}

/** Names of the deterministic tools. MCP tools must not shadow them. */
export type WorkflowToolName = keyof ReturnType<typeof workflowTools>;
