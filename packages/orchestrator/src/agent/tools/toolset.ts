import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { WorkflowRuntime } from "../../workflow/types";
import { artifactTools } from "./artifact";
import { channelTools, type Acknowledgement } from "./channel";
import { historyTools } from "./history";
import { trackerTools } from "./tracker";
import { planTools } from "./plan";
import { readTools } from "./read";
import { rootPageTools } from "./root-page";
import { startTools, type StartTurn } from "./start/start";
import { taskTools } from "./task";
import { webTools } from "./web";

/** What the tools of one turn share. `answering` is where the people the turn answers wrote from. */
export type ToolTurn = StartTurn & { answering: ReplyTarget[]; acknowledgement?: Acknowledgement };

/** Every deterministic tool the orchestrator agent gets, bound to one workflow and one turn. */
export function workflowTools(
  workflow: WorkflowRuntime,
  personMessages: string[] = [],
  turn: ToolTurn = { answering: [] },
) {
  return {
    ...planTools(workflow),
    ...startTools(workflow, personMessages, turn),
    ...trackerTools(workflow),
    ...taskTools(workflow, turn.decisions),
    ...artifactTools(workflow),
    ...rootPageTools(workflow),
    ...readTools(workflow),
    ...historyTools(workflow, turn.decisions),
    ...channelTools(workflow, turn.answering, turn.acknowledgement),
    ...webTools(workflow),
  };
}

/** Names of the deterministic tools. MCP tools must not shadow them. */
export type WorkflowToolName = keyof ReturnType<typeof workflowTools>;
