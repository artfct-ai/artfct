/**
 * Step 1. A Linear agent session delegation creates a workflow, the orchestrator plans every
 * configured stage, and the bridge of the first stage dials in with the expected start spec.
 * On the Linear side it refreshes the install token, acknowledges the session, and moves the issue.
 */
import { fetchWorkflowDebug, hasLogLine, hasOutboxMessage, jobById, waitUntil } from "../admin";
import { assert, assertEqual } from "../assert";
import { PAGE_PARENT_ID, REPO_FULL_NAME, STAGE_NAMES } from "../config";
import {
  agentSessionCreated,
  LINEAR_TEAM_STATES,
  linearDev,
  linearIssue,
  linearSessionId,
} from "../fixtures";
import { activityBodies, fetchMockLinearState, issueUpdates } from "../linear-api";
import { assertStartSpec, assertStartsSince } from "../sandbox";
import { postLinearWebhook } from "../webhooks";

/** The session and issue every later Linear event of the first workflow refers to. */
export const FIRST_SESSION = linearSessionId(1);
export const FIRST_ISSUE = linearIssue(
  1,
  "ENG-42",
  "Fix login redirect",
  `Users land on /404 after login. Repo: https://github.com/${REPO_FULL_NAME}\nPage parent: ${PAGE_PARENT_ID}`,
);

/** What the document stages step needs from the first workflow: its id and the first task. */
export type LinearStartResult = { workflowId: string; taskId: string };

/** Posts the `created` session event and returns the new workflow id. */
async function createWorkflowFromLinear(): Promise<string> {
  const reply = await postLinearWebhook(
    agentSessionCreated({ sessionId: FIRST_SESSION, creator: linearDev, issue: FIRST_ISSUE }),
  );
  console.log("  ->", JSON.stringify(reply));
  assertEqual(reply.created, true, "linear delegation created a workflow");
  const workflowId = reply.workflow_id;
  assert(
    typeof workflowId === "string" && workflowId.startsWith("wf_"),
    "reply carries a workflow id",
    reply,
  );
  return workflowId;
}

/**
 * The orchestrator refreshed the install token, then used it for the ack and the move. The
 * move is written to the outbox before the API call lands, so the record is polled for it.
 */
async function assertLinearSideEffects(): Promise<void> {
  const mock = await waitUntil(
    { label: "origin issue update reached the Linear API" },
    async () => {
      const state = await fetchMockLinearState();
      return issueUpdates(state, FIRST_ISSUE.id).length > 0 ? state : null;
    },
  );
  assert(
    mock.grants.some(
      (grant) => grant.grant_type === "refresh_token" && grant.refresh_token_current,
    ),
    "the short install token was refreshed with its refresh token",
    mock.grants,
  );
  assert(
    mock.calls.every((call) => call.token_ok),
    "every Linear call carried a live bearer token",
    mock.calls.filter((call) => !call.token_ok),
  );
  const bodies = activityBodies(mock, FIRST_SESSION);
  assert(bodies.includes("On it. Reading the issue."), "session was acknowledged", bodies);
  const startedState = LINEAR_TEAM_STATES.find((state) => state.type === "started")!;
  assertEqual(
    issueUpdates(mock, FIRST_ISSUE.id),
    [{ stateId: startedState.id }],
    "origin issue moved to the team's started state in one update",
  );
}

/** Runs step 1 and returns the workflow id and the id of its first task. */
export async function runLinearStart(): Promise<LinearStartResult> {
  console.log("\n1. Linear delegation");
  const workflowId = await createWorkflowFromLinear();
  const firstStage = STAGE_NAMES[0]!;

  const planned = await waitUntil(
    { label: `planned: ${STAGE_NAMES.join(" -> ")}, and linear issue moved to started` },
    async () => {
      const debug = await fetchWorkflowDebug(workflowId);
      const isPlanned =
        debug.state.status === "running" &&
        debug.state.stages.join(",") === STAGE_NAMES.join(",") &&
        debug.state.repo?.full === REPO_FULL_NAME &&
        hasOutboxMessage(
          debug,
          (message) => message.kind === "issue_update" && message.payload.to === "started",
        );
      return isPlanned ? debug : null;
    },
  );
  assertEqual(planned.state.reply_targets.length, 1, "one reply target (the Linear session)");
  await assertLinearSideEffects();

  const taskRow = await waitUntil(
    { label: "task provisioned and bridge said hello", timeoutMs: 30_000 },
    async () => {
      const debug = await fetchWorkflowDebug(workflowId);
      const task = debug.tasks[0];
      return task && hasLogLine(debug, "hello fresh=true") ? task : null;
    },
  );
  assertEqual(taskRow.task_id, `${workflowId}.1`, "first task id");
  const firstJob = jobById(await fetchWorkflowDebug(workflowId), taskRow.job_id);
  assertEqual(firstJob.job_id, `${workflowId}-1`, "first job id");
  assertEqual(firstJob.stage, firstStage, "first job runs the first stage");
  assertEqual(firstJob.branch, null, "a document stage job has no branch");
  assertEqual(taskRow.sandbox?.generation, 1, "task generation");

  await assertStartsSince(0, 1, "mock sandbox saw one start for the first task", taskRow.task_id);
  await assertStartSpec({
    workflowId,
    taskId: taskRow.task_id,
    stage: firstStage,
    branch: null,
    generation: 1,
  });

  return { workflowId, taskId: taskRow.task_id };
}
