#!/usr/bin/env bun
/**
 * Applies each hand-written mutant to the orchestrator source, one at a time, and runs the spec
 * replays against it on `PROPERTY_SEED`. A mutant that every spec replay passes survives. When a
 * mutant survives or no longer applies, the report goes to the path in the first argument.
 * Usage: PROPERTY_SEED=<integer> bun scripts/properties/mutants.ts <report-path>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPEC_REPLAY_FILES, runPropertyFile } from "./property-files";

/** A one-place change to the source that breaks the invariant it names. */
export type Mutant = { id: string; invariant: string; path: string; find: string; replace: string };

/** What the spec replays did to a mutant. */
export type MutantResult = { mutant: Mutant; status: "killed" | "survived" | "not_applied" };

/** The hand-written mutants. Each one breaks the spec rule it names, which its spec replay is meant to catch. */
export const MUTANTS: Mutant[] = [
  {
    id: "W1",
    invariant: "reviewLoop::refinersRunAgainOnlyOnChangedRevision",
    path: "src/workflow/refiner/outcome.ts",
    find: "  if (revision !== null && revision === artifact.delivered_revision) return;\n",
    replace: "",
  },
  {
    id: "W2",
    invariant: "workflowLifecycle::jobStartsOnlyIntoAFreeSlot",
    path: "src/agent/tools/start/start.ts",
    find: "if (active.length < state.concurrency) return null;",
    replace: "if (active.length <= state.concurrency) return null;",
  },
  {
    id: "W3",
    invariant: "workflowLifecycle::nothingReopensAFinishedWorkflow",
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
    invariant: "workflowLifecycle::staleAlarmIsIgnored",
    path: "src/workflow/task/harness/timers.ts",
    find: "  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;\n  if (!sandbox.prompt_in_flight || isTaskFinished(task.status) || task.paused_at",
    replace:
      "  if (!task || !sandbox) return;\n  if (!sandbox.prompt_in_flight || isTaskFinished(task.status) || task.paused_at",
  },
  {
    id: "W7",
    invariant: "workflowLifecycle::oneLiveJobPerInputArtifact",
    path: "src/agent/tools/start/start.ts",
    find: "    if (isTaskFinished(task.status)) continue;\n    return `Job ${job.job_id} already works on",
    replace:
      '    if (isTaskFinished(task.status) || task.status === "in_review") continue;\n    return `Job ${job.job_id} already works on',
  },
  {
    id: "W8",
    invariant: "workflowLifecycle::aFailedCheckNeverCompletesAJob",
    path: "src/agent/tools/start/start.ts",
    find: "  if (accepted === null) return checkUnavailableText(`whether the person accepted ${name}`);",
    replace: "  if (accepted === null) return null;",
  },
  {
    id: "W9",
    invariant: "reviewLoop::authorIsIdleWhileAPolisherRuns",
    path: "src/workflow/refiner/loop.ts",
    find: "  if (taskAtWork(workflow, task)) return false;\n  return !workflow.store.queue()",
    replace: "  return !workflow.store.queue()",
  },
  {
    id: "W10",
    invariant: "reviewLoop::reviewerRunsOnlyOnAnUnreviewedRevision",
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
    invariant: "feedbackRouting::everyFeedbackGetsOneRoutingDecision",
    path: "src/workflow/refiner/feedback.ts",
    find: '        notes: [`${reviewed} and sent it to nobody.${stayHeld}`, said],\n        wake: "human",',
    replace:
      '        notes: [`${reviewed} and sent it to nobody.${stayHeld}`, said],\n        wake: "none",',
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
    invariant: "reviewLoop::aPromptToAPageAuthorCarriesItsHeldComments",
    path: "src/workflow/refiner/held-comments.ts",
    find: "  const unmarked = await workflow\n    .artifact(artifact.kind)\n    .acknowledge(heldCommentHandles(comments), artifact.ref);",
    replace: "  const unmarked: FeedbackHandle[] = [];",
  },
  {
    id: "W15",
    invariant: "workflowLifecycle::workflowStartsOnlyFromAPlan",
    path: "src/agent/tools/start/start.ts",
    find: "        const notStarted = validateWorkflowStarted(workflow);",
    replace: "        const notStarted: string | null = null;",
  },
  {
    id: "W16",
    invariant: "reviewLoop::judgeRulesAtMostOnce",
    path: "src/workflow/refiner/loop.ts",
    find: "  const refusal = validateJudgeAwaitsRuling(workflow, reviewer);\n  if (refusal) {",
    replace:
      "  const refusal = validateJudgeAwaitsRuling(workflow, reviewer);\n  if (false && refusal) {",
  },
  {
    id: "W17",
    invariant: "reviewLoop::reviewerRunsOnlyOnAnUnreviewedRevision",
    path: "src/workflow/refiner/stage-refiner.ts",
    find: "  if (entryReviewedRevision(runs, index, revision)) return true;\n",
    replace: "",
  },
  {
    id: "W18",
    invariant: "reviewLoop::authorGetsEveryPullFinding",
    path: "src/workflow/refiner/loop.ts",
    find: "    if (!reviewAsksTheAuthor(review)) {\n      return advanceArtifactPastEntry(workflow, author, index, revision);",
    replace:
      "    if (true || !reviewAsksTheAuthor(review)) {\n      return advanceArtifactPastEntry(workflow, author, index, revision);",
  },
  {
    id: "W19",
    invariant: "workflowLifecycle::finishedTaskKeepsItsStatus (restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (isTaskFinished(closed.status) || closed.restarts !== restarts) return;",
    replace: "  if (closed.restarts !== restarts) return;",
  },
  {
    id: "W20",
    invariant: "workflowLifecycle::endedWorkflowHasNoUnfinishedTask",
    path: "src/agent/tools/plan.ts",
    find: '  if (workflowEnding(workflow)) return "The workflow is ending. A workflow that ends stays ended.";\n',
    replace: "",
  },
  {
    id: "W21",
    invariant:
      "reviewLoop::authorIsIdleWhileAPolisherRuns, harnessSession::pausedAuthorGetsNoPrompt",
    path: "src/workflow/task/harness/prompt-queue.ts",
    find: "  if (!promptsWait(workflow, task)) return sendPrompt(workflow, task, text);",
    replace: "  return sendPrompt(workflow, task, text);",
  },
  {
    id: "W22",
    invariant: "workflowLifecycle::pausedAuthorGetsNoPrompt (restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (closed.paused_at === null) await startSandbox(workflow, closed, true);",
    replace: "  if (true || closed.paused_at === null) await startSandbox(workflow, closed, true);",
  },
  {
    id: "W23",
    invariant: "reviewLoop::aPromptToAPageAuthorCarriesItsHeldComments (unmarked)",
    path: "src/workflow/refiner/held-comments.ts",
    find: "  return comments.filter((comment) => !unmarkedIds.has(comment.id));",
    replace: "  return comments;",
  },
  {
    id: "W24",
    invariant: "reviewLoop::aHeldCommentStaysHeldUntilItReachesTheAuthor",
    path: "src/workflow/refiner/feedback.ts",
    find: "    ? await workflow.artifact(artifact.kind).acknowledge(feedback.handles, artifact.ref)",
    replace:
      '    ? await workflow.artifact(artifact.kind).acknowledge([...feedback.handles, ...held.map((comment) => ({ kind: "page" as const, comment_id: comment.id }))], artifact.ref)',
  },
  {
    id: "W25",
    invariant: "reviewLoop::sentCommentIsAnsweredBeforeItsLineGoes (queued)",
    path: "src/workflow/task/model-author.ts",
    find: "  if (!queuedCommentIds.length) return;",
    replace: "  if (queuedCommentIds.length || true) return;",
  },
  {
    id: "W26",
    invariant: "reviewLoop::aModelCallAuthorFailsOnlyOnAHostError",
    path: "src/workflow/task/model-author.ts",
    find: "  if ((await documents.readPageContent(ref.page_id)) !== pageText) return { startOver: true };\n",
    replace: "",
  },
  {
    id: "W27",
    invariant: "reviewLoop::aModelCallAuthorFailsOnlyOnAHostError (gone comment)",
    path: "src/workflow/task/model-author.ts",
    find: "    if (!(await documents.fetchComment(reply.comment_id))) {",
    replace: "    if (false) {",
  },
  {
    id: "W28",
    invariant: "harnessSession::taskRestartsAtMostTwice (stale start)",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: '    if (generationMoved(workflow, sandbox)) return;\n    return restartOrFailTask(\n      workflow,\n      fresh,\n      loggedFailureReason(fresh.task_id, "The sandbox start"),\n',
    replace:
      '    return restartOrFailTask(\n      workflow,\n      fresh,\n      loggedFailureReason(fresh.task_id, "The sandbox start"),\n',
  },
  {
    id: "W29",
    invariant: "harnessSession::aRunningTurnKeepsItsSandboxAwake (stale restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (sandbox.generation !== generation) return;\n",
    replace: "",
  },
  {
    id: "W30",
    invariant: "harnessSession::taskRestartsAtMostTwice (counted restart)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (isTaskFinished(closed.status) || closed.restarts !== restarts) return;",
    replace: "  if (isTaskFinished(closed.status)) return;",
  },
  {
    id: "W31",
    invariant:
      "harnessSession::finishedTaskKeepsItsStatus, harnessSession::anAuthorInReviewWorksOnlyWithAPrompt (stop)",
    path: "src/workflow/inbound/controls.ts",
    find: '    if (starting) workflow.store.updateTask(author.task_id, { status: "working" });\n    await closeContainer(workflow, author, "a person pressed Stop");\n',
    replace:
      '    await closeContainer(workflow, author, "a person pressed Stop");\n    if (starting) workflow.store.updateTask(author.task_id, { status: "working" });\n',
  },
  {
    id: "W32",
    invariant: "harnessSession::anAuthorInReviewRunsNoTurn (stale outcome)",
    path: "src/workflow/task/harness/turn.ts",
    find: "  if (workflow.store.requireSandbox(task.task_id).generation !== generation) return;\n",
    replace: "",
  },
  {
    id: "W33",
    invariant: "harnessSession::anAuthorInReviewRunsNoTurn (handshake)",
    path: "src/workflow/artifact.ts",
    find: "  if (workflow.store.handshakePending(taskId)) return;\n",
    replace: "",
  },
  {
    id: "W34",
    invariant: "harnessSession::anAnswerReachesOnlyItsOwnRequest (rpc id given twice)",
    path: "src/workflow/store/tasks.ts",
    find: "      .values({ task_id: taskId, method, purpose, sent_at: now() })\n",
    replace:
      "      .values({ id: (this.db.select({ id: rpc.id }).from(rpc).orderBy(desc(rpc.id)).limit(1).get()?.id ?? 0) + 1, task_id: taskId, method, purpose, sent_at: now() })\n",
  },
  {
    id: "W35",
    invariant: "harnessSession::aHarnessSessionRunsOneTurnAtATime (resume)",
    path: "src/workflow/inbound/controls.ts",
    find: "  workflow.store.updateTask(task.task_id, { paused_at: null });\n",
    replace:
      "  workflow.store.updateTask(task.task_id, { paused_at: null });\n  if (workflow.store.sandbox(task.task_id)) workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0 });\n",
  },
  {
    id: "W36",
    invariant: "harnessSession::aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn (blocked)",
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
    find: "  if (endsTurn) await endStoppedTurn(workflow, author);\n",
    replace:
      '  if (cancelled) return "cancelled";\n  if (endsTurn) await endStoppedTurn(workflow, author);\n',
  },
  {
    id: "W39",
    invariant: "harnessSession::anUnpausedTaskWithWorkIsNeverStranded (handshake close)",
    path: "src/workflow/task/harness/bridge.ts",
    find: "  return sandbox.prompt_in_flight === 1 || store.handshakePending(sandbox.task_id);",
    replace: "  return sandbox.prompt_in_flight === 1;",
  },
  {
    id: "W40",
    invariant: "harnessSession::anUnpausedTaskWithWorkIsNeverStranded (paused restart)",
    path: "src/workflow/lifecycle.ts",
    find: '  workflow.store.updateTask(task.task_id, { status: "queued", restarts });',
    replace: "  workflow.store.updateTask(task.task_id, { restarts });",
  },
  {
    id: "W41",
    invariant: "harnessSession::aHarnessSessionRunsOneTurnAtATime (lost turn)",
    path: "src/workflow/task/harness/bridge.ts",
    find: "    session_id: null,\n",
    replace: "",
  },
  {
    id: "W42",
    invariant: "harnessSession::aHarnessSessionRunsOneTurnAtATime (effort handshake)",
    path: "src/workflow/task/harness/prompt-queue.ts",
    find: '  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {\n    return false;\n  }\n  const connected = workflow.connections(task.task_id).length > 0;\n  if (connected && sandbox.session_id) {\n    workflow.store.dequeuePrompt(next.id);\n    await sendPrompt(workflow, task, next.text);\n    return true;\n  }\n',
    replace:
      '  const connected = workflow.connections(task.task_id).length > 0;\n  if (connected && sandbox.session_id) {\n    workflow.store.dequeuePrompt(next.id);\n    await sendPrompt(workflow, task, next.text);\n    return true;\n  }\n  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {\n    return false;\n  }\n',
  },
  {
    id: "W43",
    invariant:
      "harnessSession::anUnpausedTaskWithWorkIsNeverStranded (restart lost with the instance)",
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
    path: "src/workflow/restart.ts",
    find: '    await workflow.scheduleAlarm(0, "settleLostJudgeRuling", run);\n',
    replace: "",
  },
  {
    id: "W46",
    invariant: "reviewLoop::checksGoBackOncePerRevision",
    path: "src/workflow/refiner/checks-gate.ts",
    find: "  if (!claimChecksSendBack(workflow, artifact, conflict.revision)) return false;\n",
    replace:
      "  if (!claimChecksSendBack(workflow, artifact, `${conflict.revision}:conflict`)) return false;\n",
  },
  {
    id: "W47",
    invariant: "reviewLoop::replyGoesOnlyToASentComment",
    path: "src/prompts/model-author-prompt.ts",
    find: "  if (stray)\n",
    replace: "  if (stray && false)\n",
  },
  {
    id: "W48",
    invariant: "reviewLoop::failedReplyLeavesThePage (skipped reply)",
    path: "src/prompts/model-author-prompt.ts",
    find: "  if (unanswered) return",
    replace: "  if (unanswered && false) return",
  },
  {
    id: "W49",
    invariant: "workflowLifecycle::stoppedModelCallLeavesThePage",
    path: "src/workflow/task/model-author.ts",
    find: '  if (turn.ended()) {\n    workflow.log(task.task_id, "model call ended after a stop ended its turn. no change.");\n    return null;\n  }\n',
    replace: "",
  },
  {
    id: "W50",
    invariant: "workflowLifecycle::aModelCallAuthorHasAtMostOnePageWriteOut",
    path: "src/workflow/inbound/controls.ts",
    find: "  const writing = atWork && turnId !== null && workflow.pageWritesOut.has(turnId);\n",
    replace: "  const writing = false;\n",
  },
  {
    id: "A1",
    invariant: "agentTurns::laterDecisionsCallsFallBackOnceOneFails",
    path: "src/decisions/ask.ts",
    find: "    if (turn) turn.failed = true;\n",
    replace: "",
  },
  {
    id: "A2b",
    invariant: "agentTurns::aPersonHearsBackBeforeAnyWork",
    path: "src/agent/turn/turn.ts",
    find: "  const awaitingFirstReply = () => turn.personWrote && !progress.firstReplied;",
    replace:
      "  const awaitingFirstReply = () => false && turn.personWrote && !progress.firstReplied;",
  },
  {
    id: "A3",
    invariant: "agentTurns::theWorkingStatusNeverOutlivesItsTurn",
    path: "src/agent/turn/turn.ts",
    find: "  if (!owesTheReply) return workflow.release();",
    replace: "  if (!owesTheReply) return;",
  },
  {
    id: "A4",
    invariant: "agentTurns::aWaitingInboxRowHasATurnComing",
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
    invariant: "agentTurns::closingTextAnswersOnlyAPersonWhoWrote",
    path: "src/agent/turn/turn.ts",
    find: "    turn_board_changed: lostFirstRow !== null && workflow.state.turn_board_changed === true,",
    replace: "    turn_board_changed: false,",
  },
  {
    id: "A7",
    invariant: "agentTurns::aWaitingPersonHearsBackByTheTimeout (waits after the deadline)",
    path: "src/agent/turn/turn.ts",
    find: '    if (signal.aborted) return "timed_out";\n  }\n  try {',
    replace:
      '    if (signal.aborted) {\n      await new Promise((resolve) => setTimeout(resolve, 5));\n      return "timed_out";\n    }\n  }\n  try {',
  },
  {
    id: "W180",
    invariant:
      "agentTurns::aDecisionsCallFallsBackOnlyAfterEveryModelFailed (model runs before the runtime request lands)",
    path: "src/agent/turn/turn.ts",
    find: "  await compactIfLarge(workflow, turn, signal);\n  await runtimeRequest;\n",
    replace: "  await compactIfLarge(workflow, turn, signal);\n",
  },
  {
    id: "W181",
    invariant: "agentTurns::aWaitingInboxRowHasATurnComing (restart of a finished workflow)",
    path: "src/agent/turn/watchdog.ts",
    find: "    await workflow.release();\n    await wakeForWaitingRows(workflow);\n",
    replace: "    await workflow.release();\n",
  },
  {
    id: "W182",
    invariant: "behavior map A3: a revision request sends the held comments before the model runs",
    path: "src/agent/turn/turn.ts",
    find: "  if (reply?.asksForRevision) await sendHeldCommentsForRevision(workflow, decisions);\n",
    replace: "",
  },
  {
    id: "W183",
    invariant: "behavior map A2: a message that names a model starts the runtime request",
    path: "src/agent/turn/turn.ts",
    find: "    reply?.namesModel ? requestedRuntime(workflow, message, decisions) : null,",
    replace: "    null,",
  },
  {
    id: "W184",
    invariant: "agentTurns::theWorkingStatusNeverOutlivesItsTurn (watchdog of a finished workflow)",
    path: "src/agent/turn/watchdog.ts",
    find: "  if (isWorkflowFinished(workflow.state.status) && !answering.length) return workflow.release();\n",
    replace: "  if (isWorkflowFinished(workflow.state.status) && !answering.length) return;\n",
  },
  {
    id: "W185",
    invariant: "agentTurns::aPersonsTurnNeverEndsUnanswered (sent held comments as the reply)",
    path: "src/agent/turn/turn.ts",
    find: '    sent.notes.map((note) => ({ role: "user" as const, content: noteMessage(note) })),\n  );\n',
    replace:
      '    sent.notes.map((note) => ({ role: "user" as const, content: noteMessage(note) })),\n  );\n  if (sent.prompted.length) workflow.patchState({ turn_board_changed: true });\n',
  },
  {
    id: "W186",
    invariant: "agentTurns::aPersonsTurnNeverEndsUnanswered (watchdog of a finished workflow)",
    path: "src/agent/turn/watchdog.ts",
    find: "  if (isWorkflowFinished(workflow.state.status) && !answering.length) return workflow.release();\n",
    replace: "  if (isWorkflowFinished(workflow.state.status)) return workflow.release();\n",
  },
  {
    id: "R1",
    invariant: "routerBindings::messageAfterEndStartsNextWorkflow (claim)",
    path: "src/router/deliver.ts",
    find: "    if (!(await claimBinding(db, claimed.binding, { previous: claimed.workflowId, workflowId }))) {",
    replace:
      "    if (!((await claimBinding(db, claimed.binding, { previous: claimed.workflowId, workflowId })) || true)) {",
  },
  {
    id: "R2",
    invariant: "routerBindings::messageAfterEndStartsNextWorkflow (bind all)",
    path: "src/router/deliver.ts",
    find: "    if (index === claimedIndex) continue;\n    const previous = bound.workflowId;",
    replace:
      "    if (index === claimedIndex || true) continue;\n    const previous = bound.workflowId;",
  },
  {
    id: "R3",
    invariant: "routerBindings::aDeliveryLeavesTheBindingsOfARunningWorkflow",
    path: "src/router/deliver.ts",
    find: "    const previous = bound.workflowId;",
    replace: "    const previous = await findBinding(db, bound.binding);",
  },
  {
    id: "R4",
    invariant: "routerBindings::oneRunningWorkflowHasAJobOnAnIssue (moved binding)",
    path: "src/agent/tools/start/start.ts",
    find: "  return bound\n    ? null",
    replace: "  return bound || true\n    ? null",
  },
  {
    id: "R5",
    invariant: "routerBindings::oneRunningWorkflowHasAJobOnAnIssue (running workflow)",
    path: "src/agent/tools/start/start.ts",
    find: "    if (!row || !isWorkflowFinished(row.status)) {",
    replace: "    if (!row) {",
  },
  {
    id: "F1",
    invariant:
      "feedbackRouting::unadmittedFeedbackReachesNobody, reviewLoop::unadmittedFeedbackReachesNobody",
    path: "src/workflow/refiner/feedback.ts",
    find: '      return toTheAgent({ notes: [unadmittedFeedbackNote(wrote, screened)], wake: "human" });',
    replace:
      '      return toTheAgent({ notes: [unadmittedFeedbackNote(wrote, screened), said], wake: "human" });',
  },
  {
    id: "F2",
    invariant: "feedbackRouting::unadmittedFeedbackReachesNobody (unchecked app review)",
    path: "src/workflow/refiner/feedback.ts",
    find: "  if (feedback.unchecked || held.length) {",
    replace: "  if (held.length) {",
  },
  {
    id: "F3",
    invariant: "feedbackRouting::unadmittedFeedbackReachesNobody (app review text)",
    path: "src/workflow/inbound/events.ts",
    find: '  const told = pullDetailOf(event)?.reviewer_is_app ? { ...event, text: "" } : event;',
    replace: "  const told = event;",
  },
  {
    id: "F4",
    invariant: "feedbackRouting::everyFeedbackGetsOneRoutingDecision (finished author)",
    path: "src/workflow/refiner/feedback.ts",
    find: "  if (isTaskFinished(task.status)) {\n    return toTheAgent(",
    replace: "  if (false) {\n    return toTheAgent(",
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
    find: "if (eyes.added && (await eyesAddedWithinTheWait(eyes.added))) {",
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
  {
    id: "W51",
    invariant:
      "reviewLoop::aRestartDoesNotStrandAJudgeRun (rulings asked before the lost model turns)",
    path: "src/workflow/restart.ts",
    find: "  await resumeLostModelTurns(workflow, alarm.model_turns);\n",
    replace:
      '  const { settleLostJudgeRuling } = await import("./refiner/loop");\n  for (const run of alarm.judge_runs) await settleLostJudgeRuling(workflow, run);\n  await resumeLostModelTurns(workflow, alarm.model_turns);\n',
  },
  {
    id: "W107",
    invariant: "harnessSession::aStoppedAuthorStaysQuiet",
    path: "src/workflow/inbound/controls.ts",
    find: "generation: sandbox.generation + 1",
    replace: "generation: sandbox.generation",
  },
  {
    id: "W108",
    invariant: "harnessSession::aStoppedAuthorStaysQuiet (commit author lookup)",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: '    if (generationMoved(workflow, sandbox)) return;\n    return restartOrFailTask(\n      workflow,\n      fresh,\n      loggedFailureReason(fresh.task_id, "The commit author lookup"),\n',
    replace:
      '    return restartOrFailTask(\n      workflow,\n      fresh,\n      loggedFailureReason(fresh.task_id, "The commit author lookup"),\n',
  },
  {
    id: "W109",
    invariant: "reviewLoop::refinersStartOnlyWhenTheAuthorsGateOpens",
    path: "src/workflow/refiner/loop.ts",
    find: '  if (gate.gate !== "open") return;\n',
    replace: "",
  },
  {
    id: "W110",
    invariant: "reviewLoop::aBlockedAuthorsGateHandsOverBlocked",
    path: "src/workflow/refiner/loop.ts",
    find: 'return markArtifactReady(workflow, task.job_id, { close: "blocked", reason: gate.reason });',
    replace: 'return markArtifactReady(workflow, task.job_id, { close: "ready" });',
  },
  {
    id: "W111",
    invariant: "workflowLifecycle::aJobStartProvisionsItsTask",
    path: "src/workflow/lifecycle.ts",
    find: '  await workflow.scheduleAlarm(0, "provision", { task_id: taskId });\n  await changeWorkflowStatus(workflow, "running");\n',
    replace:
      '  await changeWorkflowStatus(workflow, "running");\n  await workflow.scheduleAlarm(0, "provision", { task_id: taskId });\n',
  },
  {
    id: "W112",
    invariant: "harnessSession::aTaskWithoutAnEarlierPromptGetsTheTaskPrompt",
    path: "src/workflow/task/harness/prompt-queue.ts",
    find: "  if (sandbox.first_prompt_at === null) {\n",
    replace: "  if (sandbox.generation <= 1) {\n",
  },
  {
    id: "W113",
    invariant: "workflowLifecycle::aStoppedModelCallAuthorStaysQuiet",
    path: "src/workflow/task/model-turn.ts",
    find: "  if (task.model_turn_id !== heldTurnId) return;\n",
    replace: "",
  },
  {
    id: "W114",
    invariant: "reviewLoop::aStoppedRefinerRunHandsOverBlocked (review read)",
    path: "src/workflow/refiner/loop.ts",
    find: '  if ("readFailed" in read)\n    return handOverBlockedFromReviewer(\n      workflow,\n      reviewer,\n      `The reviewer\'s review could not be read (${read.readFailed}).`,\n    );\n',
    replace: "",
  },
  {
    id: "W115",
    invariant: "feedbackRouting::everyFeedbackIsRoutedOnce (seen on arrival)",
    path: "src/workflow/inbound/events.ts",
    find: "  if (workflow.store.eventSeen(event.id)) return { ok: true, duplicate: true };",
    replace: "  if (!workflow.store.markEventSeen(event)) return { ok: true, duplicate: true };",
  },
  {
    id: "W116",
    invariant: "feedbackRouting::everyFeedbackIsRoutedOnce (duplicate delivery)",
    path: "src/workflow/refiner/feedback.ts",
    find: "  if (!workflow.store.eventSeen(key)) return false;",
    replace: "  if (key) return false;",
  },
  {
    id: "W120",
    invariant: "workflowLifecycle::workflowWaitsOnlyWhileNoAuthorWorks",
    path: "src/workflow/lifecycle.ts",
    find: "  if (workflow.store.activeAuthorAndResearcherTasks().some((task) => BUSY.has(task.status))) return;\n",
    replace: "",
  },
  {
    id: "W121",
    invariant: "workflowLifecycle::sleepMessageOnlyDuringAWorkflow",
    path: "src/workflow/lifecycle.ts",
    find: '  if (workflow.state.status !== "running") return;\n  workflow.log(null, "idle. going to sleep.");\n',
    replace: '  workflow.log(null, "idle. going to sleep.");\n',
  },
  {
    id: "W122",
    invariant: "workflowLifecycle::aRestartDoesNotLoseAModelTurn",
    path: "src/workflow/task/model-turn.ts",
    find: '    await workflow.scheduleAlarm(0, "runLostModelTurnAgain", author);\n',
    replace: "",
  },
  {
    id: "W123",
    invariant:
      "workflowLifecycle::aQueuedPromptReachesItsModelCallAuthor, reviewLoop::aQueuedPromptReachesItsModelCallAuthor",
    path: "src/workflow/task/model-turn.ts",
    find: "  if (task) await drainQueue(workflow, task);\n",
    replace: "  if (task) return;\n",
  },
  {
    id: "W124",
    invariant: "workflowLifecycle::aSingleIssueWorkflowIsDoneWithItsSubjectsJob",
    path: "src/workflow/subject.ts",
    find: "  return stages.at(-1) === job.stage && isSingleIssueWorkflow(workflow);\n",
    replace: "  return false;\n",
  },
  {
    id: "W125",
    invariant: "workflowLifecycle::subjectNeverChanges",
    path: "src/workflow/subject.ts",
    find: "  return `The subject of this workflow is ${shown}, and it never changes.",
    replace:
      "  return null;\n  return `The subject of this workflow is ${shown}, and it never changes.",
  },
  {
    id: "W126",
    invariant: "workflowLifecycle::aJobWorksOnlyOnIssuesOfItsSubject",
    path: "src/workflow/subject.ts",
    find: "  if (issueInSubject(subject, issue)) return null;\n",
    replace: "  return null;\n",
  },
  {
    id: "W127",
    invariant: "workflowLifecycle::workflowKeepsItsDefinition",
    path: "src/agent/tools/plan.ts",
    find: "  if (stored === null || stored === named) return null;\n",
    replace: "  return null;\n",
  },
  {
    id: "W128",
    invariant: "workflowLifecycle::aFailedCheckNeverAsksThePersonAgain",
    path: "src/agent/tools/start/start.ts",
    find: "${TELL_THE_CHECK_IS_UNAVAILABLE}",
    replace: "${ASK_WHETHER_ACCEPTED}",
  },
  {
    id: "W129",
    invariant: "workflowLifecycle::finishedWorkflowKeepsItsStatus",
    path: "src/workflow/lifecycle.ts",
    find: "  if (workflowEnding(workflow) || isWorkflowFinished(workflow.state.status)) return false;\n",
    replace: "  if (workflowEnding(workflow)) return false;\n",
  },
  {
    id: "W130",
    invariant: "workflowLifecycle::anAcceptedArtifactNeverMovesBack",
    path: "src/workflow/refiner/outcome.ts",
    find: '  if (artifact.status !== "drafted") return;\n  const revision = await artifactRevision(workflow, artifact);\n  if (!workflow.store.advanceArtifact(jobId, ["drafted"], "ready")) return;\n',
    replace:
      '  if (artifact.status === "ready") return;\n  const revision = await artifactRevision(workflow, artifact);\n  if (!workflow.store.advanceArtifact(jobId, ["drafted", "accepted"], "ready")) return;\n',
  },
  {
    id: "W131",
    invariant: "workflowLifecycle::artifactStatusMovesAreLegal",
    path: "src/workflow/refiner/outcome.ts",
    find: '  if (artifact.status !== "drafted") return;\n  const revision = await artifactRevision(workflow, artifact);\n  if (!workflow.store.advanceArtifact(jobId, ["drafted"], "ready")) return;\n',
    replace:
      '  if (artifact.status === "ready") return;\n  const revision = await artifactRevision(workflow, artifact);\n  if (!workflow.store.advanceArtifact(jobId, ["drafted", "removed"], "ready")) return;\n',
  },
  {
    id: "W132",
    invariant: "harnessSession::inReviewTaskHasAnArtifact",
    path: "src/workflow/artifact.ts",
    find: "  if (!workflow.store.artifact(task.job_id)) return;\n",
    replace: "",
  },
  {
    id: "W133",
    invariant: "workflowLifecycle::inReviewTaskHasAnArtifact",
    path: "src/workflow/task/model-turn.ts",
    find: '    status: pageOut ? "in_review" : "working",\n',
    replace: '    status: "in_review",\n',
  },
  {
    id: "W134",
    invariant: "workflowLifecycle::aModelCallAuthorWorksOnlyWhileItsCallIsOut",
    path: "src/workflow/task/model-turn.ts",
    find: "      if (current()) workflow.store.updateTask(taskId, { model_turn_id: null });\n",
    replace: "",
  },
  {
    id: "W135",
    invariant: "reviewLoop::oneUnfinishedRefinerRunPerArtifact",
    path: "src/workflow/refiner/loop.ts",
    find: "  workflow.patchState({ task_seq: sequence });\n  workflow.store.setArtifactRefinerRun(author.job_id, refinerRunId);\n",
    replace: "  workflow.patchState({ task_seq: sequence });\n",
  },
  {
    id: "W136",
    invariant: "reviewLoop::refinerRunIsDoneOnlyAfterItsTurnEnded",
    path: "src/workflow/refiner/loop.ts",
    find: '  workflow.store.setArtifactRefinerRun(author.job_id, null);\n  if (artifact.status !== "drafted") {\n    workflow.log(\n      author.task_id,\n      `reviewer run dropped',
    replace:
      '  workflow.store.updateTask(reviewer.task_id, { status: "done" });\n  workflow.store.setArtifactRefinerRun(author.job_id, null);\n  if (artifact.status !== "drafted") {\n    workflow.log(\n      author.task_id,\n      `reviewer run dropped',
  },
  {
    id: "W137",
    invariant: "reviewLoop::authorGetsEveryPageFinding",
    path: "src/workflow/refiner/outcome.ts",
    find: "  const total = review.findings.length;\n",
    replace:
      '  if (artifact.ref.kind === "page") return;\n  const total = review.findings.length;\n',
  },
  {
    id: "W138",
    invariant: "reviewLoop::pageReviewPostsEachFindingOnce",
    path: "src/artifact/page-review.ts",
    find: "    pageFindings: review.findings.filter((finding) => !inline.has(finding)),\n",
    replace: "    pageFindings: review.findings,\n",
  },
  {
    id: "W139",
    invariant: "reviewLoop::aJudgeRejectionPostsItsReasonOnce",
    path: "src/workflow/refiner/loop.ts",
    find: "  if (support.postRejection) await support.postRejection(artifact.ref, signedReason);\n",
    replace:
      "  if (support.postRejection) {\n    await support.postRejection(artifact.ref, signedReason);\n    await support.postRejection(artifact.ref, signedReason);\n  }\n",
  },
  {
    id: "W140",
    invariant: "reviewLoop::deliveredToHumansIsNeverCleared",
    path: "src/workflow/store/records.ts",
    find: "    const firstAt = this.artifact(jobId)?.delivered_to_humans_at ?? at;\n",
    replace: "    const firstAt = this.artifact(jobId)?.delivered_to_humans_at ? null : at;\n",
  },
  {
    id: "W141",
    invariant:
      "reviewLoop::aRefinerRunRestartsAtMostTwice, workflowLifecycle::taskRestartsAtMostTwice",
    path: "src/workflow/lifecycle.ts",
    find: "  if (current.restarts >= MAX_RESTARTS) return failTask(workflow, task, reason);\n",
    replace: "  if (current.restarts > MAX_RESTARTS) return failTask(workflow, task, reason);\n",
  },
  {
    id: "W142",
    invariant: "reviewLoop::aFinishedRefinerRunKeepsItsStatus",
    path: "src/workflow/refiner/loop.ts",
    find: '  if (isTaskFinished(run.status)) return;\n  workflow.store.updateTask(run.task_id, { status: "done" });\n',
    replace: '  workflow.store.updateTask(run.task_id, { status: "done" });\n',
  },
  {
    id: "W143",
    invariant: "reviewLoop::anEndedAuthorEndsItsReview",
    path: "src/workflow/lifecycle.ts",
    find: "  await cancelRefinerRunOf(workflow, jobId, options.reason);\n  await markArtifactReady(workflow, jobId, options.close);\n",
    replace: "  await markArtifactReady(workflow, jobId, options.close);\n",
  },
  {
    id: "W144",
    invariant: "reviewLoop::aPolisherEndsDoneOnlyWhenItsChecksOpen",
    path: "src/workflow/refiner/polish.ts",
    find: '    case "waiting":\n    case "sent_back":\n',
    replace:
      '    case "waiting":\n      return endPolisherRun(workflow, polisher, { ended: "turn" });\n    case "sent_back":\n',
  },
  {
    id: "W210",
    invariant: "workflowLifecycle replay: a model call's turn ends once its author finishes",
    path: "src/workflow/lifecycle.ts",
    find: "  workflow.store.updateTask(task.task_id, { status, model_turn_id: null });\n",
    replace: "  workflow.store.updateTask(task.task_id, { status });\n",
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
    `The nightly mutant run on seed ${seed} found mutants the spec replays did not kill.`,
    ["| Mutant | Invariant | File | Result |", "| --- | --- | --- | --- |", ...rows].join("\n"),
    "A surviving mutant shows a rule the generators do not reach. Update a mutant that no longer applies in `packages/orchestrator/scripts/properties/mutants.ts`.",
    "",
  ].join("\n\n");
}

async function killedByASpecReplay(seed: number): Promise<boolean> {
  for (const file of Object.values(SPEC_REPLAY_FILES)) {
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
    return { mutant, status: (await killedByASpecReplay(seed)) ? "killed" : "survived" };
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
