# Behavior map

This file lists each effect a person sees or the system relies on, and the invariants that guard it. A scheduled audit compares the code against it.

Effects use the terms of the glossary. A guard is the exact function name of an invariant. A guard written `module::name` is an invariant of that Quint spec module. A guard written `world::name` is a check the workflow world in `packages/orchestrator/test/workflow-world.ts` makes on every step, so every property test and replay that drives the world makes it. A guard written `tests::path` names the example tests in that test file. A row with an empty guard list is unguarded.

The router binding invariants live in the Quint spec at `spec/router-bindings/routerBindings.qnt`. The review loop invariants live in the Quint spec at `spec/review-loop/reviewLoop.qnt`, the workflow lifecycle invariants in `spec/workflow-lifecycle/workflowLifecycle.qnt`, the harness session invariants in `spec/harness-session/harnessSession.qnt`, the agent turns invariants in `spec/agent-turns/agentTurns.qnt`, the chat acknowledgement invariants in `spec/chat-acknowledgement/chatAcknowledgement.qnt`, the session routing invariants in `spec/session-routing/sessionRouting.qnt`, and the feedback routing invariants in `spec/feedback-routing/feedbackRouting.qnt`. A guard written `webhookInvariants::name` is a webhook invariant in `packages/ingress/test/webhook-invariants.ts`, and one written `inboundInvariants::name` is an inbound mapper invariant in `packages/adapters/test/inbound-invariants.ts`.

## Workflow, tasks and statuses

| ID | Effect | Guarded by |
|---|---|---|
| T1 | A job and its task start only into a free job slot, and only after the plan started the workflow. A job start leaves at most the plan's number of job slots of jobs active. | `workflowLifecycle::jobStartsOnlyIntoAFreeSlot`, `workflowLifecycle::workflowStartsOnlyFromAPlan` |
| T2 | Only one live job works from one input artifact in a workflow. An unfinished job holds its input. A finished job holds it while its output exists, unless that output is the input itself. | `workflowLifecycle::oneLiveJobPerInputArtifact` |
| T3 | A job start on an issue points the issue's binding at its workflow before it writes the job. A job start writes the job and its task before the router's status and branch binding writes. A job start arms its task's provision alarm right after it writes the task, so a failed router write does not stop the task from starting. The provision alarm writes the branch binding again before it starts the task. A failed binding write there counts a restart and arms the provision alarm again, and the task fails once its restarts are used up. | `workflowLifecycle::aJobStartProvisionsItsTask` |
| T4 | A sandbox start moves the task to `provisioning` with a new generation and bridge token, and clears the session state. A stop also begins a new generation, without a start. | `harnessSession::aSandboxStartBeginsAFreshGeneration` |
| T5 | A provisioning task moves to `working` only on its first bridge hello, or when a stop ends the turn it was starting. | `harnessSession::aStartingTaskWorksOnlyAfterItsHello` |
| T6 | A model-call author is `working` only while its model turn is in flight, also a lost one it holds until its run-again alarm, or after a stop ended its first turn before the page existed. | `workflowLifecycle::aModelCallAuthorWorksOnlyWhileItsCallIsOut` |
| T7 | An author moves to `in_review` only when its job has an artifact. An author in review does not run a turn or a handshake. A restarted model-call author in review holds the new turn id of its lost model turn only while the alarm that runs that turn again is armed. It leaves `in_review` only for a prompt. | `workflowLifecycle::inReviewTaskHasAnArtifact`, `workflowLifecycle::aTurnThatWaitsToRunAgainHasItsAlarm`, `harnessSession::inReviewTaskHasAnArtifact`, `harnessSession::anAuthorInReviewWorksOnlyWithAPrompt`, `harnessSession::anAuthorInReviewRunsNoTurn` |
| T8 | A finished task (`done`, `failed`, `cancelled`) never changes status again. A restart or a completion that finds the task finished when it reads it again leaves it finished. A stop writes its stopped state before it awaits the destroy, so a destroy that returns late writes nothing. | `workflowLifecycle::finishedTaskKeepsItsStatus`, `harnessSession::finishedTaskKeepsItsStatus`, `reviewLoop::aFinishedRefinerRunKeepsItsStatus` |
| T9 | A failed author closes its review, and its drafted artifact is handed over blocked. A failed findings reviewer, judge or polisher hands the drafted artifact over blocked. A review read that fails hands over blocked. | `reviewLoop::anEndedAuthorEndsItsReview`, `reviewLoop::aStoppedRefinerRunHandsOverBlocked` |
| T10 | A cancelled author or researcher stays cancelled, and a workflow that ended leaves every task finished. A cancelled author closes its review, and its drafted artifact is handed over blocked. | `workflowLifecycle::finishedTaskKeepsItsStatus`, `harnessSession::finishedTaskKeepsItsStatus`, `workflowLifecycle::endedWorkflowHasNoUnfinishedTask`, `reviewLoop::anEndedAuthorEndsItsReview` |
| T11 | Each usage update replaces a harness task's cost. A restart can lower the reported cost. | `tests::packages/orchestrator/src/workflow/task/harness/turn.test.ts` |
| T12 | The workflow is not `running` or `waiting_input` until a plan starts it. | `workflowLifecycle::workflowStartsOnlyFromAPlan` |
| T13 | The workflow moves to `waiting_input` on the sleep message or on `ask`, only while every author and researcher is idle. | `workflowLifecycle::workflowWaitsOnlyWhileNoAuthorWorks` |
| T14 | A workflow that is `done`, `failed` or `cancelled` keeps that status and every task finished, and an event does not reopen it. While the workflow ends, `set_plan`, `start_job`, `finish_workflow`, `fail_workflow` and a cancel are refused. | `workflowLifecycle::endedWorkflowHasNoUnfinishedTask`, `workflowLifecycle::nothingReopensAFinishedWorkflow`, `workflowLifecycle::finishedWorkflowKeepsItsStatus` |
| T15 | A later plan cannot change the workflow definition. | `workflowLifecycle::workflowKeepsItsDefinition` |
| T16 | A job records an artifact only when it has an author. From then on, the author's todo list does not change. | `sessionRouting::todoListIsFixedAfterFirstArtifact` |
| T17 | An artifact status moves only along the legal moves, and `accepted` and `removed` are final. | `workflowLifecycle::artifactStatusMovesAreLegal`, `workflowLifecycle::anAcceptedArtifactNeverMovesBack` |
| T18 | The first handover sets the time the humans got the artifact, and it is never cleared. | `reviewLoop::deliveredToHumansIsNeverCleared` |
| T19 | A harness author moves from `in_review` to `working` only when a prompt goes out for it. | `harnessSession::anAuthorInReviewWorksOnlyWithAPrompt` |
| T56 | Every event, alarm and tool call settles within a bounded amount of store work. A loop that never settles does not hang the workflow. | `world::workBudget.within` |
| T58 | A single-issue workflow ends done when complete_job completes the job on its subject issue at the last planned stage. | `workflowLifecycle::aSingleIssueWorkflowIsDoneWithItsSubjectsJob` |
| T59 | A job on an issue works on the subject issue or an issue inside the subject. A start outside the subject, or before the workflow has one, is refused and does not start a job. | `workflowLifecycle::aJobWorksOnlyOnIssuesOfItsSubject` |
| T60 | A tracker origin, the plan, or a recorded tracker output sets the subject once. A plan or an output that names another subject is refused, and the subject does not change. | `workflowLifecycle::subjectNeverChanges` |
| T61 | The first prompt of a harness session is the task prompt until the task had a first prompt. After that it is the resume prompt, which takes the head of the queue as its wake text. A stop or a restart before the first prompt does not change this. | `harnessSession::aTaskWithoutAnEarlierPromptGetsTheTaskPrompt` |

### Restart, nudge, give up and fail

| ID | Effect | Guarded by |
|---|---|---|
| T20 | A task restarts at most twice, whatever the cause, then fails. The count lives on the task and covers harness and model-call tasks. A restart writes the task `queued` with its restart counted before it destroys the old container, so a restart of the Durable Object during the destroy leaves the task queued for the start step. A paused task waits queued for its resume. A failure of a task already queued for a restart is dropped. A restart whose container closed after another restart counted, or after a newer generation began, is dropped. | `workflowLifecycle::taskRestartsAtMostTwice`, `harnessSession::taskRestartsAtMostTwice`, `harnessSession::anUnpausedTaskWithWorkIsNeverStranded`, `reviewLoop::aRefinerRunRestartsAtMostTwice` |
| T21 | Recovery of a lost harness turn starts a fresh sandbox without counting a restart. A sandbox that keeps dying mid-turn restarts without a limit. | `harnessSession::aLostTurnIsRecoveredWithoutARestart` |
| T22 | A harness process exit counts a restart and starts a fresh sandbox. It does not close the container, write the board note, or tell the agent. | `tests::packages/orchestrator/src/workflow/task/harness/session.test.ts` |
| T23 | A sandbox start that throws restarts or fails the task. A start of an older generation that throws changes nothing, and so does one that throws on a task already queued for a restart. | `harnessSession::aFailedSandboxStartRestartsOrFails`, `workflowLifecycle::taskRestartsAtMostTwice`, `harnessSession::taskRestartsAtMostTwice` |
| T24 | After the hello, the handshake runs without a timer. An `initialize` or `session/new` that never answers leaves the task `working` without an alarm until the socket closes. A socket that closes during the handshake and does not come back restarts the sandbox the way a lost turn does. A queued prompt waits for the handshake to end. | `harnessSession::aHarnessSessionRunsOneTurnAtATime`, `harnessSession::anUnpausedTaskWithWorkIsNeverStranded` |
| T25 | A stalled author whose turn stopped early is not left alone. It has a nudge or another prompt queued or in flight, or a restart under way, or its task finished. | `harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` |
| T26 | An author turn the decisions model reads as blocked queues the gave up text and restarts or fails. A failed decisions call falls back to a heuristic. The outcome of a turn of an older generation is dropped. A blocked outcome leaves the author alone while a later prompt is in flight or queued. | `harnessSession::anAuthorInReviewRunsNoTurn`, `harnessSession::aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn`, `harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` |
| T27 | A researcher or refiner turn that gave up or stopped on a limit restarts or fails. | |
| T28 | A researcher's payload passes to its author. A missing or oversized payload restarts or fails the researcher, and the failure reaches the starting session. | `sessionRouting::researchReadsCompleteOnceTheAuthorStarts`, `sessionRouting::linearOnlyAsksReachTheStartingSession` |
| T29 | A refused prompt is no longer in flight, unless the next prompt went out in the same step. A refused prompt of an author whose last turn stopped early does not leave the author alone. It gets a nudge or a restart, or its task finished. An RPC id is never given twice, so a late answer cannot reach a later request. | `harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone`, `harnessSession::anAnswerReachesOnlyItsOwnRequest`, `harnessSession::aRefusedPromptLeavesTheTurn` |
| T30 | A model-call author's revise turn fails without a restart when the page host fails a read or a write, or when the answer skips or adds a comment reply. A page edit by a person, a polisher or an earlier revision does not fail it. A page model call that throws or answers blank fails the task. | `reviewLoop::aModelCallAuthorFailsOnlyOnAHostError` |
| T31 | A model turn that a restart or its deadline cut runs again as a restart. After an instance restart, the restart alarm restarts or fails each author, and a separate alarm per restarted author runs its turn again. The restart alarm gives each restarted author a new turn id, and the run-again alarm acts only while the author holds that id. Events and further restarts can land between them, and either alarm can fire twice. The deadline of the lost turn can fire between them and does not act. A stop between them takes the turn, so it does not run again. A further instance restart between them counts the turn as lost again, and its restart alarm counts another restart. A revise keeps its prompt queued until it applies the answer. An author with its page out goes back in review and takes that prompt. One without its page produces it again. A paused author stays paused. Past the restart limit the task fails with a post to the person. | `workflowLifecycle::aRestartDoesNotLoseAModelTurn` |
| T32 | A prompt queued for an unpaused model-call author reaches it. A model turn is in flight, the author is starting, or a polisher holds its page. A paused author keeps its queued prompts until it resumes. | `workflowLifecycle::aQueuedPromptReachesItsModelCallAuthor`, `reviewLoop::aQueuedPromptReachesItsModelCallAuthor` |
| T33 | A restart after the host wrote the page but before the store recorded it runs the turn again. A first turn creates a second page. A revise runs again on the revised text and can post its comment replies twice. | |

### Task alarms

| ID | Effect | Guarded by |
|---|---|---|
| T40 | The provision alarm starts a sandbox only for a `queued` task. The start step of a Durable Object arms a provision alarm for each unpaused `queued` task, so an unpaused harness task with work always has a way forward. | `harnessSession::anUnpausedTaskWithWorkIsNeverStranded`, `harnessSession::provisionStartsOnlyAQueuedTask` |
| T41 | The `no_progress` alarm ignores a stale generation, an idle, finished or paused task. Without a socket it recovers the lost turn. Otherwise it nudges or restarts. | `workflowLifecycle::staleAlarmIsIgnored`, `harnessSession::staleAlarmIsIgnored`, `harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` |
| T42 | The wall clock alarm fails a task whose turn ran past the limit, without a restart. It belongs to the task, not to a generation. | `harnessSession::wallClockFailsWithoutARestart` |
| T43 | The hello timeout restarts or fails a task that never said hello. While the start of the task's current generation is still awaited in this isolate it rearms without a limit. A start of an older generation that returns does not end that wait. | `workflowLifecycle::staleAlarmIsIgnored`, `harnessSession::staleAlarmIsIgnored`, `harnessSession::theHelloTimeoutWaitsWhileItsStartIsOut` |
| T44 | The keep alive alarm of the current generation stays armed while a turn of an unfinished task runs in a harness session. A restart that another restart made stale does not stop it. | `workflowLifecycle::staleAlarmIsIgnored`, `harnessSession::staleAlarmIsIgnored`, `harnessSession::aRunningTurnKeepsItsSandboxAwake` |
| T45 | The queue retry alarm drains a prompt queued while the bridge was briefly closed. | `workflowLifecycle::staleAlarmIsIgnored`, `harnessSession::staleAlarmIsIgnored`, `harnessSession::anUnpausedTaskWithWorkIsNeverStranded` |
| T46 | The bridge lost alarm recovers the turn of a socket that closed with a prompt in flight or a pending handshake and did not reconnect. The recovery forgets the harness session, so the next prompt goes to a fresh sandbox. | `workflowLifecycle::staleAlarmIsIgnored`, `harnessSession::staleAlarmIsIgnored`, `harnessSession::aHarnessSessionRunsOneTurnAtATime` |
| T47 | The token refresh alarm mints a new workflow repo token before expiry and retries every 60 seconds without a limit. A refresh without a bridge drops its alarm, and the next hello refreshes the token. A first mint that fails starts the sandbox without a token and does not arm a refresh. A failed all-repos read token only narrows access. | `tests::packages/orchestrator/src/workflow/task/sandbox/credential.test.ts`, `tests::packages/orchestrator/src/workflow/task/sandbox/sandbox-start.test.ts`, `tests::packages/orchestrator/src/workflow/task/harness/session.test.ts` |
| T48 | The idle alarm posts the sleep message only while the workflow runs from a plan. | `workflowLifecycle::sleepMessageOnlyDuringAWorkflow` |
| T49 | The model turn deadline alarm cuts a model turn that ran too long, and the cut turn is not lost. An alarm of an older turn does not act. | `workflowLifecycle::staleAlarmIsIgnored`, `harnessSession::staleAlarmIsIgnored`, `workflowLifecycle::aRestartDoesNotLoseAModelTurn` |
| T57 | The start step of a Durable Object arms a settle alarm for each `working` author without a prompt in flight. The alarm settles the author and drains its queue, as the outcome check that a restart of the Durable Object dropped would have. It does not wake the agent. An alarm of an older generation does not act. | `workflowLifecycle::staleAlarmIsIgnored`, `harnessSession::staleAlarmIsIgnored`, `harnessSession::anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone`, `harnessSession::anUnpausedTaskWithWorkIsNeverStranded` |

### Task external calls

| ID | Effect | Guarded by |
|---|---|---|
| T50 | The bridge accepts a dial only with the task's bridge token. A newer socket closes the older one. | `harnessSession::aBridgeConnectsOnlyWithTheCurrentToken` |
| T51 | A harness permission request that offers an allow option gets it. A request without one is not allowed. Other agent requests get method not found. | `harnessSession::everyPermissionRequestWithAnAllowOptionIsAllowed` |
| T52 | A sandbox destroy that fails is logged and ignored. A bridge process check that fails reads as running. | |
| T54 | A stop or a finished task before the model call of a model-call author answers leaves the page as it was. A stop during the page write ends the turn once the write returns, and a prompt meanwhile waits in the queue, so the author has at most one page write out. A page write that returns after the task finished does not make the page the job's artifact. | `workflowLifecycle::stoppedModelCallLeavesThePage`, `workflowLifecycle::aModelCallAuthorWorksOnlyWhileItsCallIsOut`, `workflowLifecycle::oneLiveJobPerInputArtifact`, `workflowLifecycle::aModelCallAuthorHasAtMostOnePageWriteOut` |

## Orchestrator agent turn

| ID | Effect | Guarded by |
|---|---|---|
| A1 | Every inbox row a turn takes moves into the transcript once and leaves the inbox, also when the model fails or the turn times out. | `agentTurns::everyInboxRowReachesTheTranscriptOnce` |
| A2 | The decisions model reads whether a person's message owes a reply and whether it requests work. A failed call falls back to an unread message, and every later decisions call of the turn falls back too. | `agentTurns::laterDecisionsCallsFallBackOnceOneFails`, `agentTurns::aDecisionsCallFallsBackOnlyAfterEveryModelFailed`, `agentTurns::aPersonGetsTheAnswerDuringADecisionsOutage` |
| A3 | A message that asks for a revision sends the held comments of every running page author before the model runs. Unreadable or unadmitted comments stay held, and the agent is told. | `reviewLoop::aPromptToAPageAuthorCarriesItsHeldComments` |
| A4 | Compaction replaces the rows before the turn with one recap. A failed summarization leaves the transcript whole. | `agentTurns::compactionReplacesOnlyEarlierRows` |
| A5 | Every tool call in the transcript keeps its result. | `agentTurns::everyToolCallKeepsItsResult` |
| A6 | In a person's turn, only `acknowledge` and `ask` are offered until one of them succeeds. | `agentTurns::aPersonHearsBackBeforeAnyWork` |
| A7 | The chat thread leaves its working status when the turn ends, unless a chat message that waits for the next turn put it back. A turn the watchdog already answered releases the thread when it ends. | `agentTurns::theWorkingStatusNeverOutlivesItsTurn` |
| A8 | A person's turn that left them without a reply runs the model once more with a note that says so. | `agentTurns::aPersonsTurnNeverEndsUnanswered` |
| A9 | Closing text posts only as the answer to a person who wrote, once, and is withheld when the board change was the reply. A resumed turn keeps the board change of the lost turn on a person's message. | `agentTurns::closingTextAnswersOnlyAPersonWhoWrote` |
| A10 | The stuck text of a model that failed twice stays out of tracker sessions when a chat thread exists. Without a chat thread, it reaches the starting session and each session a person wrote from. | `agentTurns::sessionMessageWithoutAnAuthorIsAnswered` |
| A11 | The turn deadline aborts the attempt and posts the timeout text, or the watchdog posts it first. It reaches the same people as the stuck text. | `agentTurns::aWaitingPersonHearsBackByTheTimeout`, `agentTurns::sessionMessageWithoutAnAuthorIsAnswered`, `sessionRouting::linearOnlyAsksReachTheStartingSession`, `sessionRouting::sessionMessageWithoutAnAuthorIsAnswered` |
| A12 | A turn lost with its Durable Object resumes, posts the restart notice in chat, keeps the lost turn's board change, and answers what the lost turn owed. | `agentTurns::aResumedTurnAnswersWhatItsLostTurnOwed`, `agentTurns::closingTextAnswersOnlyAPersonWhoWrote` |
| A13 | A `fetch_url` result passes the screen, and a page the screen did not admit does not enter the transcript. | `agentTurns::quarantinedTextNeverEntersTheTranscript` |
| A14 | `read_channel` screens each message. A flagged message does not remove another from the read. | `agentTurns::aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead`, `agentTurns::quarantinedTextNeverEntersTheTranscript` |
| A15 | A tool result over the context limit is replaced by its summarization under a marker, or by a fixed "too large" text. | `tests::packages/orchestrator/src/agent/tools/condensed.property.test.medium.ts` |
| A16 | A failed MCP connect is logged, and the turn runs without the MCP tools. | `tests::packages/orchestrator/src/agent/tools/mcp.test.ts`, `tests::packages/orchestrator/src/agent/turn/turn-mcp-unavailable.test.medium.ts` |
| A17 | Turn answers reach the people the turn answers, read as the turn takes its inbox, so a post after the watchdog fired still reaches them. They reach the chat thread and do not reach a session when a chat thread exists. Otherwise they reach the sessions people wrote from. | `agentTurns::sessionMessageWithoutAnAuthorIsAnswered` |

### Agent turn alarms

| ID | Effect | Guarded by |
|---|---|---|
| A20 | The heads-up alarm at 60 seconds posts the heads-up in chat and keeps the thread working, when a person's message was taken and the turn it was armed for still runs. | |
| A21 | The watchdog alarm at the turn timeout records that no turn runs, deletes taken rows and posts the timeout text. The hung turn keeps running, its tools keep acting, its closing text can still post, and it releases the threads when it ends. | `agentTurns::oneTurnRunsAtATime`, `agentTurns::aWaitingPersonHearsBackByTheTimeout`, `agentTurns::theWorkingStatusNeverOutlivesItsTurn` |
| A22 | The start step of a Durable Object with a turn still marked as running resumes the lost turn. Without a lost turn, inbox rows that wait to wake the agent get a `runAgent` alarm. | `agentTurns::aResumedTurnAnswersWhatItsLostTurnOwed`, `agentTurns::aWaitingInboxRowHasATurnComing` |
| A23 | A `runAgent` alarm runs a turn when a turn is not already running. Every inbox row that waits has a turn coming, either a rerun after the running turn or a `runAgent` alarm. | `agentTurns::aWaitingInboxRowHasATurnComing` |
| A24 | A stale heads-up or watchdog alarm, armed for a turn that no longer runs, does not act. | |
| A25 | One agent turn runs at a time. The store marks a turn as running from its start until it ends or the watchdog fires. | `agentTurns::oneTurnRunsAtATime` |

### Agent tools

| ID | Effect | Guarded by |
|---|---|---|
| A30 | `acknowledge` puts a thumbs-up on each taken chat message, or posts one line to the people who wrote. A failed reaction partway leaves some messages without it. | `agentTurns::aPersonHearsBackBeforeAnyWork`, `agentTurns::aPersonsTurnNeverEndsUnanswered` |
| A31 | `ask` posts a question, and sets the workflow `waiting_input` when every author and researcher is idle. | `sessionRouting::linearOnlyAsksReachTheStartingSession`, `sessionRouting::orchestratorStaysOutOfSessionsWhenChatExists` |
| A32 | `tell` posts info to the people who wrote, and `stay_silent` stays quiet. Both end the turn. | `agentTurns::closingTextAnswersOnlyAPersonWhoWrote`, `agentTurns::aPersonsTurnNeverEndsUnanswered` |
| A33 | `set_plan` sets the definition, stages, number of job slots, repository, page parent and root page. A later plan can set fewer job slots than the jobs that run, and no job starts until one finishes. It sets the workflow `running`, moves the origin issue to started, and can create the root page on the document host. | `workflowLifecycle::workflowStartsOnlyFromAPlan`, `workflowLifecycle::workflowKeepsItsDefinition`, `workflowLifecycle::jobStartsOnlyIntoAFreeSlot` |
| A34 | `start_job` inserts the job and task, binds the issue and branch in the router, claims the issue, links the chat thread, schedules the provision alarm, and links the input page from the root page. | `workflowLifecycle::jobStartsOnlyIntoAFreeSlot`, `workflowLifecycle::oneLiveJobPerInputArtifact`, `sessionRouting::eachIssueLinksTheChatThreadOnce`, `workflowLifecycle::workflowStartsOnlyFromAPlan` |
| A35 | `start_job` on an issue starts only when the issue's binding points at no workflow, at this workflow, or at a workflow that ended. The binding row alone decides. A workflow whose session maps the issue refuses another workflow's job on it until it ends, even without a job on the issue. `start_job` also refuses when the binding moved after it read it. | `routerBindings::oneRunningWorkflowHasAJobOnAnIssue` |
| A36 | `complete_job` stores a selection, or advances a host-accepted artifact. It ends the author `done`, destroys its sandbox, cancels its refiner run, and hands the artifact over. | `workflowLifecycle::aFailedCheckNeverCompletesAJob`, `workflowLifecycle::aFailedCheckNeverAsksThePersonAgain`, `workflowLifecycle::finishedTaskKeepsItsStatus`, `workflowLifecycle::artifactStatusMovesAreLegal` |
| A37 | `cancel_job` cancels the author or researcher. It closes its feed, destroys its sandbox, cancels its refiner run, and closes the artifact. | `workflowLifecycle::finishedTaskKeepsItsStatus`, `harnessSession::finishedTaskKeepsItsStatus`, `workflowLifecycle::artifactStatusMovesAreLegal`, `reviewLoop::oneUnfinishedRefinerRunPerArtifact`, `reviewLoop::anEndedAuthorEndsItsReview` |
| A38 | `prompt_task` reads and screens held page comments, marks them read, and queues the prompt. It marks the comments read before it queues the prompt. | `reviewLoop::aPromptToAPageAuthorCarriesItsHeldComments` |
| A39 | `pause_task` and `resume_task` set or clear the pause, send a cancel to the harness session, post "Paused" or "Resumed", and queue "Continue where you left off." on resume. The resume prompt waits for the answer to the turn the pause cancelled, and a turn whose bridge was lost during the pause is recovered. They report success on a no-op. A paused task gets no prompt until it resumes. The first prompt of a session that opens while the task is paused waits at the head of its queue, and the restart of a paused task leaves it `queued` for the resume to start the next generation. | `workflowLifecycle::pausedAuthorGetsNoPrompt`, `harnessSession::pausedAuthorGetsNoPrompt`, `harnessSession::aHarnessSessionRunsOneTurnAtATime`, `sessionRouting::aStopAnswersOnlyInTheFeed`, `sessionRouting::sessionMessageReachesItsRunningAuthorSilently` |
| A40 | `cancel_task` cancels a refiner run. A cancelled polisher hands the artifact over as it was left. | `reviewLoop::oneUnfinishedRefinerRunPerArtifact`, `workflowLifecycle::finishedTaskKeepsItsStatus`, `harnessSession::finishedTaskKeepsItsStatus`, `reviewLoop::aStoppedRefinerRunHandsOverBlocked` |
| A41 | `request_review` starts the reviewer segment from its first entry. `finish_review` moves past the open entry to the next refiner or the handover. | `reviewLoop::refinersRunAgainOnlyOnChangedRevision`, `reviewLoop::oneUnfinishedRefinerRunPerArtifact`, `reviewLoop::authorIsIdleWhileAPolisherRuns` |
| A42 | `rule_on_review` with approve moves on, or first sends the author the findings of the judge's segment. With reject it posts the signed reason on the artifact host and sends it to the author with those findings. | `reviewLoop::judgeRulesAtMostOnce`, `reviewLoop::authorGetsEveryPullFinding` |
| A43 | `finish_workflow` sets `done`, posts the done event, moves tracker issues to completed, and removes code host bindings. It refuses while an author or researcher is active. | `workflowLifecycle::endedWorkflowHasNoUnfinishedTask`, `workflowLifecycle::nothingReopensAFinishedWorkflow` |
| A44 | `fail_workflow` cancels every active task and refiner run, sets `failed`, posts the failure, and removes code host bindings. | `workflowLifecycle::endedWorkflowHasNoUnfinishedTask`, `sessionRouting::linearOnlyAsksReachTheStartingSession`, `routerBindings::anEndedWorkflowKeepsNoCodeHostBinding` |
| A45 | `move_into_root_page` moves a page under the root page on the document host and drops its link. | `tests::packages/orchestrator/src/agent/tools/root-page.test.ts` |
| A46 | The MCP tracker tools are an allow-list of reads and five writes: issues, comments, projects, milestones and status updates. A result the screen does not admit reads to the model as not given, though the write happened. | |
| A47 | The read tools only read, and they screen text that comes from outside. | `agentTurns::quarantinedTextNeverEntersTheTranscript` |

### Agent external calls

| ID | Effect | Guarded by |
|---|---|---|
| A50 | The main model request retries once per turn and fails into the stuck text. A hang ends at the turn deadline. | `agentTurns::aPersonsTurnNeverEndsUnanswered`, `agentTurns::aWaitingPersonHearsBackByTheTimeout` |
| A51 | A decisions call that fails, hangs or lacks a gateway returns its site's fallback. The fallback of the acceptance and selection checks keeps the job open. | `agentTurns::laterDecisionsCallsFallBackOnceOneFails`, `workflowLifecycle::aFailedCheckNeverCompletesAJob` |
| A52 | A failed model list for a requested runtime reads to the person as "matched none clearly". | `tests::packages/orchestrator/src/agent/tools/start/start.test.ts` |
| A53 | A host acceptance lookup that throws reads as "not accepted". | `tests::packages/orchestrator/src/artifact/pull.test.ts` |

## Refiners, reviews and handover

| ID | Effect | Guarded by |
|---|---|---|
| R1 | Refiners settle only once the author is quiet and the checks gate is open. Each settle reads the store again after the host read. | `reviewLoop::authorIsIdleWhileAPolisherRuns`, `reviewLoop::oneUnfinishedRefinerRunPerArtifact`, `reviewLoop::refinersStartOnlyWhenTheAuthorsGateOpens`, `reviewLoop::aBlockedAuthorsGateHandsOverBlocked`, `tests::packages/orchestrator/src/workflow/refiner/checks-gate.test.ts` |
| R2 | An artifact has at most one unfinished refiner run, and the artifact points at it. | `reviewLoop::oneUnfinishedRefinerRunPerArtifact` |
| R3 | A refiner run starts on an artifact the humans hold only after an author turn ended on a changed revision. An unknown revision counts as changed. | `reviewLoop::refinersRunAgainOnlyOnChangedRevision` |
| R4 | A reviewer does not run again on a revision it already reviewed. One rule picks the next entry on every path that runs the list: after the author's turn, `request_review`, `finish_review`, a review again decision, a stale segment restart, and a finished entry handing on. It passes over an entry that already reviewed or ruled on the current revision, and a judge that ruled. `request_review` refuses when that leaves no entry of the open segment, and a review again decision of yes then advances, as no does. An unknown revision allows the run. | `reviewLoop::reviewerRunsOnlyOnAnUnreviewedRevision` |
| R5 | A findings reviewer entry runs at most `max_review_runs` times on one artifact. The limit adds the unreviewed revision note at handover. A stale segment restart does not count against the limit. | |
| R6 | A judge rules at most once on an artifact, and its ruling never changes. Later runs skip judge entries that ruled. A ruling that lands while the decisions model or the host is asked stands, and the later one is dropped. An instance restart that loses the ruling call of the judge run the artifact waits on asks the decisions model again, unless the agent was already asked for a person's ruling. | `reviewLoop::judgeRulesAtMostOnce`, `reviewLoop::aRestartDoesNotStrandAJudgeRun` |
| R7 | The decisions model rules a judge conclusion. A missing conclusion, a failed call or a middle probability asks a person to rule. | `reviewLoop::aRestartDoesNotStrandAJudgeRun` |
| R8 | A refiner run ends `done` only after its turn ended normally. A polisher waiting on the checks of its push ends later, only if it did not take a prompt since. | `reviewLoop::refinerRunIsDoneOnlyAfterItsTurnEnded`, `reviewLoop::aPolisherEndsDoneOnlyWhenItsChecksOpen`, `tests::packages/orchestrator/src/workflow/refiner/polish.test.ts` |
| R9 | The review again decision reads a model-call author's closing text. An answer of yes reruns the segment from its first entry that did not review the revision, and an answer of no advances. A failed call asks the agent to route. | |
| R10 | The agent routes a harness author's review with `request_review` or `finish_review`. The agent is told again on every settle until it routes. | |
| R11 | A segment merges the latest reviews of its entries and sends the merged review to the author when it holds findings or blocks. A segment that ends with a judge sends it once the judge rules: with the rejection, or on its own after an approval. A clean or empty segment advances. | `reviewLoop::authorGetsEveryPullFinding`, `reviewLoop::authorGetsEveryPageFinding` |
| R12 | The handover moves the artifact from drafted to ready once and records that the humans got it. That record is never cleared. Blocked paths hand over with a reason. | `reviewLoop::deliveredToHumansIsNeverCleared`, `workflowLifecycle::artifactStatusMovesAreLegal`, `workflowLifecycle::inReviewTaskHasAnArtifact`, `harnessSession::inReviewTaskHasAnArtifact` |
| R13 | A failed findings reviewer or judge run hands the artifact over blocked. A cancelled or failed polisher hands it over blocked. A review read that fails hands over blocked. | `reviewLoop::aStoppedRefinerRunHandsOverBlocked` |
| R14 | An author turn that ends on a ready artifact with a changed or unreadable revision reopens it to drafted and reruns the refiners. A stage without refiners posts `artifact_ready` again. The turn that records the artifact does not reopen it, so the humans get each recorded revision once. | `workflowLifecycle::artifactStatusMovesAreLegal`, `reviewLoop::refinersRunAgainOnlyOnChangedRevision` |
| R15 | A pull request review read that fails hands the artifact over blocked, with a reason that says the review could not be read. A reviewer that did not file a review reads as clean. | `reviewLoop::aStoppedRefinerRunHandsOverBlocked` |
| R16 | A reviewer that failed or gave up restarts while it has restarts, then the artifact is handed over blocked. | `workflowLifecycle::finishedTaskKeepsItsStatus`, `harnessSession::finishedTaskKeepsItsStatus`, `reviewLoop::aRefinerRunRestartsAtMostTwice`, `reviewLoop::aFinishedRefinerRunKeepsItsStatus`, `reviewLoop::aStoppedRefinerRunHandsOverBlocked` |
| R17 | An accepted artifact stays accepted, and a refiner run does not start on its job. Its job completes once. A second `complete_job` does not change a task or the artifact, and does not post. | `workflowLifecycle::anAcceptedArtifactNeverMovesBack`, `workflowLifecycle::finishedTaskKeepsItsStatus` |

### Polish and checks

| ID | Effect | Guarded by |
|---|---|---|
| R20 | The author does not take a prompt while a polisher runs. The first prompt of a session that opens meanwhile, such as after a restart, waits at the head of its queue until the polisher ends. | `reviewLoop::authorIsIdleWhileAPolisherRuns` |
| R21 | A polisher run ends `done` only after the checks gate opens or blocks on the revision it left, and a blocked gate hands the artifact over blocked. Failed checks or a conflict go back to the submitter at most once per revision. | `reviewLoop::aPolisherEndsDoneOnlyWhenItsChecksOpen`, `reviewLoop::checksGoBackOncePerRevision` |
| R22 | An unreadable revision opens the checks gate, so the refiners and the handover skip CI. | `reviewLoop::aPolisherEndsDoneOnlyWhenItsChecksOpen` |
| R23 | The `recheck` alarm ticks every 60 seconds while the gate waits and stops when it opens, blocks, or the workflow ends. | |
| R24 | While the humans hold the artifact, failed checks or a conflict go to an idle author at most once per revision. | `reviewLoop::checksGoBackOncePerRevision` |
| R25 | A follow-up starts when a prompt reaches an idle author while the humans hold the artifact. The board moves to the end of the thread. | `tests::packages/orchestrator/src/workflow/follow-up.test.ts`, `tests::packages/orchestrator/src/workflow/board/board-relocate.test.ts` |

### Writes to the artifact host

| ID | Effect | Guarded by |
|---|---|---|
| R30 | A pull request reviewer posts its own review with its own token. | `tests::packages/orchestrator/src/workflow/task/sandbox/credential.test.ts` |
| R31 | A page review posts each finding with a passage as an inline comment, then one outcome comment with the review line. A failed inline comment moves into the outcome comment. The post happens before the check that the run still owns the artifact. | `reviewLoop::pageReviewPostsEachFindingOnce` |
| R32 | A judge rejection on a page posts its reason in one comment when the host takes it. The author gets the rejection whether the post landed or not. | `reviewLoop::aJudgeRejectionPostsItsReasonOnce` |
| R33 | Person feedback on a pull request gets the eyes reaction per comment, or "Relayed to the author." when it lacks comment handles, before routing. One failure skips the rest. Feedback the screen does not admit is not acknowledged. | |
| R34 | A page comment is acknowledged with the eyes reply before it is sent to the author, and only the comments the host marked read are sent. The host marks only the earliest held comment of a comment thread, so a reply posted while the screen reads stays held. A comment the host does not mark stays held, and the agent is told. | `reviewLoop::aPromptToAPageAuthorCarriesItsHeldComments`, `reviewLoop::aHeldCommentStaysHeldUntilItReachesTheAuthor` |
| R35 | A model-call author's revise posts one comment reply per handled comment still on the page before it writes the page. It also replies to each comment a queued prompt carries on a line the write removes, saying the author reads it next. A failed reply fails the task, and replies already posted stay. | `reviewLoop::sentCommentIsAnsweredBeforeItsLineGoes`, `reviewLoop::replyGoesOnlyToASentComment`, `reviewLoop::failedReplyLeavesThePage`, `reviewLoop::aModelCallAuthorFailsOnlyOnAHostError` |
| R36 | A page text change keeps the identity of every line the answer left alone. | `tests::packages/adapters/src/documents/page-text-update.test.ts`, `tests::packages/orchestrator/src/workflow/task/model-author.test.ts` |
| R37 | The root page holds a resources section that code writes: a heading, one link line per linked page, and the link removed when a page moves under the root page. The author text goes above it. | |

### Inbound events in the workflow

| ID | Effect | Guarded by |
|---|---|---|
| E1 | Every feedback event on a running workflow gets one routing decision: author, agent, or `nobody`. | `feedbackRouting::everyFeedbackGetsOneRoutingDecision` |
| E2 | Feedback the screen does not admit reaches neither the agent nor the author. | `feedbackRouting::unadmittedFeedbackReachesNobody`, `reviewLoop::unadmittedFeedbackReachesNobody` |
| E3 | A pull request review claims its review id only when the host read succeeds. On a failed read, the review and its comments can each prompt the author. || `tests::packages/orchestrator/src/artifact/pull.test.ts` |
| E4 | A page comment that does not mention the bot stays held. A mention screens every held comment with it. When the decisions model routes it to the author, the held comments the host marks read go with it as one feedback. On any other route they stay held. | `reviewLoop::aPromptToAPageAuthorCarriesItsHeldComments`, `reviewLoop::aHeldCommentStaysHeldUntilItReachesTheAuthor` |
| E5 | An event on a finished workflow does not change its status, its tasks or its prompts, and does not tell the agent. A person's message does not reach it, and the router starts the next workflow with it. A stop still closes the author's feed with the stopped reply. | `workflowLifecycle::nothingReopensAFinishedWorkflow`, `workflowLifecycle::endedWorkflowHasNoUnfinishedTask`, `routerBindings::aPersonsMessageNeverReachesAnEndedWorkflow`, `sessionRouting::aStopAnswersOnlyInTheFeed` |
| E6 | A message wakes a workflow from `waiting_input` to `running` and rearms the idle alarm. | |
| E7 | A stop clears the author's queue, cancels a running turn, ends the author's generation, and closes its container, also for an idle author. A call the author awaited before the stop does not start work after it. A model-call author that the stop left without a turn does not start one until a prompt or a resume, also when the alarm that runs its lost model turn again fires. The feed closes with "Stopped.". The workflow does not change, and the orchestrator does not post. | `harnessSession::stopEndsTheAuthorsTurn`, `harnessSession::aStoppedAuthorStaysQuiet`, `sessionRouting::aStopAnswersOnlyInTheFeed`, `workflowLifecycle::stoppedModelCallLeavesThePage`, `workflowLifecycle::aStoppedModelCallAuthorStaysQuiet` |
| E8 | A person's verbal command: cancel, pause, resume or instruct. A cancel of the workflow leaves every task finished. Pause, resume and instruct act on the task of the one active job, a researcher too. A paused task keeps the instruct prompt queued until it resumes. In a session with a running author, the words go to the author as a prompt. A verbal command that runs answers the person itself. | `workflowLifecycle::pausedAuthorGetsNoPrompt`, `sessionRouting::sessionMessageWithoutAnAuthorIsAnswered`, `sessionRouting::sessionMessageReachesItsRunningAuthorSilently`, `workflowLifecycle::endedWorkflowHasNoUnfinishedTask` |
| E9 | A pull request opened records the artifact and settles refiners. Marked ready cancels the refiner run and hands over. Merged accepts the artifact and tells the agent, and does not cancel a running polisher. Closed unmerged removes it and cancels the author. Reopened does not change the artifact. | `workflowLifecycle::artifactStatusMovesAreLegal`, `workflowLifecycle::anAcceptedArtifactNeverMovesBack` |
| E10 | A check or base branch event settles the checks of each matched job. | |
| E11 | An artifact event that does not match a job adds an agent note. While an author or researcher is active, the agent note asks which job it is about. An event that does not name its artifact fans out over the open artifacts and the job of the only active author or researcher, and does not ask. When neither exists, it matches no job. | `tests::packages/orchestrator/src/workflow/refiner/feedback.test.ts` |
| E12 | The workflow notices a deleted page, or a pull request closed without a merge whose event was lost, only when `start_job` checks the earlier output. | `tests::packages/orchestrator/src/agent/tools/start/start.test.ts`, `tests::packages/orchestrator/src/agent/tools/start/start.test.medium.ts` |

## Boards and chat output

| ID | Effect | Guarded by |
|---|---|---|
| C1 | Every board lives in a chat thread the workflow replies to. A tracker session never holds one. | `sessionRouting::boardsLiveOnlyInChat` |
| C2 | The rendered board shows each researcher and author as its todo list or its work line. | `tests::packages/orchestrator/src/workflow/board/board-tasks.test.ts`, `tests::packages/orchestrator/src/workflow/board/render.test.ts` |
| C3 | A researcher's todo list reads complete once the author of its job exists. | `sessionRouting::researchReadsCompleteOnceTheAuthorStarts` |
| C4 | A board post or edit that fails is retried only on the next flush, and the flush is not scheduled. The chat can hold a stale or missing board until something else changes on the job. | |
| C5 | A board is created once per job and thread. An isolate lost between the post and the row update posts a second board on the next flush. | `tests::packages/orchestrator/src/workflow/board/board.test.ts`, `tests::packages/orchestrator/src/workflow/board/board-relocate.test.ts` |
| C6 | A board a person deleted is posted again once. A second delete leaves it deleted. | |
| C7 | A follow-up moves the board to the end of the thread. It posts a new board, then deletes the old one or edits it to a pointer. | |
| C8 | A todo list or refiner change waits for the `flushBoard` alarm, which collects changes for 10 seconds. A task lifecycle change flushes at once and drops the pending alarm. A board edit happens only when the body hash changes. | |
| C9 | A board note shows a restart reason or a prompt error until the turn ends. | `tests::packages/orchestrator/src/workflow/task/harness/turn-end.test.ts` |
| C10 | With a chat thread, every post goes to the chat threads and does not reach a tracker session. | `sessionRouting::orchestratorStaysOutOfSessionsWhenChatExists`, `sessionRouting::sessionMessageWithoutAnAuthorIsAnswered` |
| C11 | A chat post that fails writes a delivery error row and is not retried. The thread still leaves its working status, because the status call runs after the failed message. | |
| C12 | After a chat post with text, in a turn or outside one, the thread status goes to active, or closed when the workflow finished. A post that keeps the session does not set it. | |
| C13 | The sleep message posts only while the workflow runs from a plan. With a chat thread it stays out of tracker sessions. Without one, it reaches a tracker session only where a person wrote. The workflow moves to `waiting_input` only while every author and researcher is idle. | `workflowLifecycle::sleepMessageOnlyDuringAWorkflow`, `sessionRouting::orchestratorStaysOutOfSessionsWhenChatExists`, `sessionRouting::linearOnlyAsksReachTheStartingSession`, `workflowLifecycle::workflowWaitsOnlyWhileNoAuthorWorks` |
| C14 | A failed task posts "❌ reason". A failed workflow posts the failure and the "tag me again" line. | |
| C15 | A finished workflow posts "Done." with the result. | |
| C16 | A verbal command sent from a tracker session without a running author answers the person itself. | `sessionRouting::sessionMessageWithoutAnAuthorIsAnswered` |
| C17 | A reply target on a document page gets a page comment. A progress post skips the page. | |
| C18 | The chat eyes reaction marks a delivery slower than 3 seconds and comes off when it settles. The caller gets what the delivery gave. | `chatAcknowledgement::eyesNeverOutliveTheDelivery`, `chatAcknowledgement::eyesMarkOnlyASlowChatDelivery`, `chatAcknowledgement::theCallerGetsWhatTheDeliveryGave` |
| C19 | A received chat message sets the thread to its working status. | |

## Tracker output

| ID | Effect | Guarded by |
|---|---|---|
| K1 | Without a chat thread, the starting session gets every ask and failure, the stuck text and the timeout text included. A session gets any other post only where a person wrote. | `sessionRouting::linearOnlyAsksReachTheStartingSession` |
| K2 | The author's completed tool calls post to its job session as feed activities, once each. | `sessionRouting::feedActivityPostsOnce` |
| K3 | A turn that leaves its author idle ends the session feed with a reply or an error. A stop ends it with "Stopped.", on a finished workflow too. A cancelled turn that leaves its author idle ends it the same way. | `sessionRouting::sessionFeedEndsWhenItsAuthorIdles`, `harnessSession::stopEndsTheAuthorsTurn`, `harnessSession::aStoppedAuthorStaysQuiet`, `sessionRouting::aStopAnswersOnlyInTheFeed` |
| K4 | A feed activity retries with the same activity id. The tracker stores it at most once. | `sessionRouting::feedActivityPostsOnce` |
| K5 | The author's todo list becomes the session plan only when the workflow lacks a chat thread. | `sessionRouting::chatWorkflowNeverSetsASessionPlan` |
| K6 | The router posts "On it. Reading the issue." before it routes, on every tracker start and on a prompt that starts the next workflow. | |
| K7 | A start without an actor that the router drops gets "No workflow is working on this issue. Delegate it to me or mention me to start one." after the starting thought. One that joins a running workflow gets only the starting thought. | |
| K8 | A job start claims its issue: started state and delegation to the app user. The plan moves the origin issue to started. A done workflow moves tracker issues to completed. A failed or cancelled workflow does not move them. | |
| K9 | A chat workflow links an issue subject and each issue a job works on to its chat thread once. A tracker workflow does not link any. | `sessionRouting::eachIssueLinksTheChatThreadOnce` |
| K10 | A session message to a running author goes to that author as a prompt, does not post, and does not wake a turn. A paused author holds it in its queue. A prompt queued for an unpaused model-call author waits on an author at work. | `sessionRouting::sessionMessageReachesItsRunningAuthorSilently`, `workflowLifecycle::aQueuedPromptReachesItsModelCallAuthor` |
| K11 | A session message without a running author wakes an agent turn, and the turn's answer, question or timeout text reaches that session or the chat threads. A verbal command that runs answers the person itself. A finished workflow replies at once. | `sessionRouting::sessionMessageWithoutAnAuthorIsAnswered` |

## Router, identity and install

| ID | Effect | Guarded by |
|---|---|---|
| O1 | An event other than a base branch push joins the first running workflow bound to one of its bindings. A workflow whose create has not returned refuses every event, and the router drops it. | `routerBindings::aWorkflowGetsEventsOnlyOnceCreated` |
| O2 | A start event that a running workflow took, from a person or not, moves to it each binding it carries that was unbound or whose workflow ended. A binding that points at another running workflow keeps pointing at it. A new workflow takes a binding only while it still points where the delivery read it. | `routerBindings::aDeliveryLeavesTheBindingsOfARunningWorkflow` |
| O3 | A person's message on a binding whose workflow ended starts exactly one new workflow, and the binding moves to it. This holds when the Durable Object ended before the router's status did. Other events on a binding whose workflow ended are dropped. A start without a person does not start a workflow. | `routerBindings::messageAfterEndStartsNextWorkflow`, `routerBindings::aPersonsMessageNeverReachesAnEndedWorkflow` |
| O4 | A failed Durable Object create removes the bindings the new workflow took, points each back at the workflow it pointed at unless another delivery bound it since, and marks the workflow failed. | `routerBindings::anAbandonedWorkflowKeepsNoBinding` |
| O5 | A push to a base branch fans out to every workflow with a pull request in the repository. A failed delivery to one workflow is logged, and the rest still get the event. | |
| O6 | The router's workflow status mirrors the Durable Object status. The router reads it to decide whether a workflow ended. | |
| O7 | A workflow that ends removes its pull request bindings. A workflow does not bind a pull request once its status ended. | `routerBindings::anEndedWorkflowKeepsNoCodeHostBinding` |
| O8 | Access: with a tracker team set, a tracker user must be a member of it. The tracker app's own user is refused. With a chat team set, a chat user must be a full member of it. Without a chat team but with a tracker team, a chat user must join a tracker team member by email. With neither team set, every chat user passes. A document user must join a tracker user by email, who must be in the tracker team when one is set. A code user must be able to push, and any App passes as a code user. A failed lookup refuses. | `tests::packages/orchestrator/src/router/identity.property.test.medium.ts` |
| O9 | Every mapper ignores a message from an unauthorized person before delivery, so it does not start work. Only an event without a person reaches a workflow without an actor. There a start adopts the tracker session, other text is dropped, and a control gets "Not authorized.". | |
| O10 | A person row is found by any external id it holds, with email compared in lower case. An upsert whose ids name several rows merges them into the oldest, which keeps its own ids and fills its gaps. Tracker and chat users are upserted before the access check. Code users and users joined by email are upserted only after it passes. | `tests::packages/orchestrator/src/db/persons.property.test.medium.ts` |
| O11 | A repeated event id reaches the agent once per workflow. A base move copy gets the workflow id appended. | |
| O12 | The tracker install link mints a single-use state. The callback consumes it, exchanges the code, refuses a second workspace, and saves the tokens. A state that a callback does not consume stays stored after it expires. | |
| O13 | Calls in one isolate share one tracker token refresh. A refresh spends the refresh token with compare-and-set. The loser adopts the stored tokens. A failed refresh keeps the old token while it is valid. | `tests::packages/orchestrator/src/oauth/token.property.test.medium.ts` |
| O14 | A sandbox bridge dial to a workflow without a row gets 404. | `harnessSession::aBridgeConnectsOnlyWithTheCurrentToken` |

## Ingress routes

| ID | Effect | Guarded by |
|---|---|---|
| I1 | The Linear webhook checks the HMAC and a 60 second timestamp window, then maps the payload and delivers one event. A bad signature gets 401. | `webhookInvariants::badSignatureNeverDelivers` |
| I2 | The GitHub webhook checks the HMAC on the raw body without a timestamp window, then delivers one event. A missing delivery id gets a random event id. | `webhookInvariants::badSignatureNeverDelivers` |
| I3 | The Slack webhook checks the HMAC and a 300 second window. The route answers 200 at once and maps and delivers after the reply. Every Slack retry is dropped. A failed delivery is only logged. | `webhookInvariants::badSignatureNeverDelivers` |
| I4 | The app posts a Slack greeting when it joins a channel. | |
| I5 | The Notion webhook answers the unsigned subscription request while the verification token is unset, and refuses that request once the token is set. Then it checks the HMAC without a window. Only `comment.created` maps. The mapper fetches the comment before delivery, so the webhook refuses a comment while the Notion token is missing. | `webhookInvariants::badSignatureNeverDelivers` |
| I6 | The Linear OAuth callback relies on the single-use state. | |
| I7 | The admin install link and the debug dumps need the admin token. The dumps answer 404 unless debug is on. | |
| I8 | Bridge WebSocket upgrades pass to the orchestrator, which checks the bridge token. | `harnessSession::aBridgeConnectsOnlyWithTheCurrentToken` |
| I9 | A webhook with a changed, missing or duplicated signature, a wrong secret, or a body changed after signing does not reach the orchestrator. Neither does a Linear or Slack webhook whose timestamp is missing, a Linear webhook more than 60 seconds stale, a Slack webhook more than 300 seconds stale, or a Slack webhook whose timestamp changed after signing. The route does not deliver or look anyone up. | `webhookInvariants::badSignatureNeverDelivers` |

## Inbound mappers

| ID | Effect | Guarded by |
|---|---|---|
| M1 | Slack: a mention becomes `start`, or `status` for a bare status question in a thread. A thread reply becomes `prompt` or `status`. A check mark reaction on a message becomes `prompt`. Bots are ignored on mentions and thread replies. Edits are ignored on thread replies. The app itself, Slack Connect channels and tags of other people are ignored. | |
| M2 | GitHub: pull request opened, ready, closed or reopened become `pr_event`. Reviews, review comments and pull request comments become `feedback`. Check suites and failed check runs become `ci_event`. A push to the default branch becomes a `pr_event` with a base move action. Pull request events from forks or foreign branches and the app's own reviews are ignored. Bots are ignored on conversation comments. Reviews from other Apps arrive with a flag. Check events do not check for a fork. | |
| M3 | GitHub: each webhook maps on its own. GitHub delivers one review with N inline comments as N+1 webhooks, and each comment carries the id of its review. A failed check arrives as a check run and a check suite, so two `ci_event`s. | |
| M4 | Linear: a session created becomes `start`. A session prompt becomes `stop` on the stop signal, else `prompt` or `status`. A document comment becomes `feedback`. An issue moved to canceled or completed by a person becomes `control` cancel. Other workspaces are ignored. | |
| M5 | Notion: a page comment becomes `feedback` after a fetch. The mapper does not filter the bot's own comments. The resolver drops them because a bot lacks an email. || `tests::packages/adapters/src/documents/notion/inbound.test.ts` |
| M6 | With lookups that answer, every inbound mapper returns an event, or an ignore that names its reason, for any payload. It does not throw. | `inboundInvariants::inboundMapperNeverThrows` |

## Adapter writes and external calls

| ID | Effect | Guarded by |
|---|---|---|
| X1 | Slack thread replies split into chunks. A failure partway leaves the first chunks posted. Every Slack write throws on error. || `tests::packages/adapters/src/chat/slack/chat.test.ts` |
| X2 | Linear issue updates, activities, plans and thread sync throw on an error. A thread sync of an issue already synced to another thread links the thread URL instead. An activity conflict is swallowed only when the post names an activity id, so a retried post is idempotent. The SDK `success` flag is not read. | `sessionRouting::feedActivityPostsOnce` |
| X3 | GitHub writes are a pull request comment, a comment reaction and token minting. Paged reads stop at 10 pages and repository lists at 100. || `tests::packages/adapters/src/code/github/code-host.test.ts` |
| X4 | Notion page create, page text change, move, rename, comment, acknowledgement and reply throw on error. Inline findings swallow only a Notion client error per block and come back unposted. A page Notion does not find, or one in the trash, reads as removed. | |
| X5 | A page text change plans at most 100 edits that each match once and turn the read text into the revised text. | `tests::packages/adapters/src/documents/page-text-update.test.ts` |
| X6 | A Linear document text change reads the content Linear holds at write time and applies the planned edits to it, so a person's edit since the author read the page stays. It throws when an edit no longer matches. | |
| X7 | On Notion, a held comment is a person comment of a comment thread that a bot acknowledgement does not follow. Each bot acknowledgement marks the earliest unacknowledged person comment of its comment thread. On Linear, a person comment in an open thread without the bot's acknowledgement reaction is held. The bot's own comments are never held. | |
| X8 | Decisions calls try each configured model in order with per-attempt deadlines. A missing probability for a picked option counts as a failed call on both Cloudflare and OpenRouter, so the next model takes over. | `agentTurns::aDecisionsCallFallsBackOnlyAfterEveryModelFailed`, `agentTurns::laterDecisionsCallsFallBackOnceOneFails` |
| X9 | `fetch_url` follows redirects with a 20 second timeout and a 512 KB cap. || `tests::packages/adapters/src/web/http.test.ts` |
