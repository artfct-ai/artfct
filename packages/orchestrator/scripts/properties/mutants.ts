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
    invariant: "harnessSession::stopEndsTheAuthorsTurn (queued prompts)",
    path: "src/workflow/inbound/controls.ts",
    find: "export async function stopAuthor(workflow: WorkflowRuntime, author: TaskRow): Promise<StopOutcome> {\n  workflow.store.clearPromptQueue(author.task_id);",
    replace:
      "export async function stopAuthor(workflow: WorkflowRuntime, author: TaskRow): Promise<StopOutcome> {",
  },
  {
    id: "W5",
    invariant: "harnessSession::stopEndsTheAuthorsTurn (cancel)",
    path: "src/workflow/inbound/controls.ts",
    find: "  const cancelled = connected && cancelPromptTurn(workflow, author);",
    replace: "  const cancelled = false;",
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
    invariant: "sessionRouting::sessionFeedEndsWhenItsAuthorIdles",
    path: "src/workflow/task/harness/turn.ts",
    find: "  await closeSessionFeed(workflow, task, busy ? null : feedClosingOf(stopReason));\n  if (!busy)",
    replace: "  if (!busy)",
  },
  {
    id: "W12",
    invariant: "everyFeedbackGetsOneRoutingDecision",
    path: "src/workflow/refiner/feedback.ts",
    find: '      return { notes: [`${reviewed} and sent it to nobody.${stayHeld}`, said], wake: "human" };',
    replace:
      '      return { notes: [`${reviewed} and sent it to nobody.${stayHeld}`, said], wake: "none" };',
  },
  {
    id: "W13",
    invariant: "harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone",
    path: "src/workflow/task/harness/turn.ts",
    find: "  if (isTaskFinished(author.status) || authorHasAPrompt(workflow, task.task_id)) {\n",
    replace:
      '  if (isTaskFinished(author.status) || authorHasAPrompt(workflow, task.task_id) || author.status === "working") {\n',
  },
  {
    id: "W14",
    invariant: "aPromptToAPageAuthorCarriesItsHeldComments",
    path: "src/workflow/refiner/held-comments.ts",
    find: "  const unmarked = await workflow\n    .artifact(artifact.kind)\n    .acknowledge(heldCommentHandles(comments), artifact.ref);",
    replace: "  const unmarked: FeedbackHandle[] = [];",
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
    find: "  if (isTaskFinished(closed.status) || closed.restarts !== current.restarts) return;",
    replace: "  if (closed.restarts !== current.restarts) return;",
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
    id: "W23",
    invariant: "aPromptToAPageAuthorCarriesItsHeldComments (unmarked)",
    path: "src/workflow/refiner/held-comments.ts",
    find: "  return comments.filter((comment) => !unmarkedIds.has(comment.id));",
    replace: "  return comments;",
  },
  {
    id: "W24",
    invariant: "aHeldCommentStaysHeldUntilItReachesTheAuthor",
    path: "src/workflow/refiner/feedback.ts",
    find: "    ? await workflow.artifact(artifact.kind).acknowledge(feedback.handles, artifact.ref)",
    replace:
      '    ? await workflow.artifact(artifact.kind).acknowledge([...feedback.handles, ...held.map((comment) => ({ kind: "page" as const, comment_id: comment.id }))], artifact.ref)',
  },
  {
    id: "W25",
    invariant: "sentCommentIsAnsweredBeforeItsLineGoes (queued)",
    path: "src/workflow/task/model-author.ts",
    find: "  if (!queuedCommentIds.length) return;",
    replace: "  if (queuedCommentIds.length || true) return;",
  },
  {
    id: "W26",
    invariant: "aModelCallAuthorFailsOnlyOnAHostError",
    path: "src/workflow/task/model-author.ts",
    find: "  if ((await documents.readPageContent(ref.page_id)) !== pageText) return { startOver: true };\n",
    replace: "",
  },
  {
    id: "W27",
    invariant: "aModelCallAuthorFailsOnlyOnAHostError (gone comment)",
    path: "src/workflow/task/model-author.ts",
    find: "    if (!(await documents.fetchComment(reply.comment_id))) {",
    replace: "    if (false) {",
  },
  {
    id: "W28",
    invariant: "taskRestartsAtMostTwice (stale start)",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: "    if (workflow.store.requireSandbox(fresh.task_id).generation !== sandbox.generation) return;\n",
    replace: "",
  },
  {
    id: "W29",
    invariant: "aRunningTurnKeepsItsSandboxAwake (stale restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (workflow.store.requireSandbox(task.task_id).generation !== generation) return;\n",
    replace: "",
  },
  {
    id: "W30",
    invariant: "taskRestartsAtMostTwice (counted restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (isTaskFinished(closed.status) || closed.restarts !== current.restarts) return;",
    replace: "  if (isTaskFinished(closed.status)) return;",
  },
  {
    id: "W31",
    invariant: "finishedTaskKeepsItsStatus, anAuthorInReviewWorksOnlyWithAPrompt (stop)",
    path: "src/workflow/inbound/controls.ts",
    find: '    workflow.store.updateTask(author.task_id, { status: "working" });\n    await closeContainer(workflow, author, "a person pressed Stop");\n',
    replace:
      '    await closeContainer(workflow, author, "a person pressed Stop");\n    workflow.store.updateTask(author.task_id, { status: "working" });\n',
  },
  {
    id: "W32",
    invariant: "anAuthorInReviewRunsNoTurn (stale outcome)",
    path: "src/workflow/task/harness/turn.ts",
    find: "  if (workflow.store.requireSandbox(task.task_id).generation !== generation) return;\n",
    replace: "",
  },
  {
    id: "W33",
    invariant: "anAuthorInReviewRunsNoTurn (handshake)",
    path: "src/workflow/artifact.ts",
    find: "  if (workflow.store.handshakePending(taskId)) return;\n",
    replace: "",
  },
  {
    id: "W34",
    invariant: "anAnswerReachesOnlyItsOwnRequest (rpc id given twice)",
    path: "src/workflow/store/tasks.ts",
    find: "      .values({ task_id: taskId, method, purpose, sent_at: now() })\n",
    replace:
      "      .values({ id: (this.db.select({ id: rpc.id }).from(rpc).orderBy(desc(rpc.id)).limit(1).get()?.id ?? 0) + 1, task_id: taskId, method, purpose, sent_at: now() })\n",
  },
  {
    id: "W35",
    invariant: "aHarnessSessionRunsOneTurnAtATime (resume)",
    path: "src/workflow/inbound/controls.ts",
    find: "  workflow.store.updateTask(task.task_id, { paused_at: null });\n",
    replace:
      "  workflow.store.updateTask(task.task_id, { paused_at: null });\n  if (workflow.store.sandbox(task.task_id)) workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0 });\n",
  },
  {
    id: "W36",
    invariant: "aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn (blocked)",
    path: "src/workflow/task/harness/turn.ts",
    find: "  if (authorHasAPrompt(workflow, taskId)) return false;\n",
    replace: "",
  },
  {
    id: "W37",
    invariant: "harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone (refused prompt)",
    path: "src/workflow/task/harness/turn.ts",
    find: '  if (stoppedEarly && (await stalledAtTurnEnd(workflow, task)) === "restarted") {',
    replace:
      '  if (false && stoppedEarly && (await stalledAtTurnEnd(workflow, task)) === "restarted") {',
  },
  {
    id: "W38",
    invariant: "sessionRouting::aStopAnswersOnlyInTheFeed (lost cancel)",
    path: "src/workflow/inbound/controls.ts",
    find: "  if (atWork) await endStoppedTurn(workflow, author);\n",
    replace:
      '  if (cancelled) return "cancelled";\n  if (atWork) await endStoppedTurn(workflow, author);\n',
  },
  {
    id: "W39",
    invariant: "anUnpausedTaskWithWorkIsNeverStranded (handshake close)",
    path: "src/workflow/task/harness/bridge.ts",
    find: "  return sandbox.prompt_in_flight === 1 || store.handshakePending(sandbox.task_id);",
    replace: "  return sandbox.prompt_in_flight === 1;",
  },
  {
    id: "W40",
    invariant: "anUnpausedTaskWithWorkIsNeverStranded (paused restart)",
    path: "src/workflow/lifecycle.ts",
    find: '  workflow.store.updateTask(task.task_id, { status: "queued", restarts });',
    replace: "  workflow.store.updateTask(task.task_id, { restarts });",
  },
  {
    id: "W41",
    invariant: "aHarnessSessionRunsOneTurnAtATime (lost turn)",
    path: "src/workflow/task/harness/bridge.ts",
    find: "    session_id: null,\n",
    replace: "",
  },
  {
    id: "W42",
    invariant: "aHarnessSessionRunsOneTurnAtATime (effort handshake)",
    path: "src/workflow/task/harness/prompt-queue.ts",
    find: '  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {\n    return false;\n  }\n  const connected = workflow.connections(task.task_id).length > 0;\n  if (connected && sandbox.session_id) {\n    workflow.store.dequeuePrompt(next.id);\n    await sendPrompt(workflow, task, next.text);\n    return true;\n  }\n',
    replace:
      '  const connected = workflow.connections(task.task_id).length > 0;\n  if (connected && sandbox.session_id) {\n    workflow.store.dequeuePrompt(next.id);\n    await sendPrompt(workflow, task, next.text);\n    return true;\n  }\n  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {\n    return false;\n  }\n',
  },
  {
    id: "W43",
    invariant: "anUnpausedTaskWithWorkIsNeverStranded (restart lost with the instance)",
    path: "src/workflow/lifecycle.ts",
    find: '  workflow.store.updateTask(task.task_id, { status: "queued", restarts });\n  workflow.store.patchTodoRow(task.task_id, { note: `Restarted in a fresh sandbox: ${reason}` });\n  await workflow.tellAgent(\n    noteMessage(\n      `The ${task.role} ${task.task_id} of job ${task.job_id} restarted in a fresh sandbox on its branch (${reason}).`,\n    ),\n    "none",\n  );\n  const { generation } = workflow.store.requireSandbox(task.task_id);\n  await closeContainer(workflow, task, "the task restarts");\n',
    replace:
      '  workflow.store.patchTodoRow(task.task_id, { note: `Restarted in a fresh sandbox: ${reason}` });\n  await workflow.tellAgent(\n    noteMessage(\n      `The ${task.role} ${task.task_id} of job ${task.job_id} restarted in a fresh sandbox on its branch (${reason}).`,\n    ),\n    "none",\n  );\n  const { generation } = workflow.store.requireSandbox(task.task_id);\n  await closeContainer(workflow, task, "the task restarts");\n  workflow.store.updateTask(task.task_id, { status: "queued", restarts });\n',
  },
  {
    id: "W44",
    invariant:
      "harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone (outcome check lost with the instance)",
    path: "src/workflow/task/harness/turn.ts",
    find: '    await workflow.scheduleAlarm(0, "settleIdleAuthor", alarm);\n',
    replace: "",
  },
  {
    id: "W45",
    invariant: "reviewLoop::aRestartDoesNotStrandAJudgeRun",
    path: "src/workflow/refiner/loop.ts",
    find: '    await workflow.scheduleAlarm(0, "settleLostJudgeRuling", alarm);\n',
    replace: "",
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
    invariant: "agentTurns::sessionMessageWithoutAnAuthorIsAnswered",
    path: "src/agent/tools/channel.ts",
    find: '            await workflow.post({ type: "info", text: reply.text }, { answering });\n            return "Acknowledged.";',
    replace:
      '            await workflow.post({ type: "info", text: reply.text }, { answering: workflow.transcript.answering() });\n            return "Acknowledged.";',
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
  {
    id: "C1",
    invariant: "chatAcknowledgement::eyesNeverOutliveTheDelivery",
    path: "src/router/chat-ack.ts",
    find: "    clearTimeout(timer);\n",
    replace: "",
  },
  {
    id: "C2",
    invariant: "chatAcknowledgement::eyesNeverOutliveTheDelivery (eyes still out)",
    path: "src/router/chat-ack.ts",
    find: "if (eyes.added && (await eyes.added)) {",
    replace: "if (eyes.added) {",
  },
  {
    id: "C3",
    invariant: "chatAcknowledgement::theCallerGetsWhatTheDeliveryGave",
    path: "src/router/chat-ack.ts",
    find: "      await chat.removeReaction(",
    replace: "      void chat.removeReaction(",
  },
  {
    id: "SR1",
    invariant: "sessionRouting::orchestratorStaysOutOfSessionsWhenChatExists",
    path: "src/notify/recipients.ts",
    find: '    if (target.source !== "tracker" || chatThreads.length === 0) return [target];',
    replace: "    return [target];",
  },
  {
    id: "SR2",
    invariant: "sessionRouting::linearOnlyAsksReachTheStartingSession",
    path: "src/notify/recipients.ts",
    find: '    case "workflow_failed":\n    case "turn_failed":\n      return true;',
    replace: '    case "workflow_failed":\n      return true;',
  },
  {
    id: "SR3",
    invariant: "sessionRouting::sessionMessageReachesItsRunningAuthorSilently",
    path: "src/workflow/inbound/apply.ts",
    find: '  return { notes: [note], wake: "none" };\n}\n\nconst STOP_NOTES',
    replace: '  return { notes: [note], wake: "message" };\n}\n\nconst STOP_NOTES',
  },
  {
    id: "SR4",
    invariant: "sessionRouting::sessionMessageWithoutAnAuthorIsAnswered",
    path: "src/agent/turn/watchdog.ts",
    find: '  await workflow.post({ type: "turn_failed", text: turnTimeoutText(minutes) }, { answering });',
    replace: '  await workflow.post({ type: "turn_failed", text: turnTimeoutText(minutes) });',
  },
  {
    id: "SR5",
    invariant: "sessionRouting::eachIssueLinksTheChatThreadOnce",
    path: "src/workflow/lifecycle.ts",
    find: '    if (origin?.source === "chat" && !issueLinked && !syncedAsSubject) {',
    replace: '    if (origin?.source === "chat" && !syncedAsSubject) {',
  },
  {
    id: "SR6",
    invariant: "sessionRouting::boardsLiveOnlyInChat",
    path: "src/workflow/board/board.ts",
    find: '    if (target.source !== "chat") continue;\n    const channel = { source: target.source',
    replace: "    const channel = { source: target.source",
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
