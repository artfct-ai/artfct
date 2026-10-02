import { readyIssues, unfinishedBlockers } from "@artfct-ai/adapters/tracker/issues";
import { tool } from "ai";
import { z } from "zod";
import type { WorkflowRuntime } from "../../workflow/types";

/** What the agent edits in the tracker itself. Kept next to the tracker tools. */
export const TRACKER_RULES = `## Tracker Operations

### Direct In-Turn Modifications
* **Execute** minor tracker mutations directly in the active turn using the provided tracker toolset:
  * Creating follow-up issues.
  * Updating issue descriptions.
  * Transitioning issue lifecycle states.
  * Adjusting project target dates, iterations, or milestones.
  * Posting comments on issues.
  * Publishing project status updates.
* **Report** all modified fields and values in the turn response.

### Task Dispatch Scope
* **Call** \`start_job\` exclusively for deliverables requiring harness execution: code generation, designs, formal documentation, extensive planning, and pull request workflows.

### Invariants & Exclusions
* **Prohibit Task Creation for Tracker Edits**: Never invoke \`start_job\` solely to execute issue or project tracker modifications.`;

/** Deterministic tracker reads for the burn-down loop. The MCP tools cover everything else. */
export function trackerTools(workflow: WorkflowRuntime) {
  return {
    ready_issues: tool({
      description:
        "The issues of a tracker project that can start now: not started, every blocker finished, and no job of this workflow on them, each with its labels. Also lists what is blocked and by what.",
      inputSchema: z.object({ project_id: z.string().describe("the tracker project id") }),
      execute: async ({ project_id }) => listReady(workflow, project_id),
    }),
  };
}

async function listReady(workflow: WorkflowRuntime, projectId: string): Promise<string> {
  const tracker = await workflow.tracker();
  if (!tracker) return "The tracker is not configured.";
  const owned = new Set(
    workflow.store
      .jobs()
      .filter((job) => {
        const { status } = workflow.store.authorOrResearcherTaskOf(job.job_id);
        return status !== "cancelled" && status !== "failed";
      })
      .map((job) => job.issue_id),
  );
  const issues = (await tracker.projectIssues(projectId)).filter((issue) => !owned.has(issue.id));
  const ready = readyIssues(issues).map((issue) => {
    const labels = issue.labels.length ? ` labels: ${issue.labels.join(", ")}` : "";
    return `- ${issue.identifier} ${issue.title} ${issue.url}${labels}`;
  });
  const blocked = issues
    .filter((issue) => issue.state.type !== "started" && unfinishedBlockers(issue).length)
    .map(
      (issue) =>
        `- ${issue.identifier} waits for ${unfinishedBlockers(issue)
          .map((blocker) => blocker.identifier)
          .join(", ")}`,
    );
  const open = issues.filter(
    (issue) => issue.state.type !== "completed" && issue.state.type !== "canceled",
  );
  return [
    `Open issues not owned by this workflow: ${open.length}.`,
    ready.length ? "Ready now:" : "Ready now: none.",
    ...ready,
    ...(blocked.length ? ["Blocked:", ...blocked] : []),
  ].join("\n");
}
