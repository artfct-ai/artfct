#!/usr/bin/env bun
/**
 * Applies each hand-written mutant to the source, one at a time, and runs its property files
 * against it on `PROPERTY_SEED`: the standalone property file it names, or else every spec replay.
 * A mutant that each of its property files passes survives. When a mutant survives or no longer
 * applies, the report goes to the path in the first argument.
 * Usage: PROPERTY_SEED=<integer> bun scripts/properties/mutants.ts <report-path>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPEC_REPLAY_FILES, runPropertyFile, standalonePropertyFile } from "./property-files";

/**
 * A one-place change to the source that breaks the invariant it names. Its path is relative to the
 * orchestrator package. A mutant of a standalone property invariant names the property file that
 * kills it, by its path relative to the orchestrator package.
 */
export type Mutant = {
  id: string;
  invariant: string;
  path: string;
  find: string;
  replace: string;
  propertyFile?: string;
};

/** What a mutant's property files did to it. */
export type MutantResult = {
  mutant: Mutant;
  status: "killed" | "survived" | "not_applied";
};

/** The hand-written mutants. Each one breaks the rule it names, which its property files are meant to catch. */
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
    find: "if (active.length < slots) return null;",
    replace: "if (active.length <= slots) return null;",
  },
  {
    id: "W3",
    invariant: "workflowLifecycle::nothingReopensAFinishedWorkflow",
    path: "src/workflow/inbound/events.ts",
    find: "  if (isWorkflowFinished(workflow.store.workflowStatus())) {\n    await replyFinished",
    replace:
      '  if (isWorkflowFinished(workflow.store.workflowStatus()) && event.kind !== "prompt") {\n    await replyFinished',
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
    find: "  await closeSessionFeed(workflow, task, busy ? closingWhenTheAuthorGoesOn(closing) : closing);\n  if (!busy)",
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
    find: "  if (!waits) return sendPrompt(workflow, task, { text, queued: wake });",
    replace: "  return sendPrompt(workflow, task, { text, queued: wake });",
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
    find: '  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {\n    return false;\n  }\n  const connected = workflow.connections(task.task_id).length > 0;\n  if (connected && sandbox.session_id) {\n    await sendPrompt(workflow, task, { text: next.text, queued: next });\n    return true;\n  }\n',
    replace:
      '  const connected = workflow.connections(task.task_id).length > 0;\n  if (connected && sandbox.session_id) {\n    await sendPrompt(workflow, task, { text: next.text, queued: next });\n    return true;\n  }\n  if (task.status === "provisioning" || workflow.store.handshakePending(task.task_id)) {\n    return false;\n  }\n',
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
    find: '  if (waking) await workflow.scheduleAlarm(0, "runAgent", {});\n',
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
    path: "src/agent/turn/watchdog.ts",
    find: "    boardChanged: lost?.board_changed ?? false,\n",
    replace: "    boardChanged: false,\n",
  },
  {
    id: "A7",
    invariant: "agentTurns::aWaitingPersonHearsBackByTheTimeout (waits after the deadline)",
    path: "src/agent/turn/turn.ts",
    find: '    if (run.signal.aborted) return "timed_out";\n  }\n  try {',
    replace:
      '    if (run.signal.aborted) {\n      await new Promise((resolve) => setTimeout(resolve, 5));\n      return "timed_out";\n    }\n  }\n  try {',
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
    id: "W210",
    invariant: "agentTurns::aWaitingInboxRowHasATurnComing (backup alarm)",
    path: "src/agent/turn/tell.ts",
    find: '  const backup = await workflow.scheduleAlarm(0, "runAgent", {});\n',
    replace: '  const backup = "no backup alarm";\n',
  },
  {
    id: "W211",
    invariant: "agent turns replay: the turn lane cancels its backup alarm",
    path: "src/agent/turn/tell.ts",
    find: "    .then(() => workflow.cancelAlarm(backup))\n",
    replace: "    .then(() => backup)\n",
  },
  {
    id: "W212",
    invariant: "agentTurns::theWorkingStatusNeverOutlivesItsTurn (release of a finished workflow)",
    path: "src/workflow/posts.ts",
    find: '    if (target.source === "chat") await workflow.notifier.release(target, finished, title);\n',
    replace:
      '    if (target.source === "chat") await workflow.notifier.release(target, false, title);\n',
  },
  {
    id: "W213",
    invariant: "agent turns replay: each step shows the chat thread its working status",
    path: "src/workflow/posts.ts",
    find: '    if (target.source === "chat") await workflow.notifier.working(target, text);\n',
    replace: '    if (target.source === "chat") return;\n',
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
    find: "    await sendHeldCommentsForRevision(workflow, decisions);\n",
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
    find: "  if (isWorkflowFinished(workflow.store.workflowStatus()) && !answering.length)\n    return workflow.release();\n",
    replace:
      "  if (isWorkflowFinished(workflow.store.workflowStatus()) && !answering.length)\n    return;\n",
  },
  {
    id: "W185",
    invariant: "agentTurns::aPersonsTurnNeverEndsUnanswered (sent held comments as the reply)",
    path: "src/agent/turn/turn.ts",
    find: "    await sendHeldCommentsForRevision(workflow, decisions);\n",
    replace:
      "    await sendHeldCommentsForRevision(workflow, decisions);\n    progress.boardChanged = true;\n",
  },
  {
    id: "W186",
    invariant: "agentTurns::aPersonsTurnNeverEndsUnanswered (watchdog of a finished workflow)",
    path: "src/agent/turn/watchdog.ts",
    find: "  if (isWorkflowFinished(workflow.store.workflowStatus()) && !answering.length)\n    return workflow.release();\n",
    replace:
      "  if (isWorkflowFinished(workflow.store.workflowStatus())) return workflow.release();\n",
  },
  {
    id: "W250",
    invariant: "agentTurns::aStaleTurnAlarmChangesNothing (heads-up)",
    path: "src/agent/turn/watchdog.ts",
    find: "  if (!runningTurnOf(workflow, alarm.started_at)) return;\n  workflow.store.clearHeadsUpSchedule();\n",
    replace: "  workflow.store.clearHeadsUpSchedule();\n",
  },
  {
    id: "W251",
    invariant: "agentTurns::aStaleTurnAlarmChangesNothing (watchdog)",
    path: "src/agent/turn/watchdog.ts",
    find: "  const turn = runningTurnOf(workflow, alarm.started_at);\n  if (!turn) return;\n  workflow.store.deleteAgentTurn();\n  const answering",
    replace:
      "  const turn = workflow.store.agentTurn() ?? { heads_up_schedule: null };\n  workflow.store.deleteAgentTurn();\n  const answering",
  },
  {
    id: "W252",
    invariant: "agentTurns::theHeadsUpPostsOnceToChatInAPersonsTurn (a turn nobody wrote in)",
    path: "src/agent/turn/watchdog.ts",
    find: "  const headsUp = workflow.transcript.takenMessages().length\n",
    replace: "  const headsUp = true\n",
  },
  {
    id: "W253",
    invariant: "agentTurns::theHeadsUpPostsOnceToChatInAPersonsTurn (chat threads only)",
    path: "src/agent/turn/watchdog.ts",
    find: '    if (target.source !== "chat") continue;\n',
    replace: "",
  },
  {
    id: "W254",
    invariant: "agentTurns::theHeadsUpPostsOnceToChatInAPersonsTurn (once per turn)",
    path: "src/agent/turn/watchdog.ts",
    find: "  workflow.store.clearHeadsUpSchedule();\n",
    replace:
      '  workflow.store.recordRunningTurn({\n    ...workflow.store.agentTurn()!,\n    heads_up_schedule: await workflow.scheduleAlarm(HEADS_UP_SECONDS, "onTurnHeadsUp", alarm),\n  });\n',
  },
  {
    id: "W255",
    invariant: "agentTurns::aPersonHearsBackBeforeAnyWork (held comments of a revision request)",
    path: "src/agent/turn/turn.ts",
    find: "    await acknowledgeRevisionRequest(workflow, turn.answering, acknowledgement);\n",
    replace: "",
  },
  {
    id: "W256",
    invariant:
      "agentTurns::aPersonsMessageLeavesTheInboxOnlyWithItsTurn (restart of a finished workflow)",
    path: "src/agent/turn/watchdog.ts",
    find: "  if (\n    isWorkflowFinished(workflow.store.workflowStatus()) &&\n    !workflow.transcript.takenMessages().length\n  ) {\n",
    replace: "  if (isWorkflowFinished(workflow.store.workflowStatus())) {\n",
  },
  {
    id: "W257",
    invariant:
      "behavior map A3: the agent hears that held comments stay held when their author finished",
    path: "src/workflow/refiner/held-comments.ts",
    find: "    if (carried === null) {\n      sent.notes.push(\n",
    replace: "    if (carried === null) {\n      continue;\n      sent.notes.push(\n",
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
    id: "W239",
    invariant: "routerBindings::theRouterRowMatchesTheWorkflowEnd",
    path: "src/workflow/lifecycle.ts",
    find: "  await writeRouterWorkflowStatus(workflow);\n  if (!end.posted)",
    replace: "  if (!end.posted)",
  },
  {
    id: "W420",
    invariant: "routerBindings::aPersonsEventCreatesTheWorkflowItFindsUncreated",
    path: "src/router/deliver.ts",
    find: "        return isPersonsStartOrMessage(event)\n",
    replace: "        return false\n",
  },
  {
    id: "W421",
    invariant: "routerBindings::aRecordedPullRequestIsBoundToItsWorkflow",
    path: "src/workflow/artifact.ts",
    find: "  if (binding) await bindWorkflow(workflow, binding);\n  workflow.store.upsertArtifact({\n    job_id: task.job_id,\n    kind,\n    external_url: target.url,\n    ref: target.ref,\n  });\n",
    replace:
      "  workflow.store.upsertArtifact({\n    job_id: task.job_id,\n    kind,\n    external_url: target.url,\n    ref: target.ref,\n  });\n  if (binding) await bindWorkflow(workflow, binding);\n",
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
    id: "W217",
    invariant:
      "behavior map E4: a page comment that does not mention the bot stays held and wakes nobody",
    path: "src/workflow/refiner/feedback.ts",
    find: '      workflow.log(task.task_id, "a page comment waits for a mention");',
    replace: '      await workflow.tellAgent("A page comment waits for a mention.", "human");',
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
    id: "W216",
    invariant:
      "chatAcknowledgement::eyesMarkOnlyASlowChatDelivery (tracker message with an acknowledgement)",
    path: "src/router/chat-ack.ts",
    find: '  if (!chat || !message || target?.source !== "chat") return deliver();',
    replace: "  if (!chat || !message || !target) return deliver();",
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
    find: "  if (sandbox.first_prompt_at === null) {\n    return taskPrompt(",
    replace: "  if (sandbox.generation <= 1) {\n    return taskPrompt(",
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
    find: '  if ("readFailed" in read)\n    return handOverBlockedFromReviewer(workflow, reviewer, {\n      reason: `The reviewer\'s review could not be read (${read.readFailed}).`,\n      revision,\n    });\n',
    replace: "",
  },
  {
    id: "W117",
    invariant: "sessionRouting::everySessionMessageLandsOnce (marked on arrival)",
    path: "src/workflow/inbound/events.ts",
    find: "  if (workflow.store.eventSeen(event.id)) return DUPLICATE;\n",
    replace:
      "  if (!workflow.store.markEventSeen(event.id)) return DUPLICATE;\n  event = { ...event, id: `${event.id}:landed` };\n",
  },
  {
    id: "W118",
    invariant: "sessionRouting::everySessionMessageLandsOnce (lands twice)",
    path: "src/workflow/inbound/events.ts",
    find: "  if (!routesBeforeItIsSeen(workflow, event) && !workflow.store.markEventSeen(event.id)) {\n    return DUPLICATE;\n  }\n",
    replace:
      "  if (!routesBeforeItIsSeen(workflow, event)) workflow.store.markEventSeen(event.id);\n",
  },
  {
    id: "W115",
    invariant: "feedbackRouting::everyFeedbackIsRoutedOnce (seen on arrival)",
    path: "src/workflow/inbound/events.ts",
    find: "  if (workflow.store.eventSeen(event.id)) return DUPLICATE;\n",
    replace: "  if (!workflow.store.markEventSeen(event.id)) return DUPLICATE;\n",
  },
  {
    id: "W116",
    invariant: "feedbackRouting::everyFeedbackIsRoutedOnce (duplicate delivery)",
    path: "src/workflow/refiner/feedback.ts",
    find: "  if (!workflow.store.eventSeen(key)) return false;",
    replace: "  if (key) return false;",
  },
  {
    id: "W190",
    invariant: "workflowLifecycle::aWorkflowEndReachesAFinishedStatus",
    path: "src/workflow/lifecycle.ts",
    find: '  await workflow.scheduleAlarmOnce("resumeWorkflowEnd", {});\n',
    replace: "",
  },
  {
    id: "W191",
    invariant: "workflowLifecycle::aPersonsMessageWakesTheWorkflow",
    path: "src/workflow/inbound/events.ts",
    find: '  if (workflow.store.requireWorkflowRow().status === "waiting_input")\n    await changeWorkflowStatus(workflow, "running");\n',
    replace: "",
  },
  {
    id: "W192",
    invariant: "workflowLifecycle::issuesMoveOnlyAtAStartOrADoneEnd",
    path: "src/workflow/lifecycle.ts",
    find: '      await workflow.post({ type: "workflow_failed", reason: end.reason }, to);\n',
    replace:
      '      await workflow.post({ type: "workflow_failed", reason: end.reason }, to);\n      for (const target of workflow.store.replyTargets()) {\n        if (target.source === "tracker") await workflow.notifier.moveIssue(target, "completed");\n      }\n',
  },
  {
    id: "W193",
    invariant: "workflowLifecycle::aModelCallAuthorWorksOnlyWhileItsCallIsOut",
    path: "src/workflow/task/model-turn.ts",
    find: "  await drainQueue(workflow, workflow.store.requireTask(task.task_id));\n}",
    replace: "}",
  },
  {
    id: "W200",
    invariant: "workflowLifecycle::pausedAuthorGetsNoPrompt (pausing step)",
    path: "src/workflow/inbound/controls.ts",
    find: "  if (isTaskFinished(task.status) || task.paused_at !== null) return;\n  workflow.store.updateTask(task.task_id, {\n    paused_at:",
    replace:
      '  if (isTaskFinished(task.status) || task.paused_at !== null) return;\n  await promptTask(workflow, task, "Keep going.");\n  workflow.store.updateTask(task.task_id, {\n    paused_at:',
  },
  {
    id: "W201",
    invariant: "workflowLifecycle::eachFailedTaskPostsItsFailureOnce",
    path: "src/workflow/lifecycle.ts",
    find: '  await workflow.post({ type: "failed", job_id: task.job_id, reason });\n',
    replace: "",
  },
  {
    id: "W202",
    invariant: "workflowLifecycle::anEndedWorkflowPostsItsEndOnce (done)",
    path: "src/workflow/lifecycle.ts",
    find: '      await workflow.post({ type: "done", result: end.reason }, to);\n',
    replace: "",
  },
  {
    id: "W203",
    invariant: "workflowLifecycle::anEndedWorkflowPostsItsEndOnce (failed twice)",
    path: "src/workflow/lifecycle.ts",
    find: '      await workflow.post({ type: "workflow_failed", reason: end.reason }, to);\n',
    replace:
      '      await workflow.post({ type: "workflow_failed", reason: end.reason }, to);\n      await workflow.post({ type: "workflow_failed", reason: end.reason }, to);\n',
  },
  {
    id: "W204",
    invariant: "workflowLifecycle::aCompletedJobEndsItsReview",
    path: "src/workflow/lifecycle.ts",
    find: '  await endReviewAndBoard(workflow, author.job_id, {\n    reason: "the job is complete",\n    close: { close: "ready" },\n  });\n  await closeTeardown(workflow, author, teardown);\n',
    replace: "  await closeTeardown(workflow, author, teardown);\n",
  },
  {
    id: "W171",
    invariant: "chatAcknowledgement::eyesMarkOnlyASlowChatDelivery",
    path: "src/router/chat-ack.ts",
    find: "  }, delayMs);",
    replace: "  }, delayMs / 2);",
  },
  {
    id: "W172",
    invariant: "routerBindings::aWorkflowGetsEventsOnlyOnceCreated",
    path: "src/workflow/inbound/events.ts",
    find: '  if (!workflow.store.workflowRow()) return { refused: "not_created" };\n',
    replace: "  if (!workflow.store.workflowRow()) return null;\n",
  },
  {
    id: "W173",
    invariant: "routerBindings::aPersonsMessageNeverReachesAnEndedWorkflow",
    path: "src/workflow/inbound/events.ts",
    find: '  if (isWorkflowFinished(status) && isMessage(event)) return { refused: "ended", status };',
    replace:
      '  if (isWorkflowFinished(status) && event.kind === "start") return { refused: "ended", status };',
  },
  {
    id: "W174",
    invariant: "routerBindings::anAbandonedWorkflowKeepsNoBinding",
    path: "src/router/deliver.ts",
    find: "  if (!(await deleteBindingsOfNewWorkflow(db, workflowId, sources))) return;\n",
    replace: "",
  },
  {
    id: "W175",
    invariant: "routerBindings::anEndedWorkflowKeepsNoCodeHostBinding",
    path: "src/workflow/lifecycle.ts",
    find: 'const CODE_SOURCES: BindingSource[] = ["code_branch", "code_pull"];',
    replace: 'const CODE_SOURCES: BindingSource[] = ["code_branch"];',
  },
  {
    id: "W176",
    invariant: "sessionRouting::feedActivityPostsOnce",
    path: "src/notify/notifier.ts",
    find: "await tracker.activity(session.session_id, content, { id });",
    replace: "await tracker.activity(session.session_id, content, { id: crypto.randomUUID() });",
  },
  {
    id: "W177",
    invariant: "sessionRouting::chatWorkflowNeverSetsASessionPlan",
    path: "src/workflow/feed/feed.ts",
    find: "  if (hasChatThread(workflow.store.replyTargets())) return;\n",
    replace: "",
  },
  {
    id: "W178",
    invariant: "sessionRouting::todoListIsFixedAfterFirstArtifact",
    path: "src/workflow/board/board-store.ts",
    find: "    if (author && this.artifact(author.job_id)) return;\n",
    replace: "",
  },
  {
    id: "W179",
    invariant: "sessionRouting::researchReadsCompleteOnceTheAuthorStarts",
    path: "src/workflow/lifecycle.ts",
    find: "  workflow.store.completeTodos(researcher.task_id);\n",
    replace: "",
  },
  {
    id: "W150",
    invariant: "harnessSession::aSandboxStartBeginsAFreshGeneration",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: "  const generation = sandbox.generation + 1;",
    replace: "  const generation = sandbox.generation;",
  },
  {
    id: "W151",
    invariant: "harnessSession::aStartingTaskWorksOnlyAfterItsHello",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: '  workflow.store.updateTask(task.task_id, { status: "provisioning" });',
    replace: '  workflow.store.updateTask(task.task_id, { status: "working" });',
  },
  {
    id: "W152",
    invariant: "harnessSession::aLostTurnCountsOneRestart (no container close)",
    path: "src/workflow/task/harness/bridge.ts",
    find: '  workflow.log(task.task_id, "bridge lost with a prompt in flight. restarting the sandbox.");\n',
    replace:
      '  workflow.log(task.task_id, "bridge lost with a prompt in flight. restarting the sandbox.");\n  const { restartOrFailTask } = await import("../../lifecycle");\n  return restartOrFailTask(workflow, task, "lost turn");\n',
  },
  {
    id: "W153",
    invariant: "harnessSession::aHarnessExitCountsOneRestart",
    path: "src/workflow/task/harness/session.ts",
    find: "  await restartSandbox(workflow, task);\n}\n\n/** `initialize` answered.",
    replace:
      "  await restartSandbox(workflow, task);\n  await restartSandbox(workflow, workflow.store.requireTask(task.task_id));\n}\n\n/** `initialize` answered.",
  },
  {
    id: "W154",
    invariant: "harnessSession::aFailedSandboxStartRestartsOrFails",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: '    if (generationMoved(workflow, sandbox)) return;\n    return restartOrFailTask(\n      workflow,\n      fresh,\n      loggedFailureReason(fresh.task_id, "The sandbox start"),\n',
    replace:
      '    if (true) return;\n    return restartOrFailTask(\n      workflow,\n      fresh,\n      loggedFailureReason(fresh.task_id, "The sandbox start"),\n',
  },
  {
    id: "W155",
    invariant: "harnessSession::aRefusedPromptLeavesTheTurn",
    path: "src/workflow/task/harness/turn.ts",
    find: '  if (purpose !== "prompt") return;\n  workflow.store.updateSandbox(task.task_id, { prompt_in_flight: 0 });',
    replace: '  if (purpose !== "prompt") return;',
  },
  {
    id: "W156",
    invariant: "harnessSession::provisionStartsOnlyAQueuedTask",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: '  const bound = workflow.store.requireTask(taskId);\n  if (bound.status !== "queued") return;\n',
    replace: "  const bound = workflow.store.requireTask(taskId);\n",
  },
  {
    id: "W157",
    invariant: "harnessSession::wallClockFailsWithoutARestart",
    path: "src/workflow/task/harness/timers.ts",
    find: "  await failTask(\n    workflow,\n    task,\n    `A turn ran longer than the limit",
    replace:
      "  await restartOrFailTask(\n    workflow,\n    task,\n    `A turn ran longer than the limit",
  },
  {
    id: "W158",
    invariant: "harnessSession::aBridgeConnectsOnlyWithTheCurrentToken",
    path: "src/workflow/task/harness/bridge.ts",
    find: "  if (!sandbox || sandbox.bridge_token !== bridgeTokenOf(dial.headers)) return null;",
    replace: "  if (!sandbox) return null;",
  },
  {
    id: "W159",
    invariant: "harnessSession::everyPermissionRequestWithAnAllowOptionIsAllowed",
    path: "src/workflow/task/harness/bridge.ts",
    find: '    outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },',
    replace: '    outcome: { outcome: "cancelled" },',
  },
  {
    id: "W160",
    invariant: "harnessSession::theHelloTimeoutWaitsWhileItsStartIsOut",
    path: "src/workflow/task/harness/timers.ts",
    find: "  if (sandboxStartInFlight(workflow, task.task_id, sandbox.generation)) {\n    return armHelloTimeout(workflow, { ...sandbox, hello_schedule: null });\n  }\n",
    replace: "",
  },
  {
    id: "W161",
    invariant: "agentTurns::everyInboxRowReachesTheTranscriptOnce",
    path: "src/agent/turn/watchdog.ts",
    find: "  workflow.transcript.deleteTaken();\n  await cancelTurnAlarms(workflow, turn);\n  return true;",
    replace: "  await cancelTurnAlarms(workflow, turn);\n  return true;",
  },
  {
    id: "W162",
    invariant: "agentTurns::compactionReplacesOnlyEarlierRows",
    path: "src/agent/turn/turn.ts",
    find: "  workflow.transcript.replaceThrough(older.at(-1)!.id, {",
    replace: "  workflow.transcript.replaceThrough(rows.at(-1)!.id, {",
  },
  {
    id: "W163",
    invariant: "agentTurns::everyToolCallKeepsItsResult",
    path: "src/agent/turn/turn.ts",
    find: "      workflow.transcript.append(step.messages);",
    replace:
      '      workflow.transcript.append(step.messages.filter((message) => message.role !== "tool"));',
  },
  {
    id: "W164",
    invariant: "agentTurns::aPersonsTurnNeverEndsUnanswered",
    path: "src/agent/turn/turn.ts",
    find: "  if (reply && !replied(pass, progress)) {",
    replace: "  if (false && reply && !replied(pass, progress)) {",
  },
  {
    id: "W165",
    invariant: "agentTurns::quarantinedTextNeverEntersTheTranscript",
    path: "src/agent/tools/screened.ts",
    find: '      return screened === "admitted" ? result : unadmittedResultText(name, screened);',
    replace:
      '      return screened === "quarantined" ? unadmittedResultText(name, screened) : result;',
  },
  {
    id: "W166",
    invariant: "agentTurns::aResumedTurnAnswersWhatItsLostTurnOwed",
    path: "src/agent/turn/watchdog.ts",
    find: "  if (workflow.transcript.takenMessages().length) {\n    await postKeepingWorkingStatus(workflow, LOST_PLACE_TEXT);\n  }\n",
    replace: "",
  },
  {
    id: "W167",
    invariant: "agentTurns::aPersonGetsTheAnswerDuringADecisionsOutage",
    path: "src/decisions/ask.ts",
    find: "  } catch (error) {\n    if (turn) turn.failed = true;",
    replace:
      '  } catch (error) {\n    if (turn) await new Promise((resolve) => turn.signal?.addEventListener("abort", resolve));\n    if (turn) turn.failed = true;',
  },
  {
    id: "W168",
    invariant: "agentTurns::aDecisionsCallFallsBackOnlyAfterEveryModelFailed",
    path: "../adapters/src/gateway/models-in-order.ts",
    find: "  for (const model of models) {",
    replace: "  for (const model of models.slice(0, 1)) {",
  },
  {
    id: "W169",
    invariant: "agentTurns::aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead",
    path: "src/decisions/screen.ts",
    find: "(name) => probabilities[`${field}.${name}`]! >= QUARANTINE_FLOOR,",
    replace:
      "() => Object.values(probabilities).some((probability) => probability >= QUARANTINE_FLOOR),",
  },
  {
    id: "W170",
    invariant: "agentTurns::oneTurnRunsAtATime",
    path: "src/agent/turn/watchdog.ts",
    find: "  workflow.store.deleteAgentTurn();\n  const answering = workflow.transcript.answering();\n",
    replace: "  const answering = workflow.transcript.answering();\n",
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
    find: '  if (workflow.store.requireWorkflowRow().status !== "running") return;\n  workflow.log(null, "idle. going to sleep.");\n',
    replace: '  workflow.log(null, "idle. going to sleep.");\n',
  },
  {
    id: "W122",
    invariant: "workflowLifecycle::aRestartDoesNotLoseAModelTurn",
    path: "src/workflow/task/model-turn.ts",
    find: '  await workflow.scheduleAlarm(0, "runLostModelTurnAgain", rerun);\n',
    replace: "",
  },
  {
    id: "W123",
    invariant:
      "workflowLifecycle::aQueuedPromptReachesItsModelCallAuthor, reviewLoop::aQueuedPromptReachesItsModelCallAuthor",
    path: "src/workflow/task/model-turn.ts",
    find: "  await drainQueue(workflow, workflow.store.requireTask(task.task_id));\n",
    replace: "",
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
    find: "  if (isWorkflowFinished(workflow.store.workflowStatus())) return false;\n",
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
    find: "    model: settings.model,\n  });\n  workflow.store.setArtifactRefinerRun(author.job_id, refinerRunId);\n",
    replace: "    model: settings.model,\n  });\n",
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
    find: "      ? support.postRejection(artifact.ref, signedReason)\n",
    replace:
      "      ? support\n          .postRejection(artifact.ref, signedReason)\n          .then(() => support.postRejection?.(artifact.ref, signedReason))\n",
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
    path: "src/workflow/lifecycle.ts",
    find: "  if (isTaskFinished(workflow.store.requireTask(task.task_id).status)) return false;\n",
    replace: "",
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
    id: "W220",
    invariant: "reviewLoop::authorGetsEveryPageFinding",
    path: "src/workflow/refiner/outcome.ts",
    find: "  const total = review.findings.length;\n",
    replace:
      '  if (artifact.ref.kind === "page") return;\n  const total = review.findings.length;\n',
  },
  {
    id: "W221",
    invariant: "reviewLoop::aPromptToAPageAuthorCarriesItsHeldComments (mention)",
    path: "src/workflow/refiner/feedback.ts",
    find: "feedbackText(who, withHeldComments(feedback, carried))",
    replace: "feedbackText(who, feedback)",
  },
  {
    id: "W222",
    invariant: "reviewLoop::failedReplyLeavesThePage (queued reply)",
    path: "src/workflow/task/model-author.ts",
    find: "  for (const reply of revision.replies) {\n    if (!(await documents.fetchComment(reply.comment_id))) {\n      workflow.log(task.task_id, `comment ${reply.comment_id} is gone from the page. no reply.`);\n      continue;\n    }\n    await documents.replyToComment(\n      { pageId: ref.page_id, commentId: reply.comment_id },\n      reply.text,\n    );\n  }\n  const after = isRootPage ? aboveResources(revision.pageText, pageText) : revision.pageText;\n  const change = { before: pageText, after };\n  await replyToQueuedCommentsOnRemovedLines(workflow, task, {\n    documents,\n    pageId: ref.page_id,\n    change,\n    promptId: request.promptId,\n  });\n",
    replace:
      "  const after = isRootPage ? aboveResources(revision.pageText, pageText) : revision.pageText;\n  const change = { before: pageText, after };\n  await replyToQueuedCommentsOnRemovedLines(workflow, task, {\n    documents,\n    pageId: ref.page_id,\n    change,\n    promptId: request.promptId,\n  });\n  for (const reply of revision.replies) {\n    if (!(await documents.fetchComment(reply.comment_id))) {\n      workflow.log(task.task_id, `comment ${reply.comment_id} is gone from the page. no reply.`);\n      continue;\n    }\n    await documents.replyToComment(\n      { pageId: ref.page_id, commentId: reply.comment_id },\n      reply.text,\n    );\n  }\n",
  },
  {
    id: "W223",
    invariant: "reviewLoop::aReviewWaitingForRoutingTellsTheAgent",
    path: "src/workflow/refiner/loop.ts",
    find: "    return askAgentToRoute(workflow, task, artifact, pointer);\n  }\n",
    replace: "    return;\n  }\n",
  },
  {
    id: "W224",
    invariant: "reviewLoop::aReviewWaitingForRoutingTellsTheAgent (failed review again call)",
    path: "src/workflow/refiner/loop.ts",
    find: "  if (reviewAgain === null) return askAgentToRoute(workflow, task, artifact, pointer);\n",
    replace: "  if (reviewAgain === null) return;\n",
  },
  {
    id: "W225",
    invariant: "reviewLoop::theRecheckAlarmRunsWhileTheGateHolds",
    path: "src/workflow/refiner/checks-gate.ts",
    find: '  if (gate.gate === "waiting" || gate.gate === "sent_back") {\n',
    replace: '  if (gate.gate === "waiting") {\n',
  },
  {
    id: "W226",
    invariant: "reviewLoop::theRecheckAlarmRunsWhileTheGateHolds (stop)",
    path: "src/workflow/refiner/checks-gate.ts",
    find: '  } else {\n    await workflow.stopRepeatingAlarm("recheckChecks", alarm);\n  }\n  return gate;\n',
    replace: "  }\n  return gate;\n",
  },
  {
    id: "W320",
    invariant: "reviewLoop::theRecheckAlarmRunsWhileTheGateHolds (idle author's open checks)",
    path: "src/workflow/refiner/checks-recheck.ts",
    find: '  await workflow.stopRepeatingAlarm("recheckChecks", alarm);\n  if (checks?.state === "failed" && !isTaskFinished(author.status)) {\n',
    replace:
      '  if (checks?.state === "failed" || checks?.state === "conflicted") {\n    await workflow.stopRepeatingAlarm("recheckChecks", alarm);\n  }\n  if (checks?.state === "failed" && !isTaskFinished(author.status)) {\n',
  },
  {
    id: "W321",
    invariant: "reviewLoop::theRecheckAlarmRunsWhileTheGateHolds (ended author's open checks)",
    path: "src/workflow/task/at-work.ts",
    find: "  if (isTaskFinished(task.status)) return false;\n",
    replace: "",
  },
  {
    id: "W227",
    invariant: "reviewLoop::anAnswerAtTheReviewLimitMovesOn",
    path: "src/workflow/refiner/loop.ts",
    find: "      return runRefinersOnRevision(workflow, author, artifact, refinerIndexOf(pointer) + 1);\n    }\n    if (taskSettings",
    replace:
      "      return runRefinersOnRevision(workflow, author, artifact, refinerIndexOf(pointer));\n    }\n    if (taskSettings",
  },
  {
    id: "W205",
    invariant: "harnessSession::aLostTurnCountsOneRestart (count)",
    path: "src/workflow/task/harness/bridge.ts",
    find: "  if (!restartWritten) workflow.store.updateTask(task.task_id, { restarts: restarts + 1 });\n",
    replace: "",
  },
  {
    id: "W206",
    invariant: "harnessSession::aLostTurnCountsOneRestart (limit)",
    path: "src/workflow/task/harness/bridge.ts",
    find: "  if (!restartWritten && restarts >= MAX_RESTARTS) {\n",
    replace: "  if (!restartWritten && restarts > MAX_RESTARTS) {\n",
  },
  {
    id: "W207",
    invariant: "harnessSession::aHarnessExitCountsOneRestart (limit)",
    path: "src/workflow/task/harness/session.ts",
    find: "    return failTask(workflow, task, `harness exited (code ${exit.code}) with no restarts left`);\n",
    replace: "    return;\n",
  },
  {
    id: "W208",
    invariant: "harnessSession::aHarnessExitCountsOneRestart (resume)",
    path: "src/workflow/task/harness/session.ts",
    find: "  await restartSandbox(workflow, task);\n}\n\n/** `initialize` answered.",
    replace:
      "  workflow.store.updateSandbox(task.task_id, { first_prompt_at: null });\n  await restartSandbox(workflow, task);\n}\n\n/** `initialize` answered.",
  },
  {
    id: "W209",
    invariant: "harnessSession::aLostTurnCountsOneRestart (queued for a restart)",
    path: "src/workflow/task/harness/bridge.ts",
    find: '  const restartWritten = status === "queued";\n',
    replace: "  const restartWritten = false;\n",
  },
  {
    id: "W235",
    invariant: "feedbackRouting::everyFeedbackGetsOneRoutingDecision (bare mention)",
    path: "src/workflow/refiner/feedback.ts",
    find: 'so nothing was sent. Ask them what they want.`,\n      ],\n      wake: "human",',
    replace: 'so nothing was sent. Ask them what they want.`,\n      ],\n      wake: "none",',
  },
  {
    id: "W236",
    invariant: "sessionRouting::aResearcherThatDidNotFinishRestartsOrFails (gave up)",
    path: "src/workflow/task/harness/turn.ts",
    find: "  if (!(await harnessGaveUp(workflow, run))) return false;\n",
    replace:
      '  if (run.role === "researcher" || !(await harnessGaveUp(workflow, run))) return false;\n',
  },
  {
    id: "W237",
    invariant: "sessionRouting::aResearcherThatDidNotFinishRestartsOrFails (stopped on a limit)",
    path: "src/workflow/task/harness/turn.ts",
    find: "  if (UNFINISHED_STOPS.includes(stopReason)) {\n",
    replace: '  if (UNFINISHED_STOPS.includes(stopReason) && run.role !== "researcher") {\n',
  },
  {
    id: "W238",
    invariant: "sessionRouting::sessionFeedEndsWhenItsAuthorIdles (restart mid feed post)",
    path: "src/notify/notifier.ts",
    find: '    this.outbox({ channel: "feed", kind: content.type, target: session, payload: activity });\n    const tracker = await this.tracker();\n    if (!tracker) return false;\n    for (let attempt = 1; attempt <= FEED_POST_ATTEMPTS; attempt += 1) {\n      try {\n        await tracker.activity(session.session_id, content, { id });\n',
    replace:
      '    const row = { channel: "feed", kind: content.type, target: session, payload: activity };\n    const tracker = await this.tracker();\n    if (!tracker) return false;\n    for (let attempt = 1; attempt <= FEED_POST_ATTEMPTS; attempt += 1) {\n      try {\n        await tracker\n          .activity(session.session_id, content, { id })\n          .finally(() => attempt === 1 && this.outbox(row));\n',
  },
  {
    id: "W244",
    invariant: "sessionRouting::closingReplyPostsOnceAfterAnInstanceRestart (alarm armed)",
    path: "src/workflow/feed/feed.ts",
    find: '  const alarm = await workflow.scheduleAlarm(\n    CLOSING_REPLY_ALARM_SECONDS,\n    "postClosingReply",\n    reply,\n  );\n  await postClosingReply(workflow, reply);\n  await workflow.cancelAlarm(alarm);\n',
    replace: "  await postClosingReply(workflow, reply);\n",
  },
  {
    id: "W245",
    invariant: "sessionRouting::closingReplyPostsOnceAfterAnInstanceRestart (same activity id)",
    path: "src/workflow/feed/feed.ts",
    find: "  await workflow.notifier.feed(reply.session, reply.activity);\n",
    replace:
      "  await workflow.notifier.feed(reply.session, { ...reply.activity, id: crypto.randomUUID() });\n",
  },
  {
    id: "W246",
    invariant:
      "sessionRouting::closingReplyPostsOnceAfterAnInstanceRestart (alarm cancelled once posted)",
    path: "src/workflow/feed/feed.ts",
    find: "  await postClosingReply(workflow, reply);\n  await workflow.cancelAlarm(alarm);\n",
    replace: "  await postClosingReply(workflow, reply);\n",
  },
  {
    id: "W247",
    invariant:
      "sessionRouting::closingReplyPostsOnceAfterAnInstanceRestart (alarm armed before the post)",
    path: "src/workflow/feed/feed.ts",
    find: '  const alarm = await workflow.scheduleAlarm(\n    CLOSING_REPLY_ALARM_SECONDS,\n    "postClosingReply",\n    reply,\n  );\n  await postClosingReply(workflow, reply);\n',
    replace:
      '  await postClosingReply(workflow, reply);\n  const alarm = await workflow.scheduleAlarm(\n    CLOSING_REPLY_ALARM_SECONDS,\n    "postClosingReply",\n    reply,\n  );\n',
  },
  {
    id: "W265",
    invariant: "harnessSession::staleAlarmIsIgnored (hello timeout)",
    path: "src/workflow/task/harness/timers.ts",
    find: '  if (!task || !sandbox || sandbox.generation !== alarm.generation) return;\n  if (task.status !== "provisioning") return;',
    replace: '  if (!task || !sandbox) return;\n  if (task.status !== "provisioning") return;',
  },
  {
    id: "W266",
    invariant: "routerBindings::aBaseMoveOnlyHandsTheEventOn",
    path: "src/router/deliver.ts",
    find: '  if (event.pull?.action === "base_moved") return fanOutBaseMoved(env, db, event, event.pull);\n',
    replace: "",
  },
  {
    id: "W267",
    invariant: "workflowLifecycle::aTurnThatWaitsToRunAgainHasItsAlarm",
    path: "src/workflow/task/model-turn.ts",
    find: '  await workflow.scheduleAlarm(0, "runLostModelTurnAgain", rerun);\n',
    replace: '  await workflow.scheduleAlarm(0, "runLostModelTurnAgain", turn);\n',
  },
  {
    id: "W268",
    invariant: "workflowLifecycle replay: a model call's turn ends once its author finishes",
    path: "src/workflow/lifecycle.ts",
    find: "  workflow.store.updateTask(task.task_id, { status, model_turn_id: null });\n",
    replace: "  workflow.store.updateTask(task.task_id, { status });\n",
  },
  {
    id: "W269",
    invariant: "reviewLoop replay: finish_review out of turn is refused without a change",
    path: "src/agent/tools/artifact.ts",
    find: "  if (isJudgeRun(workflow, pointer)) return JUDGE_ENTRY_REFUSAL;\n  if (!taskQuiet(workflow, author)) {\n    return `The author ${author.task_id} is still working. You are told when its turn ends.`;\n  }\n",
    replace: "  if (isJudgeRun(workflow, pointer)) return JUDGE_ENTRY_REFUSAL;\n",
  },
  {
    id: "W270",
    invariant: "reviewLoop::aJudgeRejectionPostsItsReasonOnce (pull request)",
    path: "src/artifact/pull.ts",
    find: "    await host.commentOnPull(ref.repo, ref.number, text);\n",
    replace: "",
  },
  {
    id: "W271",
    invariant: "reviewLoop replay: the store records the send-back of each revision",
    path: "src/workflow/refiner/checks-gate.ts",
    find: "  return workflow.store.markEventSeen(id);\n",
    replace: "  return !workflow.store.eventSeen(id);\n",
  },
  {
    id: "W272",
    invariant: "workflowLifecycle::aFinishedAuthorsSandboxIsDestroyed",
    path: "src/workflow/lifecycle.ts",
    find: '    alarmId: await workflow.scheduleAlarm(TASK_END_ALARM_SECONDS, "resumeTaskEnd", alarm),\n',
    replace: '    alarmId: "",\n',
  },
  {
    id: "W273",
    invariant:
      "workflowLifecycle::eachFailedTaskPostsItsFailureOnce (alarm cancelled before the post)",
    path: "src/workflow/lifecycle.ts",
    find: "  const ended = workflow.store.requireTask(task.task_id).status;\n",
    replace:
      "  await workflow.cancelAlarm(teardown.alarmId);\n  const ended = workflow.store.requireTask(task.task_id).status;\n",
  },
  {
    id: "W274",
    invariant:
      "workflowLifecycle::eachFailedTaskPostsItsFailureOnce (alarm reruns a teardown in flight)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (running) {\n",
    replace: "  if (running && !running) {\n",
  },
  {
    id: "W275",
    invariant: "workflowLifecycle::eachFailedTaskPostsItsFailureOnce (alarm left armed)",
    path: "src/workflow/lifecycle.ts",
    find: "  await workflow.cancelAlarm(teardown.alarmId);\n",
    replace: "",
  },
  {
    id: "W277",
    invariant: "workflowLifecycle::aFinishedAuthorsSandboxIsDestroyed (done task arms no alarm)",
    path: "src/workflow/lifecycle.ts",
    find: "  const teardown = finished\n    ? await armTaskEndAlarm(workflow, task, { task_id: task.task_id })\n    : null;\n  await handOn();\n  if (!teardown) return;\n  await removeSandbox(workflow, task);\n  await closeTeardown(workflow, task, teardown);\n",
    replace: "  await handOn();\n  if (finished) await removeSandbox(workflow, task);\n",
  },
  {
    id: "W278",
    invariant:
      "workflowLifecycle::eachFailedTaskPostsItsFailureOnce (done task alarm runs a failure teardown)",
    path: "src/workflow/lifecycle.ts",
    find: '  if ("reason" in alarm) await finishTeardown(workflow, task, teardown, alarm.reason);\n',
    replace: '  if (alarm) await finishTeardown(workflow, task, teardown, "reason");\n',
  },
  {
    id: "W279",
    invariant:
      "workflowLifecycle::aDoneResearchersJobHasItsAuthor (author queued after the researcher's destroy)",
    path: "src/workflow/lifecycle.ts",
    find: '  await finishTask(workflow, researcher, async () => {\n    workflow.store.completeTodos(researcher.task_id);\n    const job = workflow.store.requireJob(researcher.job_id);\n    const authorId = insertJobTask(workflow, authorTaskOf(workflow.stageFor(job), job));\n    await workflow.scheduleAlarm(0, "provision", { task_id: authorId });\n    await dropBoardFlush(workflow, researcher.task_id);\n    await flushBoards(workflow, researcher.job_id);\n  });\n',
    replace:
      '  await finishTask(workflow, researcher, async () => {});\n  workflow.store.completeTodos(researcher.task_id);\n  const job = workflow.store.requireJob(researcher.job_id);\n  const authorId = insertJobTask(workflow, authorTaskOf(workflow.stageFor(job), job));\n  await workflow.scheduleAlarm(0, "provision", { task_id: authorId });\n  await dropBoardFlush(workflow, researcher.task_id);\n  await flushBoards(workflow, researcher.job_id);\n',
  },
  {
    id: "W248",
    invariant: "workflowLifecycle::aCompletedJobEndsItsReview (task end alarm only destroys)",
    path: "src/workflow/lifecycle.ts",
    find: '  else if ("result" in alarm) await finishCompletion(workflow, task, teardown, alarm.result);\n',
    replace: "",
  },
  {
    id: "W249",
    invariant:
      "workflowLifecycle::aSingleIssueWorkflowIsDoneWithItsSubjectsJob (completion alarm without its result)",
    path: "src/workflow/lifecycle.ts",
    find: "    const alarm = { task_id: author.task_id, result };\n",
    replace: "    const alarm = { task_id: author.task_id };\n",
  },
  {
    id: "W280",
    invariant: "reviewLoop::aDoneRefinerRunRoutesItsReview (reviewer destroyed before routing)",
    path: "src/workflow/refiner/loop.ts",
    find: "  await finishTask(workflow, reviewer, () =>\n    routeReview(workflow, reviewer, { entry, read, revision }),\n  );\n",
    replace:
      "  await finishTask(workflow, reviewer, async () => {});\n  await routeReview(workflow, reviewer, { entry, read, revision });\n",
  },
  {
    id: "W281",
    invariant: "reviewLoop::aDoneRefinerRunRoutesItsReview (polisher destroyed before hand-on)",
    path: "src/workflow/refiner/polish.ts",
    find: "  await finishTask(workflow, polisher, async () => {\n    const author = workflow.store.authorTaskOf(polisher.job_id);\n    await handOnFromPolisher(workflow, { author, polisher, outcome, revision });\n    await drainQueue(workflow, workflow.store.requireTask(author.task_id));\n  });\n",
    replace:
      "  await finishTask(workflow, polisher, async () => {});\n  const author = workflow.store.authorTaskOf(polisher.job_id);\n  await handOnFromPolisher(workflow, { author, polisher, outcome, revision });\n  await drainQueue(workflow, workflow.store.requireTask(author.task_id));\n",
  },
  {
    id: "W214",
    invariant:
      "harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone (empty turn with open todos)",
    path: "src/workflow/task/author-turn.ts",
    find: '    unfinished && !workflow.store.artifact(author.job_id) ? "stopped_early" : "finished";',
    replace: '    "finished";',
  },
  {
    id: "W215",
    invariant:
      "harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone (decisions asked about an empty turn)",
    path: "src/workflow/task/author-turn.ts",
    find: "  const answered = author.summary.trim() ? await askAuthorTurn(workflow, author) : null;",
    replace: "  const answered = await askAuthorTurn(workflow, author);",
  },
  {
    id: "W276",
    invariant:
      "harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone (todo list not stored)",
    path: "src/workflow/task/harness/turn.ts",
    find: "    workflow.store.setTodos(task.task_id, { entries });\n",
    replace: "",
  },
  {
    id: "W240",
    invariant: "workflowLifecycle::oneJobAtATimePerIssueUntilOneCompletes",
    path: "src/agent/tools/start/start.ts",
    find: "  return validateInputNotInWork(workflow, input) ?? validateIssueNotCompleted(workflow, input);\n",
    replace: "  return validateInputNotInWork(workflow, input);\n",
  },
  {
    id: "W241",
    invariant:
      "workflowLifecycle::oneJobAtATimePerIssueUntilOneCompletes, sessionRouting::oneJobAtATimePerIssueUntilOneCompletes",
    path: "src/agent/tools/start/start.ts",
    find: "  return validateInputNotInWork(workflow, input) ?? validateIssueNotCompleted(workflow, input);\n",
    replace: "  return validateIssueNotCompleted(workflow, input);\n",
  },
  {
    id: "W242",
    invariant: "workflowLifecycle::anEndedWorkflowPostsItsEndOnce (resumed end posts again)",
    path: "src/workflow/lifecycle.ts",
    find: "  if (!end.posted) await postWorkflowEnd(workflow, end);\n",
    replace: "  await postWorkflowEnd(workflow, end);\n",
  },
  {
    id: "W243",
    invariant:
      "workflowLifecycle::anEndedWorkflowPostsItsEndOnce (recorded posted before the post)",
    path: "src/workflow/lifecycle.ts",
    find: "  const to = { answering: end.answering };\n  switch (end.ends_as) {\n",
    replace:
      "  const to = { answering: end.answering };\n  workflow.store.markWorkflowEndPosted();\n  switch (end.ends_as) {\n",
  },
  {
    id: "W295",
    invariant:
      "workflowLifecycle::aRestartDoesNotLoseAModelTurn (a failure post holds up the next lost turn)",
    path: "src/workflow/task/model-turn.ts",
    find: "  await Promise.all(turns.map((turn) => resumeLostModelTurn(workflow, turn)));\n",
    replace: "  for (const turn of turns) await resumeLostModelTurn(workflow, turn);\n",
  },
  {
    id: "W340",
    invariant: "workflowLifecycle::eachFailedTaskPostsItsFailureOnce (failed page write)",
    path: "src/workflow/task/model-author.ts",
    find: "  await documents.updatePageContent(ref.page_id, change);\n",
    replace: "  await documents.updatePageContent(ref.page_id, change).catch(() => undefined);\n",
  },
  {
    id: "W341",
    invariant: "reviewLoop::checksGoBackOncePerRevision (failed checks of an ended author)",
    path: "src/workflow/refiner/checks-recheck.ts",
    find: '  if (checks?.state === "failed" && !isTaskFinished(author.status)) {\n',
    replace: '  if (checks?.state === "failed") {\n',
  },
  {
    id: "W342",
    invariant: "reviewLoop::checksGoBackOncePerRevision (conflict of an ended author)",
    path: "src/workflow/refiner/checks-recheck.ts",
    find: "  if (!claimed || !isTaskFinished(author.status)) return;\n",
    replace: "  return;\n",
  },
  {
    id: "W343",
    invariant:
      "reviewLoop::aDoneRefinerRunRoutesItsReview (reviewer reads the revision after its done write)",
    path: "src/workflow/refiner/loop.ts",
    find: "  await finishTask(workflow, reviewer, () =>\n    routeReview(workflow, reviewer, { entry, read, revision }),\n  );\n",
    replace:
      "  await finishTask(workflow, reviewer, async () =>\n    routeReview(workflow, reviewer, {\n      entry,\n      read,\n      revision: (await revisionOfTheJobsArtifact(workflow, reviewer.job_id)) ?? revision,\n    }),\n  );\n",
  },
  {
    id: "W344",
    invariant:
      "reviewLoop::aDoneRefinerRunRoutesItsReview (polisher reads the revision after its done write)",
    path: "src/workflow/refiner/polish.ts",
    find: "    await handOnFromPolisher(workflow, { author, polisher, outcome, revision });\n",
    replace:
      "    const read = await revisionOfTheJobsArtifact(workflow, polisher.job_id);\n    await handOnFromPolisher(workflow, { author, polisher, outcome, revision: read ?? revision });\n",
  },
  {
    id: "W345",
    invariant:
      "reviewLoop::anEndedAuthorEndsItsReview (review ends after its author ended mid-turn)",
    path: "src/workflow/refiner/loop.ts",
    find: "    isTaskFinished(current.status) &&\n    workflow.store.sandbox(current.task_id)?.prompt_in_flight === 1\n",
    replace: "    false\n",
  },
  {
    id: "W346",
    invariant:
      "reviewLoop::theHumansHearOfEachHandoverOnce (no alarm is armed before the handover post)",
    path: "src/workflow/refiner/outcome.ts",
    find: '  const alarm = await workflow.scheduleAlarm(HANDOVER_POST_ALARM_SECONDS, "postHandover", post);\n  await postTheHandover(workflow, artifact, close);\n  await workflow.cancelAlarm(alarm);\n',
    replace: "  await postTheHandover(workflow, artifact, close);\n",
  },
  {
    id: "W347",
    invariant:
      "reviewLoop::theHumansHearOfEachHandoverOnce (the handover alarm stays armed after its post)",
    path: "src/workflow/refiner/outcome.ts",
    find: "  await postTheHandover(workflow, artifact, close);\n  await workflow.cancelAlarm(alarm);\n",
    replace: "  await postTheHandover(workflow, artifact, close);\n",
  },
  {
    id: "W348",
    invariant:
      "reviewLoop::theHumansHearOfEachHandoverOnce (the alarm posts the handover of a draft)",
    path: "src/workflow/refiner/outcome.ts",
    find: '  if (artifact?.status !== "ready") return;\n  workflow.log(null, `the handover of job',
    replace: "  if (!artifact) return;\n  workflow.log(null, `the handover of job",
  },
  {
    id: "W349",
    invariant:
      "reviewLoop::theHumansHearOfEachHandoverOnce (a newer handover keeps the older alarm armed)",
    path: "src/workflow/refiner/outcome.ts",
    find: '  await workflow.cancelAlarmsWhere(\n    "postHandover",\n    (payload) => (payload as HandoverPostAlarm).job_id === jobId,\n  );\n',
    replace: "",
  },
  {
    id: "W351",
    invariant:
      "reviewLoop::theHumansHearOfEachHandoverOnce (the workflow end drops the handover alarm)",
    path: "src/workflow/lifecycle.ts",
    find: "  await writeRouterWorkflowStatus(workflow);\n  if (!end.posted)",
    replace:
      '  await workflow.cancelAlarmsWhere("postHandover", () => true);\n  await writeRouterWorkflowStatus(workflow);\n  if (!end.posted)',
  },
  {
    id: "W352",
    invariant:
      "reviewLoop::theHumansHearOfEachHandoverOnce (the handover alarm posts only while the workflow runs)",
    path: "src/workflow/refiner/outcome.ts",
    find: '  if (artifact?.status !== "ready") return;\n  workflow.log(null, `the handover of job',
    replace:
      '  if (artifact?.status !== "ready" || workflow.store.requireWorkflowRow().status !== "running") return;\n  workflow.log(null, `the handover of job',
  },
  {
    id: "W355",
    invariant:
      "reviewLoop::aRestartDoesNotStrandAReviewerTurnEnd (the start step arms no reviewer turn end)",
    path: "src/workflow/task/harness/turn.ts",
    find: "    if (!sandbox || !refinerTurnEndWaits(workflow, run)) continue;\n",
    replace: "    continue;\n",
  },
  {
    id: "W356",
    invariant:
      "reviewLoop::aRestartDoesNotStrandAReviewerTurnEnd (a reviewer's turn text goes at its turn end)",
    path: "src/workflow/task/harness/turn.ts",
    find: '    turn_text: task.role === "reviewer" ? turnText : "",\n',
    replace: '    turn_text: "",\n',
  },
  {
    id: "W350",
    invariant:
      "reviewLoop::aRestartDoesNotStrandAReviewerTurnEnd (the start step arms no polisher turn end)",
    path: "src/workflow/task/harness/turn.ts",
    find: '  if (run.role !== "reviewer" && run.role !== "polisher") return false;\n',
    replace: '  if (run.role !== "reviewer") return false;\n',
  },
  {
    id: "W357",
    invariant: "reviewLoop::judgeRulesAtMostOnce (the rejection posts before the author's prompt)",
    path: "src/workflow/refiner/loop.ts",
    find: '  await Promise.all([\n    support.postRejection\n      ? support.postRejection(artifact.ref, signedReason)\n      : workflow.post({ type: "info", text: signedReason }),\n    sendRejectionToAuthor(',
    replace:
      '  await (support.postRejection\n    ? support.postRejection(artifact.ref, signedReason)\n    : workflow.post({ type: "info", text: signedReason }));\n  await Promise.all([\n    sendRejectionToAuthor(',
  },
  {
    id: "W290",
    invariant: "slackTextInvariants::slackTextNeverNotifies",
    path: "../adapters/src/chat/slack/mrkdwn.ts",
    find: '      if (heading !== undefined) return `*${toSlackMrkdwn(heading.replaceAll("**", ""))}*`;\n',
    replace: '      if (heading !== undefined) return `*${heading.replaceAll("**", "")}*`;\n',
    propertyFile: "../adapters/src/chat/slack/text.property.ts",
  },
  {
    id: "W291",
    invariant: "slackTextInvariants::slackChunksKeepTheText",
    path: "../adapters/src/chat/slack/chat.ts",
    find: '  const paragraph = text.lastIndexOf("\\n\\n", limit);\n',
    replace: '  const paragraph = text.lastIndexOf("\\n\\n", limit + 1);\n',
    propertyFile: "../adapters/src/chat/slack/text.property.ts",
  },
  {
    id: "W292",
    invariant: "slackTextInvariants::slackChunksKeepTheText (surrogate pair)",
    path: "../adapters/src/chat/slack/chat.ts",
    find: "  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? limit - 1 : limit;\n",
    replace: "  return limit;\n",
    propertyFile: "../adapters/src/chat/slack/text.property.ts",
  },
  {
    id: "W296",
    invariant: "slackTextInvariants::slackChunksKeepTheText (whitespace one past the limit)",
    path: "../adapters/src/chat/slack/chat.ts",
    find: "  const whitespace = text.slice(0, limit + 1).search(LAST_WHITESPACE);\n",
    replace: "  const whitespace = text.slice(0, limit + 2).search(LAST_WHITESPACE);\n",
    propertyFile: "../adapters/src/chat/slack/text.property.ts",
  },
  {
    id: "W297",
    invariant: "slackTextInvariants::slackChunksKeepTheText (period at the limit)",
    path: "../adapters/src/chat/slack/chat.ts",
    find: '  const period = text.lastIndexOf(".", limit - 1);\n',
    replace: '  const period = text.lastIndexOf(".", limit);\n',
    propertyFile: "../adapters/src/chat/slack/text.property.ts",
  },
  {
    id: "W293",
    invariant: "slackTextInvariants::slackMrkdwnIsStable",
    path: "../adapters/src/chat/slack/mrkdwn.ts",
    find: "  let previous: string;\n  do {\n    previous = mrkdwn;\n    mrkdwn = markdownToMrkdwnOnce(previous);\n  } while (mrkdwn !== previous);\n  return mrkdwn;\n",
    replace: "  return markdownToMrkdwnOnce(mrkdwn);\n",
    propertyFile: "../adapters/src/chat/slack/text.property.ts",
  },
  {
    id: "W294",
    invariant: "inboundInvariants::inboundMapperNeverThrows",
    path: "../adapters/src/chat/slack/inbound.ts",
    find: "  const parsed = slackEventCallbackSchema.safeParse(payload);\n  if (!parsed.success) return UNHANDLED_EVENT;\n  const callback = parsed.data;\n",
    replace: "  const callback = slackEventCallbackSchema.parse(payload);\n",
    propertyFile: "../adapters/src/chat/slack/inbound.property.ts",
  },
  {
    id: "W300",
    invariant: "githubCodeInvariants::githubFailedCheckWinsInAnyOrder (running before stopped)",
    path: "../adapters/src/code/github/commit-checks.ts",
    find: '  const stopped = failuresOf(reported, "stopped");\n  if (stopped.length) return { state: "stopped", failures: stopped };\n  if (reported.some((check) => check.standing === "running")) return { state: "running" };\n',
    replace:
      '  if (reported.some((check) => check.standing === "running")) return { state: "running" };\n  const stopped = failuresOf(reported, "stopped");\n  if (stopped.length) return { state: "stopped", failures: stopped };\n',
    propertyFile: "../adapters/src/code/github/code.property.ts",
  },
  {
    id: "W301",
    invariant:
      "githubCodeInvariants::githubFailedCheckWinsInAnyOrder (error status reads as failed)",
    path: "../adapters/src/code/github/commit-checks.ts",
    find: '    standing: status.state === "failure" ? "failed" : "stopped",\n',
    replace: '    standing: "failed",\n',
    propertyFile: "../adapters/src/code/github/code.property.ts",
  },
  {
    id: "W302",
    invariant: "githubCodeInvariants::githubPullLinkNamesOnlyAGithubPull (unanchored reader)",
    path: "../adapters/src/code/github/url.ts",
    find: "const GITHUB_PULL = /^https:\\/\\/github\\.com\\/([\\w.-]+\\/[\\w.-]+)\\/pull\\/(\\d+)(?:[/?#]|$)/;\n",
    replace: "const GITHUB_PULL = /github\\.com\\/([\\w.-]+\\/[\\w.-]+)\\/pull\\/(\\d+)/;\n",
    propertyFile: "../adapters/src/code/github/code.property.ts",
  },
  {
    id: "W303",
    invariant: "githubCodeInvariants::githubPullLinkNamesOnlyAGithubPull (inexact number)",
    path: "../adapters/src/code/github/url.ts",
    find: "  if (!Number.isSafeInteger(number)) return null;\n",
    replace: "",
    propertyFile: "../adapters/src/code/github/code.property.ts",
  },
  {
    id: "W304",
    invariant: "githubCodeInvariants::githubFailedCheckWinsInAnyOrder (run detail not clipped)",
    path: "../adapters/src/code/github/commit-checks.ts",
    find: "      detail: detail.slice(0, DETAIL_CHARS),\n",
    replace: "      detail,\n",
    propertyFile: "../adapters/src/code/github/code.property.ts",
  },
  {
    id: "W325",
    invariant: "githubCodeInvariants::githubPullLinkRoundTrips",
    path: "../adapters/src/code/github/url.ts",
    find: "\\/pull\\/(\\d+)(?:[/?#]|$)/;\n",
    replace: "\\/pull\\/(\\d+)(?:[/?]|$)/;\n",
    propertyFile: "../adapters/src/code/github/code.property.ts",
  },
  {
    id: "W310",
    invariant: "documentsInvariants::notionPageLinkNamesItsPage",
    path: "../adapters/src/documents/notion/page-id.ts",
    find: "const PAGE_ID = /([0-9a-f]{32})(?:[?#/]|$)/;\n",
    replace: "const PAGE_ID = /([0-9a-f]{32})/;\n",
    propertyFile: "../adapters/src/documents/notion/text.property.ts",
  },
  {
    id: "W311",
    invariant: "documentsInvariants::notionRichTextJoinsBack (cut past the limit)",
    path: "../adapters/src/documents/notion/rich-text.ts",
    find: "    const end = richTextItemEnd(text, start + NOTION_RICH_TEXT_CHARS);\n",
    replace: "    const end = richTextItemEnd(text, start + NOTION_RICH_TEXT_CHARS + 1);\n",
    propertyFile: "../adapters/src/documents/notion/text.property.ts",
  },
  {
    id: "W312",
    invariant: "documentsInvariants::notionRichTextJoinsBack (surrogate pair)",
    path: "../adapters/src/documents/notion/rich-text.ts",
    find: "  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? limit - 1 : limit;\n",
    replace: "  return limit;\n",
    propertyFile: "../adapters/src/documents/notion/text.property.ts",
  },
  {
    id: "W313",
    invariant:
      "documentsInvariants::linearWriteKeepsTheConcurrentEdit (edits applied to the text read)",
    path: "../adapters/src/documents/linear/documents.ts",
    find: "  return applyPageTextEdits(current, update.edits);\n",
    replace: "  return applyPageTextEdits(change.before, update.edits);\n",
    propertyFile: "../adapters/src/documents/linear/write.property.ts",
  },
  {
    id: "W314",
    invariant:
      "documentsInvariants::linearWriteKeepsTheConcurrentEdit (whole text over the current content)",
    path: "../adapters/src/documents/linear/documents.ts",
    find: "    return { text: current.trim() ? `${update.whole}\\n${current}` : update.whole };\n",
    replace: "    return { text: update.whole };\n",
    propertyFile: "../adapters/src/documents/linear/write.property.ts",
  },
  {
    id: "W305",
    invariant: "webhookInvariants::genuineWebhookDelivers (data by character code)",
    path: "../adapters/src/hmac.ts",
    find: '  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));\n',
    replace:
      '  const signature = await crypto.subtle.sign(\n    "HMAC",\n    key,\n    Uint8Array.from(data, (char) => char.charCodeAt(0)),\n  );\n',
    propertyFile: "../ingress/src/routes/webhook.property.ts",
  },
  {
    id: "W306",
    invariant: "webhookInvariants::genuineWebhookDelivers (secret by character code)",
    path: "../adapters/src/hmac.ts",
    find: "    encoder.encode(secret),\n",
    replace: "    Uint8Array.from(secret, (char) => char.charCodeAt(0)),\n",
    propertyFile: "../ingress/src/routes/webhook.property.ts",
  },
  {
    id: "W307",
    invariant: "webhookInvariants::genuineWebhookDelivers (Linear body as Latin-1)",
    path: "../adapters/src/tracker/linear/webhook.ts",
    find: "new LinearWebhookClient(secret).verify(Buffer.from(body), signature)",
    replace: 'new LinearWebhookClient(secret).verify(Buffer.from(body, "latin1"), signature)',
    propertyFile: "../ingress/src/routes/webhook.property.ts",
  },
  {
    id: "W308",
    invariant: "webhookInvariants::genuineWebhookDelivers (GitHub verifies the parsed body)",
    path: "../ingress/src/routes/github.ts",
    find: "  if (!(await verifyGithubWebhook(secret, body, ctx.req.raw.headers)))\n",
    replace:
      "  if (!(await verifyGithubWebhook(secret, JSON.stringify(JSON.parse(body)), ctx.req.raw.headers)))\n",
    propertyFile: "../ingress/src/routes/webhook.property.ts",
  },
  {
    id: "W309",
    invariant: "webhookInvariants::badSignatureNeverDelivers",
    path: "../adapters/src/chat/slack/webhook.ts",
    find: "  return Math.abs(nowMs / 1000 - Number(timestamp)) <= REPLAY_WINDOW_SECONDS;\n",
    replace:
      "  return Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) <= REPLAY_WINDOW_SECONDS;\n",
    propertyFile: "../ingress/src/routes/webhook.property.ts",
  },
  {
    id: "W315",
    invariant:
      "bridgeLineInvariants::bridgeKeepsEveryHarnessLineWhole (chunk decoded without streaming)",
    path: "../bridge/src/line-reader.ts",
    find: "    for (const line of splitter.push(decoder.decode(value, { stream: true }))) onLine(line);\n",
    replace: "    for (const line of splitter.push(decoder.decode(value))) onLine(line);\n",
    propertyFile: "../bridge/src/line-reader.property.ts",
  },
  {
    id: "W316",
    invariant:
      "bridgeLineInvariants::bridgeKeepsEveryHarnessLineWhole (lone carriage return ends a line)",
    path: "../bridge/src/line-reader.ts",
    find: "    this.buffer += chunk;\n",
    replace: '    this.buffer += chunk.replaceAll("\\r", "\\n");\n',
    propertyFile: "../bridge/src/line-reader.property.ts",
  },
  {
    id: "W317",
    invariant:
      "bridgeLineInvariants::bridgeKeepsEveryHarnessLineWhole (unended last line not trimmed)",
    path: "../bridge/src/line-reader.ts",
    find: "    const tail = this.buffer.trim();\n",
    replace: "    const tail = this.buffer;\n",
    propertyFile: "../bridge/src/line-reader.property.ts",
  },
  {
    id: "W318",
    invariant: "bridgeLineInvariants::bridgeKeepsEveryHarnessLineWhole (bytes decoded as Latin-1)",
    path: "../bridge/src/line-reader.ts",
    find: "  const decoder = new TextDecoder();\n",
    replace: '  const decoder = new TextDecoder("latin1");\n',
    propertyFile: "../bridge/src/line-reader.property.ts",
  },
  {
    id: "W319",
    invariant: "bridgeLineInvariants::bridgeKeepsEveryHarnessLineWhole (fresh decoder per chunk)",
    path: "../bridge/src/line-reader.ts",
    find: "    for (const line of splitter.push(decoder.decode(value, { stream: true }))) onLine(line);\n",
    replace:
      "    for (const line of splitter.push(new TextDecoder().decode(value, { stream: true }))) onLine(line);\n",
    propertyFile: "../bridge/src/line-reader.property.ts",
  },
  {
    id: "W335",
    invariant: "orchestratorTextInvariants::verbalCommandOnlyFromAnExactWord (words before it)",
    path: "src/workflow/inbound/verbal-command.ts",
    find: "const BARE_VERB = /^(cancel|",
    replace: "const BARE_VERB = /(cancel|",
    propertyFile: "src/workflow/inbound/verbal-command.property.ts",
  },
  {
    id: "W336",
    invariant: "orchestratorTextInvariants::verbalCommandOnlyFromAnExactWord (text after it)",
    path: "src/workflow/inbound/verbal-command.ts",
    find: "\\s*[.!?]*$/i;\n",
    replace: "\\s*[.!?]*/i;\n",
    propertyFile: "src/workflow/inbound/verbal-command.property.ts",
  },
  {
    id: "W337",
    invariant:
      "orchestratorTextInvariants::verbalCommandOnlyFromAnExactWord (longer instruct word)",
    path: "src/workflow/inbound/verbal-command.ts",
    find: "const INSTRUCT = /^instruct\\b[:\\s]*/i;\n",
    replace: "const INSTRUCT = /^instruct[:\\s]*/i;\n",
    propertyFile: "src/workflow/inbound/verbal-command.property.ts",
  },
  {
    id: "W338",
    invariant: "orchestratorTextInvariants::screenPartsHoldEverySpanWhole",
    path: "src/decisions/screen.ts",
    find: "const PART_OVERLAP_CHARS = 1_000;\n",
    replace: "const PART_OVERLAP_CHARS = 500;\n",
    propertyFile: "src/decisions/screen.property.ts",
  },
  {
    id: "W339",
    invariant: "orchestratorTextInvariants::taskDigestStaysWithinItsCap",
    path: "src/workflow/task/harness/digest.ts",
    find: '  return clipHead(headLines(input).join("\\n"), DIGEST_MAX_CHARS - tail.length - newlineBeforeTail);\n',
    replace: '  return headLines(input).join("\\n");\n',
    propertyFile: "src/workflow/task/harness/digest.property.ts",
  },
  {
    id: "W380",
    invariant: "sessionFeedInvariants::aToolCallNeverPosts (a completed tool call posts its title)",
    path: "src/workflow/feed/feed.ts",
    find: '    case "tool_call": {\n      const line = feed.message.trim();\n',
    replace:
      '    case "tool_call": {\n      await workflow.notifier.feed(feedSessionOf(workflow, task)!, {\n        task_id: task.task_id,\n        id: crypto.randomUUID(),\n        content: { type: "action", action: "Used", parameter: update.title },\n      });\n      const line = feed.message.trim();\n',
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W381",
    invariant: "sessionFeedInvariants::narrationPostsAtMostOncePerInterval",
    path: "src/workflow/feed/feed.ts",
    find: "  return sinceLastPost >= NARRATION_INTERVAL_MS && !(await requestQuotaLow(workflow));\n",
    replace: "  return !(await requestQuotaLow(workflow));\n",
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W382",
    invariant:
      "sessionFeedInvariants::everyNarrationLinePostsInOrder (a new line overwrites the waiting ones)",
    path: "src/workflow/store/tasks.ts",
    find: "    const narration = waiting ? `${waiting}${NARRATION_LINE_SEPARATOR}${line}` : line;\n",
    replace: "    const narration = waiting ? line : line;\n",
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W383",
    invariant: "sessionFeedInvariants::theReplyNeverPostsAsNarration",
    path: "src/workflow/feed/feed.ts",
    find: '  const account = closing?.kind === "narrated_account" ? message.trim() : "";\n',
    replace: "  const account = message.trim();\n",
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W384",
    invariant: "sessionFeedInvariants::aQuietTurnGetsAHeartbeat",
    path: "src/workflow/feed/feed.ts",
    find: "  if (workflow.now() - Date.parse(feed.active_at) < HEARTBEAT_AFTER_MS) return;\n",
    replace: "  if (workflow.now() - Date.parse(feed.active_at) <= HEARTBEAT_AFTER_MS) return;\n",
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W385",
    invariant:
      "sessionFeedInvariants::heartbeatsAreTheOnlyPostsTheQuotaSkips (the closing waits on the quota)",
    path: "src/workflow/feed/feed.ts",
    find: '  if (!session || !closing || closing.kind === "narrated_account") return;\n',
    replace:
      '  if (!session || !closing || closing.kind === "narrated_account" || (await requestQuotaLow(workflow))) return;\n',
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W386",
    invariant: "sessionFeedInvariants::everyInstructionGetsAReceipt",
    path: "src/workflow/inbound/events.ts",
    find: "    if (instructed) await postReceipt(workflow, instructed);\n",
    replace: "",
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W387",
    invariant: "sessionRouting::sessionPlanSetsOnlyWhenATurnEnds",
    path: "src/workflow/task/harness/turn.ts",
    find: "    await markBoardDirty(workflow, task.job_id);\n  }\n  countToolActivity",
    replace:
      "    await markBoardDirty(workflow, task.job_id);\n    await publishSessionPlan(workflow, task);\n  }\n  countToolActivity",
  },
  {
    id: "W388",
    invariant:
      "sessionFeedInvariants::everyNarrationLinePostsInOrder (recorded before its post lands)",
    path: "src/workflow/feed/feed.ts",
    find: "  const posted = await workflow.notifier.feed(session, {\n",
    replace:
      "  workflow.store.recordNarrationPost(task.task_id, waiting.narration, isoNow(workflow));\n  const posted = await workflow.notifier.feed(session, {\n",
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W389",
    invariant:
      "sessionFeedInvariants::heartbeatsAndNarrationWaitWhileTheQuotaIsLow (a heartbeat ignores the quota)",
    path: "src/workflow/feed/feed.ts",
    find: "  if (await requestQuotaLow(workflow)) {\n",
    replace: "  if (false && (await requestQuotaLow(workflow))) {\n",
    propertyFile: "src/workflow/feed/feed.property.ts",
  },
  {
    id: "W390",
    invariant:
      "harnessSession::aPersonPromptDoesNotWaitForTheTurnToEnd (a running turn gets no steer)",
    path: "src/workflow/task/harness/prompt-queue.ts",
    find: "    steerWaitingInstructions(workflow, task);\n    return false;\n",
    replace: "    return false;\n",
  },
  {
    id: "W391",
    invariant:
      "harnessSession::aPersonPromptDoesNotWaitForTheTurnToEnd (a new turn does not steer the instructions that wait)",
    path: "src/workflow/task/harness/prompt-queue.ts",
    find: "  steerWaitingInstructions(workflow, task);\n  await armNoProgress",
    replace: "  await armNoProgress",
  },
  {
    id: "W392",
    invariant:
      "harnessSession::aHarnessSessionReceivesEachPersonPromptOnce (a turn that ends keeps its taken instructions)",
    path: "src/workflow/task/harness/turn.ts",
    find: "  else workflow.store.dropTakenPrompts(task.task_id);\n",
    replace: "  else workflow.store.returnSteeredPrompts(task.task_id);\n",
  },
  {
    id: "W393",
    invariant:
      "harnessSession::aPersonPromptIsNeverDropped (a steer the turn did not take drops its instruction)",
    path: "src/workflow/task/harness/steer.ts",
    find: "  workflow.log(task.task_id, `the turn did not take steer ${rpcId}. it goes as the next prompt.`);\n",
    replace:
      "  for (const steer of workflow.store.steers()) {\n    if (steer.rpc_id === rpcId) workflow.store.dequeuePrompt(steer.prompt_id);\n  }\n",
  },
  {
    id: "W394",
    invariant:
      "harnessSession::aPersonPromptIsNeverDropped (a cancelled turn drops its taken instructions)",
    path: "src/workflow/task/harness/turn.ts",
    find: '  if (stopReason === "cancelled") workflow.store.returnSteeredPrompts(task.task_id);\n',
    replace: '  if (stopReason === "cancelled") workflow.store.dropTakenPrompts(task.task_id);\n',
  },
  {
    id: "W405",
    invariant: "workflowLifecycle::aPersonsMessageWakesTheWorkflow (a message during an end)",
    path: "src/workflow/inbound/events.ts",
    find: "  if (!isWorkflowFinished(workflow.store.workflowStatus())) {\n    if (isMessage(event)) await wakeWorkflow(workflow);\n",
    replace:
      '  if (isMessage(event) && workflow.store.requireWorkflowRow().status === "ending")\n    await changeWorkflowStatus(workflow, "running");\n  if (!isWorkflowFinished(workflow.store.workflowStatus())) {\n    if (isMessage(event)) await wakeWorkflow(workflow);\n',
  },
  {
    id: "W395",
    invariant: "sessionRouting::aTurnEndNeverDropsItsAccount",
    path: "src/workflow/task/harness/turn.ts",
    find: "  await closeSessionFeed(workflow, task, busy ? closingWhenTheAuthorGoesOn(closing) : closing);\n",
    replace: "  await closeSessionFeed(workflow, task, busy ? null : closing);\n",
  },
  {
    id: "W360",
    invariant: "cliSecretInvariants::cliNeverShowsASecret (parse error of the conversion body)",
    path: "../cli/src/connect/code/github/exchange.ts",
    find: '  const text = await response.text();\n  try {\n    return JSON.parse(text);\n  } catch {\n    throw new Error("GitHub answered the manifest code with a body that is not JSON.");\n  }\n',
    replace: "  return response.json();\n",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W361",
    invariant: "cliSecretInvariants::cliNeverShowsASecret (documents credential detail)",
    path: "../cli/src/check/documents-credential.ts",
    find: '    return { outcome: "passed", detail: `${secret} is set` };\n',
    replace:
      '    return { outcome: "passed", detail: `${secret} is set to ${readDevVar(devVars, secret)}` };\n',
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W362",
    invariant: "cliSecretInvariants::cliWritesASecretOnlyToItsOwnDevVars (wider file kept)",
    path: "../cli/src/dev-vars.ts",
    find: "  if (existsSync(path)) chmodSync(path, OWNER_ONLY);\n",
    replace: "",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W363",
    invariant: "cliSecretInvariants::cliWritesASecretOnlyToItsOwnDevVars (new file mode)",
    path: "../cli/src/dev-vars.ts",
    find: "  writeFileSync(path, setDevVars(base, values), { mode: OWNER_ONLY });\n",
    replace: "  writeFileSync(path, setDevVars(base, values));\n",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W364",
    invariant: "cliSecretInvariants::cliWritesASecretOnlyToItsOwnDevVars (another Worker's file)",
    path: "../cli/src/connect/code/github/connect.ts",
    find: "      writeDevVarsFile(paths.ingressDir, { GITHUB_WEBHOOK_SECRET: credentials.webhookSecret });\n",
    replace:
      "      writeDevVarsFile(paths.orchestratorDir, { GITHUB_WEBHOOK_SECRET: credentials.webhookSecret });\n",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W365",
    invariant: "cliSecretInvariants::cliSendsNoSecret",
    path: "../cli/src/connect/code/github/connect.ts",
    find: "      writeIngressAppLogin(paths.ingressConfig, credentials.slug);\n",
    replace:
      '      await fetch("https://api.github.com/app", { headers: { authorization: `Bearer ${credentials.privateKey}` } });\n      writeIngressAppLogin(paths.ingressConfig, credentials.slug);\n',
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W366",
    invariant: "cliSecretInvariants::loopbackServerAnswersOnlyItsOwnFlow (every interface)",
    path: "../cli/src/connect/code/github/connect.ts",
    find: '    server.listen(0, "127.0.0.1", () => {\n',
    replace: "    server.listen(0, () => {\n",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W367",
    invariant: "cliSecretInvariants::loopbackServerAnswersOnlyItsOwnFlow (another Host header)",
    path: "../cli/src/connect/code/github/connect.ts",
    find: "    if (request.headers.host !== url.host) {\n",
    replace: "    if (request.headers.host === undefined) {\n",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W368",
    invariant: "cliSecretInvariants::loopbackServerAnswersOnlyItsOwnFlow (any state)",
    path: "../cli/src/connect/code/github/callback.ts",
    find: "  if (awaitedStates.get(path) !== state) return false;\n",
    replace: "  if (!awaitedStates.has(path)) return false;\n",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W369",
    invariant: "cliSecretInvariants::gitIgnoresEveryDevVars",
    path: "../cli/src/init/packaged-template.ts",
    find: '    to: join(repoDir, entry === PACKAGED_GITIGNORE ? ".gitignore" : entry),\n',
    replace: "    to: join(repoDir, entry),\n",
    propertyFile: "../cli/src/secrets.property.ts",
  },
  {
    id: "W370",
    invariant:
      "orchestratorSecretInvariants::secretsReachOnlyTheirDestinations (an MCP server reads a Worker secret)",
    path: "src/config/mcp-servers.ts",
    find: "    if (workerSecrets.length) {\n",
    replace: "    if (workerSecrets.length && !workerSecrets.length) {\n",
    propertyFile: "src/workflow/secrets.property.ts",
  },
  {
    id: "W371",
    invariant:
      "orchestratorSecretInvariants::secretsReachOnlyTheirDestinations (the debug dump shows the bridge token)",
    path: "src/workflow/status.ts",
    find: 'bridge_token: "***" }',
    replace: "bridge_token: sandbox.bridge_token }",
    propertyFile: "src/workflow/secrets.property.ts",
  },
  {
    id: "W372",
    invariant:
      "orchestratorSecretInvariants::secretsReachOnlyTheirDestinations (a failed refresh logs the repo token)",
    path: "src/workflow/task/sandbox/credential.ts",
    find: "`credential refresh failed: ${String(error).slice(0, 200)}`",
    replace:
      "`credential refresh failed: ${String(error).slice(0, 200)} ${tokens.workflowRepoToken}`",
    propertyFile: "src/workflow/secrets.property.ts",
  },
  {
    id: "W373",
    invariant:
      "orchestratorSecretInvariants::secretsReachOnlyTheirDestinations (the documents CLI gets the chat token)",
    path: "src/clients.ts",
    find: "      return env.NOTION_TOKEN || null;\n",
    replace: "      return env.NOTION_TOKEN || env.SLACK_BOT_TOKEN || null;\n",
    propertyFile: "src/workflow/secrets.property.ts",
  },
  {
    id: "W374",
    invariant:
      "orchestratorSecretInvariants::secretsReachOnlyTheirDestinations (a failed start names the bridge token)",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: '      loggedFailureReason(fresh.task_id, "The sandbox start"),\n',
    replace: "      loggedFailureReason(fresh.task_id, `The sandbox start ${built.spec.token}`),\n",
    propertyFile: "src/workflow/secrets.property.ts",
  },
  {
    id: "W379",
    invariant:
      "orchestratorSecretInvariants::secretsReachOnlyTheirDestinations (a sandbox start logs the private key)",
    path: "src/workflow/task/sandbox/sandbox.ts",
    find: "`sandbox started gen=${sandbox.generation} resume=${resume}`",
    replace:
      "`sandbox started gen=${sandbox.generation} resume=${resume} ${workflow.env.GITHUB_PRIVATE_KEY}`",
    propertyFile: "src/workflow/secrets.property.ts",
  },
  {
    id: "W375",
    invariant:
      "ingressSecretInvariants::ingressSecretsReachNoOutput (a bad signature echoes the secret)",
    path: "../ingress/src/routes/github.ts",
    find: '    return ctx.text("bad signature", 401);\n',
    replace: "    return ctx.text(`bad signature, expected one made with ${secret}`, 401);\n",
    propertyFile: "../ingress/src/routes/secrets.property.ts",
  },
  {
    id: "W376",
    invariant:
      "ingressSecretInvariants::ingressSecretsReachNoOutput (a refused handshake logs the token)",
    path: "../ingress/src/routes/notion.ts",
    find: '    console.error("notion handshake refused. NOTION_VERIFICATION_TOKEN is already set.");\n',
    replace:
      "    console.error(`notion handshake refused. NOTION_VERIFICATION_TOKEN is already ${secret}.`);\n",
    propertyFile: "../ingress/src/routes/secrets.property.ts",
  },
  {
    id: "W377",
    invariant:
      "ingressSecretInvariants::ingressSecretsReachNoOutput (a failed callback logs the bot token)",
    path: "../ingress/src/routes/slack.ts",
    find: "    console.error(`slack ${callback.event_id}: ${String(error)}`);\n",
    replace:
      "    console.error(`slack ${callback.event_id}: ${String(error)} ${ctx.env.SLACK_BOT_TOKEN}`);\n",
    propertyFile: "../ingress/src/routes/secrets.property.ts",
  },
  {
    id: "W378",
    invariant:
      "ingressSecretInvariants::ingressSecretsReachNoOutput (an admin refusal echoes the token)",
    path: "../ingress/src/routes/admin.ts",
    find: 'return ctx.text("unauthorized", 401);',
    replace: "return ctx.text(`unauthorized, use ${ADMIN_TOKEN}`, 401);",
    propertyFile: "../ingress/src/routes/secrets.property.ts",
  },
  {
    id: "W410",
    invariant:
      "agentTurns::compactionReplacesOnlyEarlierRows (a resumed turn forgets the lost turn's first row)",
    path: "src/agent/turn/watchdog.ts",
    find: "    firstRow: lost?.first_row ?? takenRow,\n",
    replace: "    firstRow: takenRow,\n",
  },
  {
    id: "W411",
    invariant:
      "agentTurns::closingTextAnswersOnlyAPersonWhoWrote (a restart drops the lost turn record)",
    path: "src/agent/turn/watchdog.ts",
    find: "  workflow.store.markTurnLost();\n",
    replace: "  workflow.store.deleteAgentTurn();\n",
  },
  {
    id: "W412",
    invariant:
      "agentTurns::closingTextAnswersOnlyAPersonWhoWrote (the record misses the board change)",
    path: "src/agent/turn/turn.ts",
    find: "          progress.boardChanged = true;\n          workflow.store.markTurnBoardChanged();\n",
    replace: "          progress.boardChanged = true;\n",
  },
  {
    id: "W413",
    invariant:
      "agentTurns::closingTextAnswersOnlyAPersonWhoWrote (the turn forgets its board change)",
    path: "src/agent/turn/turn.ts",
    find: "          progress.boardChanged = true;\n          workflow.store.markTurnBoardChanged();\n",
    replace: "          workflow.store.markTurnBoardChanged();\n",
  },
  {
    id: "W425",
    invariant: "inboundInvariants::actorEmailIsLowercase (Slack)",
    path: "../adapters/src/chat/slack/inbound.ts",
    find: "  return context.resolveActor({ ...user, email: user.email?.toLowerCase() ?? null });\n",
    replace: "  return context.resolveActor(user);\n",
    propertyFile: "../adapters/src/chat/slack/inbound.property.ts",
  },
  {
    id: "W426",
    invariant: "inboundInvariants::actorEmailIsLowercase (Linear)",
    path: "../adapters/src/tracker/linear/inbound-payloads.ts",
    find: "  email: z.string().toLowerCase().nullish(),\n",
    replace: "  email: z.string().nullish(),\n",
    propertyFile: "../adapters/src/tracker/linear/inbound.property.ts",
  },
  {
    id: "W427",
    invariant: "inboundInvariants::actorEmailIsLowercase (Notion)",
    path: "../adapters/src/documents/notion/inbound.ts",
    find: "  return context.resolveActor({ id: author.id, email: email?.toLowerCase() ?? null });\n",
    replace: "  return context.resolveActor({ id: author.id, email });\n",
    propertyFile: "../adapters/src/documents/notion/inbound.property.ts",
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
    `The nightly mutant run on seed ${seed} found mutants their property files did not kill.`,
    ["| Mutant | Invariant | File | Result |", "| --- | --- | --- | --- |", ...rows].join("\n"),
    "A surviving mutant shows a rule the generators do not reach. Update a mutant that no longer applies in `packages/orchestrator/scripts/properties/mutants.ts`.",
    "",
  ].join("\n\n");
}

function mutantPropertyFile(path: string) {
  const file = standalonePropertyFile(path);
  if (!file) throw new Error(`A mutant names ${path}, which is not a standalone property file.`);
  return file;
}

async function killedByItsPropertyFiles(mutant: Mutant, seed: number): Promise<boolean> {
  const files = mutant.propertyFile
    ? [mutantPropertyFile(mutant.propertyFile)]
    : Object.values(SPEC_REPLAY_FILES);
  for (const file of files) {
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
    return {
      mutant,
      status: (await killedByItsPropertyFiles(mutant, seed)) ? "killed" : "survived",
    };
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
