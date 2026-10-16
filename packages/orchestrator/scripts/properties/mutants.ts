#!/usr/bin/env bun
/**
 * Applies each hand-written mutant to the orchestrator source, one at a time, and runs the
 * property files of the e2e property test job against it on `PROPERTY_SEED`. A mutant that every property
 * file passes survives. When a mutant survives or no longer applies, the report goes to the
 * path in the first argument.
 * Usage: PROPERTY_SEED=<integer> bun scripts/properties/mutants.ts <report-path>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROPERTY_FILES, runPropertyFile } from "./property-files";

/** A one-place change to the source that breaks the invariant it names. */
export type Mutant = { id: string; invariant: string; path: string; find: string; replace: string };

/** What the property files did to a mutant. */
export type MutantResult = { mutant: Mutant; status: "killed" | "survived" | "not_applied" };

/** The hand-written mutants. Each one breaks a rule that a property test is meant to catch. */
export const MUTANTS: Mutant[] = [
  {
    id: "W1",
    invariant: "refinersRunAgainOnlyOnChangedRevision",
    path: "src/workflow/refiner/outcome.ts",
    find: "  if (revision !== null && revision === artifact.delivered_revision) return;\n",
    replace: "",
  },
  {
    id: "W2",
    invariant: "jobStartsOnlyIntoAFreeSlot",
    path: "src/agent/tools/start/start.ts",
    find: "if (active.length < state.concurrency) return null;",
    replace: "if (active.length <= state.concurrency) return null;",
  },
  {
    id: "W3",
    invariant: "nothingReopensAFinishedWorkflow",
    path: "src/workflow/inbound/events.ts",
    find: "  if (isWorkflowFinished(workflow.state.status)) {\n    await replyFinished",
    replace:
      '  if (isWorkflowFinished(workflow.state.status) && event.kind !== "prompt") {\n    await replyFinished',
  },
  {
    id: "W4",
    invariant: "stopEndsTheAuthorsTurn (queued prompts)",
    path: "src/workflow/inbound/controls.ts",
    find: "export async function stopAuthor(workflow: WorkflowRuntime, author: TaskRow): Promise<StopOutcome> {\n  workflow.store.clearPromptQueue(author.task_id);",
    replace:
      "export async function stopAuthor(workflow: WorkflowRuntime, author: TaskRow): Promise<StopOutcome> {",
  },
  {
    id: "W5",
    invariant: "stopEndsTheAuthorsTurn (cancel)",
    path: "src/workflow/inbound/controls.ts",
    find: 'if (connected && cancelPromptTurn(workflow, author)) return "cancelled";',
    replace: 'if (connected && false) return "cancelled";',
  },
  {
    id: "W6",
    invariant: "staleAlarmIsIgnored",
    path: "src/workflow/task/harness/timers.ts",
    find: "  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;\n  if (!sandbox.prompt_in_flight || isTaskFinished(task.status) || task.paused_at",
    replace:
      "  if (!task || !sandbox) return;\n  if (!sandbox.prompt_in_flight || isTaskFinished(task.status) || task.paused_at",
  },
  {
    id: "W7",
    invariant: "oneLiveJobPerInputArtifact",
    path: "src/agent/tools/start/start.ts",
    find: "    if (isTaskFinished(task.status)) continue;\n    return `Job ${job.job_id} already works on",
    replace:
      '    if (isTaskFinished(task.status) || task.status === "in_review") continue;\n    return `Job ${job.job_id} already works on',
  },
  {
    id: "W8",
    invariant: "aFailedCheckNeverCompletesAJob",
    path: "src/agent/tools/start/start.ts",
    find: "  if (accepted === null) return checkUnavailableText(`whether the person accepted ${name}`);",
    replace: "  if (accepted === null) return null;",
  },
  {
    id: "W9",
    invariant: "authorIsIdleWhileAPolisherRuns",
    path: "src/workflow/refiner/loop.ts",
    find: "  if (taskAtWork(workflow, task)) return false;\n  return !workflow.store.queue()",
    replace: "  return !workflow.store.queue()",
  },
  {
    id: "W10",
    invariant: "judgeRulesAtMostOnce",
    path: "src/workflow/refiner/stage-refiner.ts",
    find: '  if (entries[index]?.mode !== "judge") return false;\n  return runs.some(',
    replace: '  if (entries[index]?.mode !== "judge") return false;\n  return false && runs.some(',
  },
  {
    id: "W11",
    invariant: "sessionFeedEndsWhenItsAuthorIdles",
    path: "src/workflow/task/harness/turn.ts",
    find: "  await closeSessionFeed(workflow, task, busy ? null : feedClosingOf(stopReason));\n  if (!busy)",
    replace: "  if (!busy)",
  },
  {
    id: "W12",
    invariant: "everyFeedbackGetsOneRoutingDecision",
    path: "src/workflow/refiner/feedback.ts",
    find: '      return { notes: [`${reviewed} and sent it to nobody.`, said], wake: "human" };',
    replace: '      return { notes: [`${reviewed} and sent it to nobody.`, said], wake: "none" };',
  },
  {
    id: "W13",
    invariant: "anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone",
    path: "src/workflow/task/harness/turn.ts",
    find: '  if (isTaskFinished(author.status) || prompted) return "has_next_step";\n  return nudgeOrRestartStalledTask(workflow, author);',
    replace:
      '  if (isTaskFinished(author.status) || prompted || author.status === "working") return "has_next_step";\n  return nudgeOrRestartStalledTask(workflow, author);',
  },
  {
    id: "W14",
    invariant: "aPromptToAPageAuthorCarriesItsHeldComments",
    path: "src/workflow/refiner/held-comments.ts",
    find: "  await workflow.artifact(artifact.kind).acknowledge(heldCommentHandles(comments), artifact.ref);\n",
    replace: "",
  },
  {
    id: "W15",
    invariant: "workflowStartsOnlyFromAPlan",
    path: "src/agent/tools/start/start.ts",
    find: "        const notStarted = validateWorkflowStarted(workflow);",
    replace: "        const notStarted: string | null = null;",
  },
  {
    id: "W16",
    invariant: "judgeRulesAtMostOnce",
    path: "src/workflow/refiner/loop.ts",
    find: "  const refusal = validateJudgeAwaitsRuling(workflow, reviewer);\n  if (refusal) {",
    replace:
      "  const refusal = validateJudgeAwaitsRuling(workflow, reviewer);\n  if (false && refusal) {",
  },
  {
    id: "W17",
    invariant: "reviewerRunsOnlyOnAnUnreviewedRevision",
    path: "src/workflow/refiner/stage-refiner.ts",
    find: "  if (entryReviewedRevision(runs, index, revision)) return true;\n",
    replace: "",
  },
  {
    id: "W18",
    invariant: "authorGetsEveryPullFinding",
    path: "src/workflow/refiner/loop.ts",
    find: "    if (!reviewAsksTheAuthor(review)) {\n      return advanceArtifactPastEntry(workflow, author, index, revision);",
    replace:
      "    if (true || !reviewAsksTheAuthor(review)) {\n      return advanceArtifactPastEntry(workflow, author, index, revision);",
  },
  {
    id: "W19",
    invariant: "finishedTaskKeepsItsStatus (restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  const closed = workflow.store.requireTask(task.task_id);\n  if (isTaskFinished(closed.status)) return;\n",
    replace: "  const closed = workflow.store.requireTask(task.task_id);\n",
  },
  {
    id: "W20",
    invariant: "endedWorkflowHasNoUnfinishedTask",
    path: "src/agent/tools/plan.ts",
    find: '  if (workflowEnding(workflow)) return "The workflow is ending. A workflow that ends stays ended.";\n',
    replace: "",
  },
  {
    id: "W21",
    invariant: "pausedAuthorGetsNoPrompt, authorIsIdleWhileAPolisherRuns",
    path: "src/workflow/task/harness/prompt-queue.ts",
    find: "  if (!promptsWait(workflow, task)) return sendPrompt(workflow, task, text);",
    replace: "  return sendPrompt(workflow, task, text);",
  },
  {
    id: "W22",
    invariant: "pausedAuthorGetsNoPrompt (restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (closed.paused_at === null) await restartSandbox(workflow, closed);",
    replace: "  if (true || closed.paused_at === null) await restartSandbox(workflow, closed);",
  },
  {
    id: "A1",
    invariant: "laterDecisionsCallsFallBackOnceOneFails",
    path: "src/decisions/ask.ts",
    find: "    if (turn) turn.failed = true;\n",
    replace: "",
  },
  {
    id: "A2b",
    invariant: "aPersonHearsBackBeforeAnyWork",
    path: "src/agent/turn/turn.ts",
    find: "  const awaitingFirstReply = () => turn.personWrote && !progress.firstReplied;",
    replace:
      "  const awaitingFirstReply = () => false && turn.personWrote && !progress.firstReplied;",
  },
  {
    id: "A3",
    invariant: "theWorkingStatusNeverOutlivesItsTurn",
    path: "src/agent/turn/turn.ts",
    find: "  if (!owesTheReply) return workflow.release();",
    replace: "  if (!owesTheReply) return;",
  },
  {
    id: "A4",
    invariant: "aWaitingInboxRowHasATurnComing",
    path: "src/agent/turn/watchdog.ts",
    find: '    if (waking) await workflow.scheduleAlarm(0, "runAgent", {});\n',
    replace: "",
  },
  {
    id: "A5",
    invariant: "sessionMessageWithoutAnAuthorIsAnswered",
    path: "src/agent/tools/channel.ts",
    find: '              { answering },\n            );\n            return "Acknowledged.";',
    replace:
      '              { answering: workflow.transcript.answering() },\n            );\n            return "Acknowledged.";',
  },
  {
    id: "A6",
    invariant: "closingTextAnswersOnlyAPersonWhoWrote",
    path: "src/agent/turn/turn.ts",
    find: "    turn_board_changed: lostFirstRow !== null && workflow.state.turn_board_changed === true,",
    replace: "    turn_board_changed: false,",
  },
  {
    id: "R1",
    invariant: "messageAfterEndStartsNextWorkflow (claim)",
    path: "src/router/deliver.ts",
    find: "    if (!(await claimBinding(db, claimed.binding, { previous: claimed.workflowId, workflowId }))) {",
    replace:
      "    if (!((await claimBinding(db, claimed.binding, { previous: claimed.workflowId, workflowId })) || true)) {",
  },
  {
    id: "R2",
    invariant: "messageAfterEndStartsNextWorkflow (bind all)",
    path: "src/router/deliver.ts",
    find: "    if (index === claimedIndex) continue;\n    const previous = bound.workflowId;",
    replace:
      "    if (index === claimedIndex || true) continue;\n    const previous = bound.workflowId;",
  },
  {
    id: "R3",
    invariant: "aDeliveryLeavesTheBindingsOfARunningWorkflow",
    path: "src/router/deliver.ts",
    find: "    const previous = bound.workflowId;",
    replace: "    const previous = await findBinding(db, bound.binding);",
  },
  {
    id: "R4",
    invariant: "oneRunningWorkflowHasAJobOnAnIssue (moved binding)",
    path: "src/agent/tools/start/start.ts",
    find: "  return bound\n    ? null",
    replace: "  return bound || true\n    ? null",
  },
  {
    id: "R5",
    invariant: "oneRunningWorkflowHasAJobOnAnIssue (running workflow)",
    path: "src/agent/tools/start/start.ts",
    find: "    if (!row || !isWorkflowFinished(row.status)) {",
    replace: "    if (!row) {",
  },
];

/** The source with the mutant applied, or null when its text no longer occurs exactly once. */
export function applyMutant(source: string, mutant: Mutant): string | null {
  const [before, ...rest] = source.split(mutant.find);
  if (rest.length !== 1) return null;
  return `${before}${mutant.replace}${rest[0]}`;
}

/** The issue section for the mutants that survived or no longer apply, or null when every mutant was killed. */
export function mutantReport(results: MutantResult[], seed: number): string | null {
  const flagged = results.filter((result) => result.status !== "killed");
  if (!flagged.length) return null;
  const rows = flagged.map(
    ({ mutant, status }) =>
      `| ${mutant.id} | ${mutant.invariant} | \`${mutant.path}\` | ${status === "survived" ? "survived" : "no longer applies"} |`,
  );
  return [
    "## Surviving mutants",
    `The nightly mutant run on seed ${seed} found mutants the property tests did not kill.`,
    ["| Mutant | Invariant | File | Result |", "| --- | --- | --- | --- |", ...rows].join("\n"),
    "A surviving mutant shows a rule the generators do not reach. Update a mutant that no longer applies in `packages/orchestrator/scripts/properties/mutants.ts`.",
    "",
  ].join("\n\n");
}

async function killedByAPropertyFile(seed: number): Promise<boolean> {
  for (const file of Object.values(PROPERTY_FILES)) {
    const run = await runPropertyFile(file, seed);
    if (run.outcome !== "passed") return true;
  }
  return false;
}

async function runMutant(mutant: Mutant, seed: number): Promise<MutantResult> {
  const path = join(import.meta.dirname, "../..", mutant.path);
  const original = readFileSync(path, "utf8");
  const mutated = applyMutant(original, mutant);
  if (mutated === null) return { mutant, status: "not_applied" };
  writeFileSync(path, mutated);
  try {
    return { mutant, status: (await killedByAPropertyFile(seed)) ? "killed" : "survived" };
  } finally {
    writeFileSync(path, original);
  }
}

if (import.meta.main) {
  const reportPath = process.argv[2];
  const seed = Number(process.env.PROPERTY_SEED);
  if (!reportPath || !Number.isInteger(seed)) {
    console.error("usage: PROPERTY_SEED=<integer> bun scripts/properties/mutants.ts <report-path>");
    process.exit(2);
  }
  const results: MutantResult[] = [];
  for (const mutant of MUTANTS) {
    console.log(`\n=== mutant ${mutant.id}: ${mutant.invariant}`);
    const result = await runMutant(mutant, seed);
    console.log(`=== mutant ${mutant.id} ${result.status}`);
    results.push(result);
  }
  const report = mutantReport(results, seed);
  if (report) writeFileSync(reportPath, report);
}
