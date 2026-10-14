# Behavior map

This file lists every effect a person sees or the system relies on, and the invariant that holds each one. It is the baseline a scheduled audit compares against. It describes main at #59.

Use the terms of the glossary. Name an invariant by its exact function name in an invariant module. A row that names a module or function points at where the effect happens. It does not name a contract.

## How to read a row

- **Guarded by** names the invariants that check the effect. The workflow invariants live in `packages/orchestrator/test/invariants.ts`. The agent turn invariants live in `packages/orchestrator/test/agent-invariants.ts`. The router, chat acknowledgement and page revision invariants live in `router-invariants.ts`, `chat-ack-invariants.ts` and `page-revision-invariants.ts` beside them.
- **Reach** is the share of 3,000 generated workflow runs (1,000 each for the any refiner list, page stage and model page properties) in which the invariant's check had something to check. The numbers come from the reach run of the generator reach work. A suffix such as "posting case" names the narrower case. "turn property", "router property" and "chat-ack property" mean the invariant runs in that property test, which does not report reach yet. "n/m" means not measured.
- **Status**
  - `guarded`: an invariant checks the effect, and its reach is at least 5%.
  - `weak`: an invariant checks the effect, but its reach is under 5%, a planted bug in the effect survived, the invariant is still marked proposed, or its check is narrower than its text.
  - `tested`: a property test checks the effect, but the rule is not an invariant in an invariant module.
  - `unguarded`: an invariant does not check the effect.
- **Open work** names an open pull request or work in progress that changes the row. On this date, #62 (a model-call author restarted mid-turn) is the only open pull request. The generator reach work, the CI gates and the ingress invariants (`badSignatureNeverDelivers`, `inboundMapperNeverThrows`) are in progress and not yet pull requests.

## Known audit results

- The workflow property missed two planted bugs: a reviewer that runs again on an unchanged revision, and a judge that rules twice.
- The workflow property caught "an author prompted while a polisher runs" in about 55% of runs.
- 11 workflow invariants are reached in under 5% of runs at the top level, and several more in a narrower case. The proposed page review invariants were not instrumented in the reach run.
- Ingress and the adapters did not have property tests on main beyond the page text change and held comment properties.

## Workflow, tasks and statuses

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| T1 | A job and its task start only into a free slot, and only after the plan started the workflow. A harness task also gets a sandbox row. | `startJob`, `insertTask` | `jobStartsOnlyIntoAFreeSlot`, `workflowStartsOnlyFromAPlan` | 41.6%, 11.2% | guarded | |
| T2 | Only one live job works from one input artifact in a workflow. | `startJob`, `input_key` | `oneLiveJobPerInputArtifact` | 4.0% | weak | Across workflows, see A35. |
| T3 | `startJob` writes the job and task before the D1 status and binding writes. A D1 failure leaves a `queued` task without a provision alarm. | `startJob` | | | unguarded | |
| T4 | A sandbox start moves the task to `provisioning` with a new generation and bridge token, and clears the session state. | `beginGeneration` | `staleAlarmIsIgnored` relies on the generation | 32.1% | guarded | |
| T5 | The first bridge hello moves the task to `working`. | `onBridgeHello` | | | unguarded | |
| T6 | An author moves to `working` only when a prompt or a model call goes out for it. | `sendPrompt`, `runModelAuthorTurn`, `reviseModelAuthorPage` | `authorIsIdleWhileAPolisherRuns` covers the polisher case | 5.7% | unguarded | #62 invariant 2 adds the model-call case. |
| T7 | An author moves to `in_review` only when its job has an artifact and a prompt is not in flight. | `markAuthorInReview` | `inReviewTaskHasAnArtifact` | 27.0% | guarded | |
| T8 | A finished task (`done`, `failed`, `cancelled`) never changes status again. | `finishTask`, `cancelTask`, `failTask` | `finishedTaskKeepsItsStatus` | 56.2% | guarded | |
| T9 | A failed author or researcher closes its review as blocked, posts `failed`, and wakes the agent. A failed reviewer or polisher hands the artifact over blocked. | `failTask` | `finishedTaskKeepsItsStatus` checks the status only | 56.2% | unguarded | The post is C14. |
| T10 | A cancelled author or researcher closes its review as blocked, flushes the board, and tells the agent. | `cancelTask` | `finishedTaskKeepsItsStatus`, `endedWorkflowHasNoUnfinishedTask` | 56.2%, 21.0% | guarded | |
| T11 | A harness task's cost is replaced by each usage update. A restart can lower the reported cost. | `onSessionUpdate` | | | unguarded | |
| T12 | The workflow is `running` after the plan, a job start, or a person's message on a `waiting_input` workflow. | `changeWorkflowStatus`, `handleEvent` | `workflowStartsOnlyFromAPlan` | 11.2% | guarded | |
| T13 | The workflow moves to `waiting_input` on the sleep message or on `ask`, only while every author and researcher is idle. | `onIdle`, `ask` | | | unguarded | |
| T14 | A workflow that is `done`, `failed` or `cancelled` keeps every task finished, and an event does not reopen it. | `completeWorkflow`, `failWorkflow`, `cancelWorkflow` | `endedWorkflowHasNoUnfinishedTask`, `nothingReopensAFinishedWorkflow` | 21.0%, 12.7% | guarded | |
| T15 | A later plan cannot change the workflow definition. | `set_plan` | `workflowKeepsItsDefinition` | 21.0% | guarded | |
| T16 | An artifact is recorded as `drafted` from a link in the turn text, an open pull request on the branch, or a created page. Its todo list is complete and fixed from then on. A researcher never records one. | `recordArtifact` | `todoListIsFixedAfterFirstArtifact` | 32.8% | guarded | |
| T17 | An artifact status moves only along the legal moves, and `accepted` and `removed` are final. | `markArtifactReady`, `reopenChangedArtifact`, `onAccepted`, `onClosed` | `artifactStatusMovesAreLegal` | 22.3% | guarded | |
| T18 | `delivered_to_humans_at` is set at the first handover and never cleared. | `markArtifactReady` | `deliveredToHumansIsNeverCleared` | 25.4% | guarded | |

### Restart, nudge, give up and fail

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| T20 | A task restarts in a fresh sandbox at most twice, then fails. | `restartOrFailTask`, `restartSandbox` | | | unguarded | #62 moves the count to the task and shares it with model-call tasks. |
| T21 | Lost turn recovery starts a fresh sandbox through `wakeOrWait` without counting a restart. A sandbox that keeps dying mid-turn restarts without a limit. | `recoverLostTurn`, `wakeOrWait` | | | unguarded | |
| T22 | A harness process exit restarts the sandbox without closing the container, writing the board note, or telling the agent. | `onBridgeExit` | | | unguarded | |
| T23 | A sandbox start that throws restarts or fails. A spec error, a gateway error or a stage the definition stopped declaring fails at once. | `startGeneration`, `provision` | | | unguarded | |
| T24 | After the hello, the handshake runs without a timer. An `initialize` or `session/new` that never answers leaves the task `working` without an alarm until the socket closes. | `onInitialized` | | | unguarded | |
| T25 | A stalled author gets one nudge. A second stall restarts it. | `nudgeOrRestartStalledTask` | `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` | 5.9% (idle case 4.9%) | guarded | |
| T26 | An author turn the decisions model reads as blocked queues the gave up text and restarts or fails. A failed decisions call falls back to a heuristic. | `restartBlockedAuthor`, `authorTurnOutcome` | `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` | 5.9% | guarded | |
| T27 | A researcher or refiner turn that gave up or stopped on a limit restarts or fails. | `restartIfTurnUnfinished` | | | unguarded | |
| T28 | A researcher's payload passes to its author. A missing or oversized payload restarts or fails the researcher. | `endResearcherTurn`, `startAuthorAfterResearch` | `researchReadsCompleteOnceTheAuthorStarts` | 1.6% | weak | |
| T29 | A prompt RPC error clears the prompt, writes a board note, and wakes the agent for an idle author. A researcher or refiner drains its queue or restarts. | `onRpcError` | | | unguarded | |
| T30 | A model-call author fails without a retry on a model error, an empty answer, a missing closing text, a comment reply that does not validate, or a page host error. The dequeued prompt is lost. | `runModelAuthorTurn`, `reviseModelAuthorPage` | | | unguarded | #62 keeps the prompt queued until the page write. |
| T31 | A model-call author whose isolate died mid-turn stays `working`, and the workflow does not wake it. | `modelTurns` in `at-work` | | | unguarded | #62 invariants 1 to 3 cover it. |

### Task alarms

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| T40 | The provision alarm starts the task only while it is still `queued`. A model-call task runs its first model turn. | `provision` | | | unguarded | |
| T41 | The `no_progress` alarm ignores a stale generation, an idle, finished or paused task. Without a socket it recovers the lost turn. Otherwise it nudges or restarts. | `onNoProgress` | `staleAlarmIsIgnored`, `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` | 32.1%, 5.9% | guarded | |
| T42 | The wall clock alarm fails a task whose turn ran past the limit, without a restart. It is task scoped, not generation scoped. | `onWallClock` | | | unguarded | The generator does not fire a stale wall clock alarm. |
| T43 | The hello timeout restarts or fails a task that never said hello. While the start is still awaited in this isolate it rearms without a limit. | `onHelloTimeout` | `staleAlarmIsIgnored` | 32.1% | weak | The unbounded rearm is not checked. |
| T44 | The keep alive chain keeps an active sandbox awake and stops when the task is idle or finished. | `keepSandboxAlive` | `staleAlarmIsIgnored` | 32.1% | guarded | |
| T45 | The queue retry alarm drains a prompt queued while the bridge was briefly closed. | `retryQueue` | `staleAlarmIsIgnored` | 32.1% | guarded | |
| T46 | The bridge lost alarm recovers the turn of a socket that closed with a prompt in flight and did not reconnect. | `onBridgeLost` | `staleAlarmIsIgnored` | 32.1% | guarded | |
| T47 | The token refresh alarm mints a new workflow repo token before expiry and retries every 60 seconds without a limit. A first mint that fails starts the sandbox without a token and does not arm a refresh. | `refreshToken`, `mintWorkflowRepoToken` | | | unguarded | |
| T48 | The idle alarm posts the sleep message. | `armIdle`, `onIdle` | `sleepMessageOnlyDuringAWorkflow` | 2.4% | weak | Same effect as C13. |

### Task external calls

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| T50 | The bridge accepts a dial only with the task's bridge token. A newer socket closes the older one. | `onConnect`, `acceptBridge` | | | unguarded | |
| T51 | Every harness permission request is allowed. Other agent requests get method not found. | `onAgentRequest` | | | unguarded | |
| T52 | A sandbox destroy that fails is logged and ignored. A bridge process check that fails reads as running. | `closeContainer`, `bridgeProcessGone` | | | unguarded | |
| T53 | A token mint that fails starts the sandbox without the token. A failed all-repos read token only narrows access. | `mintWorkflowRepoToken`, `mintAllReposReadToken` | | | unguarded | |
| T54 | A model call of a model-call author has a 13 minute deadline. A stop or a finished task before the answer leaves the page as it was. | `callAuthorModel` | `stoppedModelCallLeavesThePage` | 0.8% | weak | |
| T55 | A page model answer that is blank or throws fails the task. | `callAuthorModel` | `stoppedModelCallLeavesThePage` covers only a stop | 0.8% | unguarded | #62 reruns a lost turn. |

## Orchestrator agent turn

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| A1 | Every inbox row a turn takes moves into the transcript once and leaves the inbox, also when the model fails or the turn times out. | `runAgentTurn`, `takeInbox` | `everyInboxRowReachesTheTranscriptOnce` | turn property | guarded | |
| A2 | The decisions model reads a person's message: owed reply, requests work, asks for a revision, requested runtime, input artifact. A failed call falls back to an unread message, and every later decisions call of the turn falls back too. | `readPersonMessage`, `askDecisions` | `laterDecisionsCallsFallBackOnceOneFails`, `aDecisionsCallFallsBackOnlyAfterEveryModelFailed`, `aPersonGetsTheAnswerDuringADecisionsOutage` | turn property | guarded | |
| A3 | A message that asks for a revision sends the held comments of every running page author before the model runs. Unreadable or unadmitted comments stay held, and the agent is told. | `sendHeldCommentsForRevision`, `sendHeldCommentsOnRevisionRequest` | `aPromptToAPageAuthorCarriesItsHeldComments` | 5.6% (sent 2.2%, kept 3.9%) | weak | |
| A4 | Compaction replaces the rows before the turn with one recap. A failed summarization leaves the transcript whole. | `compactIfLarge` | `compactionReplacesOnlyEarlierRows` | turn property | guarded | |
| A5 | Every tool call in the transcript keeps its result. | `modelPass` onStep | `everyToolCallKeepsItsResult` | turn property | guarded | |
| A6 | In a person's turn, only `acknowledge` and `ask` are offered until one of them succeeds. | `prepareStep`, `activeToolNames` | `aPersonHearsBackBeforeAnyWork` | turn property | guarded | |
| A7 | The chat thread shows a working status per step and leaves it when the turn ends. | `stepStatus`, `Notifier.working`, `release` | `theWorkingStatusNeverOutlivesItsTurn` | turn property | guarded | |
| A8 | A person's turn that left them without a reply runs the model once more with a note that says so. | `generate` ask-again pass | `aPersonsTurnNeverEndsUnanswered` | turn property | guarded | |
| A9 | Closing text posts only as the answer to a person who wrote, once, and is withheld when the board change was the reply. | `generate`, `closingTextWithheld` | `closingTextAnswersOnlyAPersonWhoWrote` | turn property | guarded | |
| A10 | A model that fails twice posts the stuck text. The post goes to the workflow audience with an empty answer list, so in a workflow without a chat thread the session the person wrote from does not get it. | `conclude` | `aPersonsTurnNeverEndsUnanswered` counts the post, and the turn arm of `sessionMessageWithoutAnAuthorIsAnswered` exempts the stuck text | turn property | unguarded | |
| A11 | The turn deadline aborts the attempt and posts the timeout text. The same empty answer list applies. | `boundedAttempt`, `conclude` | `aWaitingPersonHearsBackByTheTimeout` | turn property | weak | Tracker-only delivery is exempt, as in A10. |
| A12 | A turn lost with its Durable Object resumes, posts the restart notice in chat, and answers what the lost turn owed. | `resumeLostTurn` | `aResumedTurnAnswersWhatItsLostTurnOwed` | turn property | guarded | #62 adds a model-turn deadline alarm beside it. |
| A13 | Tool results from MCP, `fetch_url`, `read_artifact` and `ready_issues` pass the screen. A quarantined or unchecked result is replaced by fixed text. | `screeningTools`, `screenText` | `quarantinedTextNeverEntersTheTranscript` | turn property | guarded | |
| A14 | `read_channel` screens each message. A flagged message does not remove another from the read. | `historyTools`, `screenMessages` | `aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead`, `quarantinedTextNeverEntersTheTranscript` | turn property | guarded | |
| A15 | A tool result over the context limit is replaced by its summarization under a marker, or by a fixed "too large" text. | `condensingTools` | property test in `condensed.property.test.medium.ts`, not an invariant | n/m | tested | |
| A16 | MCP connect failure is logged, and the turn runs without the MCP tools. | `loadTools`, `connectOrchestratorMcp` | | | unguarded | |
| A17 | Turn answers reach the chat thread and do not reach a session when a chat thread exists. Otherwise they reach the sessions people wrote from. | `turnRecipients`, `recipientsOf` | turn arm of `sessionMessageWithoutAnAuthorIsAnswered` | turn property | guarded | |

### Agent turn alarms

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| A20 | Heads-up alarm at 60 seconds posts "Still working on this." in chat and keeps the thread working, when a person's message was taken and the stamp still matches. | `onTurnHeadsUp` | `theWorkingStatusNeverOutlivesItsTurn` covers the status only. A rule does not check that a heads-up never posts after its turn ended. | turn property | unguarded | |
| A21 | Watchdog alarm at the turn timeout clears the turn, deletes taken rows and posts the timeout text. The hung turn keeps running, its tools keep acting, and its closing text can still post. | `onTurnTimeout` | `aWaitingPersonHearsBackByTheTimeout` checks the post. A rule does not check what a timed-out turn does afterwards. | turn property | unguarded | |
| A22 | The start step of a Durable Object with a stamped turn resumes the lost turn. A finished workflow only releases its threads. | `resumeLostTurn` | `aResumedTurnAnswersWhatItsLostTurnOwed` | turn property | guarded | |
| A23 | A backup "runAgent" alarm runs the turn if the in-process turn died before it started. | `tellAgent`, `runIfIdle` | | | unguarded | |
| A24 | A stale heads-up or watchdog alarm, whose stamp does not match, does not act. | `onTurnHeadsUp`, `onTurnTimeout` | | | unguarded | `staleAlarmIsIgnored` covers task alarms only. |

### Agent tools

| ID | Tool | What it can change | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| A30 | `acknowledge` | Thumbs-up on each taken chat message, or one line to the people who wrote. A failed reaction partway leaves some messages without it. | `aPersonHearsBackBeforeAnyWork`, `aPersonsTurnNeverEndsUnanswered` | turn property | guarded | |
| A31 | `ask` | Posts a question, and sets the workflow `waiting_input` when every author and researcher is idle. | `linearOnlyAsksReachTheStartingSession` (where it goes) | 17.6% (ask or failure case) | guarded | The move to `waiting_input` is T13. |
| A32 | `tell`, `stay_silent` | Posts info to the people who wrote, or stays quiet, and ends the turn. | `closingTextAnswersOnlyAPersonWhoWrote`, `aPersonsTurnNeverEndsUnanswered` | turn property | guarded | |
| A33 | `set_plan` | Sets the definition, stages, slots, repository, page parent and root page. Sets the workflow `running`, moves the origin issue to started, and can create the root page on the document host. | `workflowStartsOnlyFromAPlan`, `workflowKeepsItsDefinition` | 11.2% (start case 1.3%), 21.0% | guarded | The root page write is R37. |
| A34 | `start_job` | Inserts the job and task, binds the issue and branch in D1, claims the issue, links the chat thread, schedules the provision alarm, links the input page from the root page. | `jobStartsOnlyIntoAFreeSlot`, `oneLiveJobPerInputArtifact`, `eachIssueLinksTheChatThreadOnce`, `workflowStartsOnlyFromAPlan` | 41.6%, 4.0%, 33.0%, 11.2% | weak | `oneLiveJobPerInputArtifact` reach is under 5%. Cross-workflow hold is A35. |
| A35 | `start_job` refuses an issue or pull request another workflow holds. | `heldInput` | `oneLiveJobPerInputArtifact` checks one workflow only | | unguarded | |
| A36 | `complete_job` | Stores a selection, or advances a host-accepted artifact. Ends the author `done`, destroys its sandbox, cancels its refiner run, hands the artifact over. | `aFailedCheckNeverCompletesAJob`, `aFailedCheckNeverAsksThePersonAgain` | 12.2% | weak | The rule text says a job completes only on an accept or a select, but the check runs only when the decisions call failed. A completion after the model said "not accepted" is not checked. |
| A37 | `cancel_job` | Cancels the author or researcher: closes its feed, destroys its sandbox, cancels its refiner run, closes the artifact. | `finishedTaskKeepsItsStatus`, `artifactStatusMovesAreLegal`, `oneUnfinishedRefinerRunPerArtifact` | 56.2%, 22.3%, 22.2% | guarded | |
| A38 | `prompt_task` | Reads and screens held page comments, marks them read, and queues the prompt. Comments are marked read before the prompt is queued. | `aPromptToAPageAuthorCarriesItsHeldComments` | 5.6% | weak | #62 changes how a revise keeps its prompt. |
| A39 | `pause_task`, `resume_task` | Sets or clears the pause, sends a cancel to the harness session, posts "Paused" or "Resumed", and queues "Continue where you left off." on resume. Reports success on a no-op. | | | unguarded | #62 invariant 3 adds a paused outcome for a lost model turn. |
| A40 | `cancel_task` | Cancels a refiner run. A cancelled polisher hands the artifact over as it was left. | `oneUnfinishedRefinerRunPerArtifact`, `finishedTaskKeepsItsStatus` | 22.2%, 56.2% | guarded | The handover after a cancel is R12. |
| A41 | `request_review`, `finish_review` | Starts the reviewer segment from its first entry, or moves past the open entry to the next refiner or the handover. | `refinersRunAgainOnlyOnChangedRevision`, `oneUnfinishedRefinerRunPerArtifact`, `authorIsIdleWhileAPolisherRuns` | 0.9%, 22.2%, 5.7% | weak | A planted reviewer rerun on an unchanged revision survived. |
| A42 | `rule_on_review` | Approve moves on. Reject posts the signed reason on the artifact host and sends it to the author. | `judgeRulesAtMostOnce` | 3.2% | weak | A planted second ruling survived. |
| A43 | `finish_workflow` | Sets `done`, posts the done event, moves tracker issues to completed, removes code host bindings. Refuses while an author or researcher is active. | `endedWorkflowHasNoUnfinishedTask`, `nothingReopensAFinishedWorkflow` | 21.0%, 12.7% | guarded | The issue moves are K8. |
| A44 | `fail_workflow` | Cancels every active task and refiner run, sets `failed`, posts the failure, removes code host bindings. | `endedWorkflowHasNoUnfinishedTask`, `linearOnlyAsksReachTheStartingSession` | 21.0%, 35.1% | guarded | |
| A45 | `move_into_root_page` | Moves a page under the root page on the document host and drops its link. | | | unguarded | |
| A46 | MCP tracker tools (`save_issue`, `save_comment`, `save_project`, `save_milestone`, `save_status_update`) | Write to the tracker with only prompt rules. A result the screen does not admit reads to the model as not given, though the write happened. | | | unguarded | |
| A47 | Read tools: `status`, `read_task`, `read_log`, `list_repositories`, `read_artifact`, `ready_issues`, `read_channel`, `fetch_url` | Read only. Screened where the text comes from outside. | `quarantinedTextNeverEntersTheTranscript` | turn property | guarded | |

### Agent external calls

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| A50 | The main model request retries once per turn and fails into the stuck text. A hang ends at the turn deadline. | `generateSteps`, `attempt`, `withRequestTimeout` | `aPersonsTurnNeverEndsUnanswered`, `aWaitingPersonHearsBackByTheTimeout` | turn property | guarded | |
| A51 | A decisions call that fails, hangs or lacks a gateway returns its site's fallback. The fallback of the acceptance and selection checks keeps the job open. | `askDecisions` and callers | `laterDecisionsCallsFallBackOnceOneFails`, `aFailedCheckNeverCompletesAJob` | turn property, 12.2% | guarded | |
| A52 | A failed model list for a requested runtime reads to the person as "matched none clearly". | `loadModelSources`, `requestedRuntime` | | | unguarded | |
| A53 | A host acceptance lookup that throws reads as "not accepted". | `acceptancePending` | | | unguarded | |

## Refiners, reviews and handover

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| R1 | Refiners settle only once the author is quiet and the checks gate is open. Each settle reads the store again after the host read. | `settleRefinersForAuthor` | `authorIsIdleWhileAPolisherRuns`, `oneUnfinishedRefinerRunPerArtifact` | 5.7%, 22.2% | weak | A planted "author prompted while a polisher runs" bug was caught in about 55% of runs. |
| R2 | An artifact has at most one unfinished refiner run, and the artifact points at it. | `startRefiner` | `oneUnfinishedRefinerRunPerArtifact` | 22.2% | guarded | |
| R3 | A refiner run starts on an artifact the humans hold only after an author turn ended on a changed revision. | `reopenChangedArtifact`, `runRefinersFrom` | `refinersRunAgainOnlyOnChangedRevision` | 0.9% | weak | A planted rerun on an unchanged revision survived. |
| R4 | A reviewer does not run again on a revision it already reviewed while the artifact is drafted. | `runRefinersFrom`, stale segment restart in `onReviewerFinished` | `refinersRunAgainOnlyOnChangedRevision` skips drafted artifacts | | unguarded | |
| R5 | A findings reviewer entry runs at most `max_review_runs` times on one artifact. The limit adds the unreviewed revision note at handover. A stale segment restart does not count against the limit. | `reviewLimitReached`, `unreviewedRevisionNote` | | | unguarded | |
| R6 | A judge rules at most once on an artifact, and its ruling never changes. Judge entries that ruled are skipped on later runs. | `settleJudgeEntry`, `applyJudgeRuling`, `judgeRuledOn` | `judgeRulesAtMostOnce` | 3.2% | weak | A planted second ruling survived. A concurrent `rule_on_review` during the decisions call can apply a second ruling. |
| R7 | A judge conclusion is ruled by the decisions model. A missing conclusion, a failed call or a middle probability asks a person to rule. | `ruleOnConclusion`, `askPersonToRule` | | | unguarded | |
| R8 | A refiner run ends `done` only after its turn ended normally. A polisher waiting on the checks of its push ends later, only if it did not take a prompt since. | `finishRefinerRun`, `endPolisherRun` | `refinerRunIsDoneOnlyAfterItsTurnEnded` | 9.5% | guarded | |
| R9 | A model-call author's closing text is read by the review again decision. An answer of yes reruns the segment, and an answer of no advances. A failed call asks the agent to route. | `routeByClosingText`, `authorAskedForReview` | | | unguarded | |
| R10 | A harness author's review is routed by the agent with `request_review` or `finish_review`. The agent is told again on every settle until it routes. | `askAgentToRoute` | | | unguarded | |
| R11 | A segment merges the latest reviews of its entries and sends the merged review to the author when it holds findings or blocks. A clean or empty segment advances. | `segmentReview`, `mergeReviews`, `sendReviewToAuthor` | `authorGetsEveryPageFinding` (pages only, proposed) | n/m | weak | |
| R12 | The handover moves the artifact from drafted to ready once, records the delivered revision, posts `artifact_ready` and arms the idle alarm. Blocked paths hand over with a reason. | `markArtifactReady` | `deliveredToHumansIsNeverCleared`, `artifactStatusMovesAreLegal`, `inReviewTaskHasAnArtifact` | 25.4%, 22.3%, 27.0% | guarded | A rule does not check that every exhausted list, cancel or failure hands the artifact over. See R13. |
| R13 | A cancelled judge run leaves the artifact drafted with its pointer until the agent routes it. A failed reviewer hands over blocked. A cancelled or failed polisher hands over blocked. | `cancelTask`, `onReviewerFailed`, `endPolisherRun` | | | unguarded | |
| R14 | An author turn that ends on a ready artifact with a changed or unreadable revision reopens it to drafted and reruns the refiners. A stage without refiners posts `artifact_ready` again. | `reopenChangedArtifact`, `announceReopenedDraft` | `artifactStatusMovesAreLegal`, `refinersRunAgainOnlyOnChangedRevision` | 22.3%, 0.9% | weak | |
| R15 | A pull request review read that fails reads as if the reviewer did not file a review, and the segment advances as if clean. | `readReview` in `artifact/pull` | | | unguarded | |
| R16 | A reviewer that failed or gave up restarts while it has restarts, then the artifact is handed over blocked. | `endRefinerTurn`, `onReviewerFailed` | `finishedTaskKeepsItsStatus` | 56.2% | guarded | |

### Polish and checks

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| R20 | The author does not take a prompt while a polisher runs. | `drainQueue`, `polisherRefusal` | `authorIsIdleWhileAPolisherRuns` | 5.7% | weak | See R1. |
| R21 | The checks gate waits for checks on the pushed revision: passed checks stand 60 seconds, unreported ones wait 5 minutes, running ones wait up to 2 hours, then blocked. Failed checks or a conflict go back to the pusher once per revision. | `readGate`, `checksGate` | | | unguarded | |
| R22 | An unreadable revision opens the checks gate, so the refiners and the handover skip CI. | `readGate` | | | unguarded | |
| R23 | The `recheck` alarm ticks every 60 seconds while the gate waits and stops when it opens, blocks, or the workflow ends. | `recheckChecks` | | | unguarded | The generator fires `recheck` timers. The generator does not fire a stale variant. |
| R24 | While the humans hold the artifact, failed checks or a conflict go to an idle author once per revision. A conflict with a finished author tells the agent. Failed checks with a finished author are dropped. | `followUpWithIdleAuthor`, `sendFailedChecksBack`, `sendConflictBack` | | | unguarded | |
| R25 | A follow-up starts when a prompt reaches an idle author while the humans hold the artifact. The board moves to the end of the thread. | `startFollowUp` | | | unguarded | |

### Writes to the artifact host

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| R30 | A pull request reviewer posts its own review with its own token. | review prompt, reviewer sandbox | | | unguarded | |
| R31 | A page review posts each finding with a passage as an inline comment, then one outcome comment with the review line. A failed inline comment moves into the outcome comment. The post happens before the check that the run still owns the artifact. | `postPageReview`, `fileReview` | `pageReviewPostsEachFindingOnce` (proposed) | n/m | weak | |
| R32 | A judge rejection posts the signed reason on the pull request or page, or in the thread for issues. A failed post is logged, and the author still gets the rejection. | `applyJudgeRuling`, `postRejection` | | | unguarded | |
| R33 | Person feedback on a pull request gets the eyes reaction per comment, or "Relayed to the author." when it lacks comment handles, before routing. One failure skips the rest. | `pull.acknowledge` | | | unguarded | |
| R34 | A page comment is acknowledged with the eyes reply when it is sent to the author. | `page.acknowledge` | `aPromptToAPageAuthorCarriesItsHeldComments` | 5.6% | weak | |
| R35 | A model-call author's revise posts one comment reply per handled comment before it writes the page. A failed reply fails the task, and replies already posted stay. | `revisePage` | `sentCommentIsAnsweredBeforeItsLineGoes`, `replyGoesOnlyToASentComment`, `failedReplyLeavesThePage` (page revision world, proposed) | n/m | weak | #62 notes a restart after the write can post replies twice. |
| R36 | A page text change keeps the identity of every line the answer left alone. | `revisePage`, `updatePageContent` | `untouchedLinesKeepTheirIdentity` (page revision world, proposed) | n/m | weak | |
| R37 | The root page holds a resources section that code writes: a heading, one link line per linked page, and the link removed when a page moves under the root page. The author text goes above it. | `nameRootPage`, `createRootContainer`, `linkFromRootPage`, `moveIntoRootPage` | | | unguarded | |

### Inbound events in the workflow

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| E1 | Every feedback event on a running workflow gets one routing decision: author, agent, or `nobody`. A failed decisions call routes to the agent. | `onFeedback`, `feedbackRoute` | `everyFeedbackGetsOneRoutingDecision` | 8.2% | guarded | |
| E2 | Feedback the screen does not admit reaches neither the agent nor the author. | `onFeedback` | `unadmittedFeedbackReachesNobody` | 2.1% | weak | |
| E3 | A pull request review claims its review id only when the host read succeeds. On a failed read, the review and its comments can each prompt the author. | `reviewChange` | | | unguarded | |
| E4 | A page comment that does not mention the bot stays held. A mention sends every held comment with it as one feedback. | `commentChange`, `onMentioned` | `aPromptToAPageAuthorCarriesItsHeldComments` | 5.6% | weak | |
| E5 | A finished workflow ignores events: a stop still stops the author, a status gets the summary, anything else gets "This workflow is X". | `replyFinished` | `nothingReopensAFinishedWorkflow`, `endedWorkflowHasNoUnfinishedTask` | 12.7%, 21.0% | guarded | |
| E6 | A message wakes a workflow from `waiting_input` to `running` and rearms the idle alarm. | `handleEvent`, `armIdle` | | | unguarded | |
| E7 | A stop clears the author's queue, cancels its turn or ends a starting turn, and closes the feed with "Stopped.". The workflow does not change, and the orchestrator does not post. | `stopSessionAuthor`, `stopAuthor` | `stopEndsTheAuthorsTurn`, `stoppedModelCallLeavesThePage` | 20.7%, 0.8% | weak | `stoppedModelCallLeavesThePage` reach is under 5%. |
| E8 | Control words cancel, pause, resume and instruct. Cancel ends the workflow or the one job on a non-origin issue. Non-cancel words act only when one author or researcher is active. In a session with a running author, the words go to the author as a prompt. | `parseControl`, `controls` | `endedWorkflowHasNoUnfinishedTask` for cancel | 21.0% | unguarded | Pause, resume and instruct are not checked. |
| E9 | A pull request opened records the artifact and settles refiners. Marked ready cancels the refiner run and hands over. Merged accepts the artifact and tells the agent. Closed unmerged removes it and cancels the author. Reopened does not change the artifact. | `onOpened`, `onHostReady`, `onAccepted`, `onClosed` | `artifactStatusMovesAreLegal` | 22.3% | guarded | A merge does not cancel a running polisher. |
| E10 | A check or base branch event settles the checks of each matched job. | `onChecks`, `jobsForEvent` | | | unguarded | |
| E11 | An event that does not match a job adds a note. One that matches several active jobs asks the agent which. | `noMatchingJobNote` | | | unguarded | |
| E12 | A deleted page is noticed only when `start_job` checks the earlier output. | `removedOnHost` | | | unguarded | |

## Boards and chat output

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| C1 | Each job gets one board in each chat thread the workflow replies to. A tracker session never holds one. | `flushOne`, `boardChannels` | `boardsLiveOnlyInChat` | 45.9% | guarded | |
| C2 | The rendered board shows each researcher and author as its todo list or its work line. | `renderBoard`, `boardInputOf` | `everyJobTaskIsOnItsBoard` | 89.1% | guarded | The rule checks the rendered body, not the message the chat holds. See C4. |
| C3 | A researcher's todo list reads complete once the author of its job exists. | `completeTodos` | `researchReadsCompleteOnceTheAuthorStarts` | 1.6% | weak | |
| C4 | A board post or edit that fails is retried only on the next flush, and the flush is not scheduled. The chat can hold a stale or missing board until something else changes on the job. | `createBoard`, `publishBoard`, `markBoardDirty` | | | unguarded | |
| C5 | A board is created once per job and thread. An isolate lost between the post and the row update posts a second board on the next flush. | `insertBoard`, `createBoard` | | | unguarded | |
| C6 | A board a person deleted is posted again once. A second delete leaves it deleted. | `onEditFailure` | | | unguarded | |
| C7 | A follow-up moves the board to the end of the thread: post a new board, then delete the old one or edit it to a pointer. | `relocateBoard`, `relocateBoards` | | | unguarded | |
| C8 | The `board_flush` alarm coalesces changes into one edit per 10 seconds. Edits happen only when the body hash changes. | `markBoardDirty`, `flushBoards` | | | unguarded | The generator fires `board_flush` timers. |
| C9 | A board note shows a restart reason or a prompt error until the turn ends. | `restartOrFailTask`, harness `turn` | | | unguarded | |
| C10 | With a chat thread, every post goes to the chat threads and does not reach a tracker session. | `recipientsOf` | `orchestratorStaysOutOfSessionsWhenChatExists`, turn arm of `sessionMessageWithoutAnAuthorIsAnswered` | 4.9%, turn property | weak | |
| C11 | A chat post that fails writes a delivery error row and is not retried. The post still counts as posted, so the thread may not be released. | `Notifier.post`, `postedCount`, `releaseIfSilent` | | | unguarded | |
| C12 | After a chat post outside a turn, the thread status goes to active, or closed when the workflow finished. | `setChatSession` | | | unguarded | A7 covers the status after an agent turn. |
| C13 | The sleep message posts after the idle hours while the workflow runs and every author and researcher is idle. The workflow moves to `waiting_input`. | `onIdle` | `sleepMessageOnlyDuringAWorkflow` | 2.4% (posting case), 31.3% (outside case) | weak | |
| C14 | A failed task posts "❌ reason". A failed workflow posts the failure and the "tag me again" line. | `restartOrFailTask`, `failWorkflow` | `linearOnlyAsksReachTheStartingSession` checks where a failure goes. A rule does not check that every failure posts. | 35.1% | unguarded | |
| C15 | A finished workflow posts "Done." with the result. | `completeWorkflow` | | | unguarded | |
| C16 | Controls post "Cancelled.", "Paused", "Resumed" or "Not authorized.". | `inbound/controls` | `nothingReopensAFinishedWorkflow` covers a finished workflow only | 12.7% | unguarded | |
| C17 | A reply target on a document page gets a page comment. | `Notifier.toDocuments` | | | unguarded | |
| C18 | The chat eyes reaction marks a delivery slower than 3 seconds and comes off when it settles. The caller gets what the delivery gave. | `deliverWithChatAck` | `eyesNeverOutliveTheDelivery`, `eyesMarkOnlyASlowChatDelivery`, `theCallerGetsWhatTheDeliveryGave` | chat-ack property | guarded | |
| C19 | A received chat message sets the thread to its working status. | `Notifier.acknowledge` | | | unguarded | |

## Tracker output

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| K1 | Without a chat thread, the starting session gets every ask and failure and only those. A session gets an answer only where a person wrote. | `recipientsOf`, `Notifier.toTracker` | `linearOnlyAsksReachTheStartingSession` | 35.1% | guarded | |
| K2 | The author's completed tool calls post to its job session as activities, once each. | `streamToSessionFeed` | `feedActivityPostsOnce` | 4.2% | weak | |
| K3 | A turn that leaves its author idle ends the session feed with a reply or an error. A stop ends it with "Stopped.". | `closeSessionFeed`, `closeAbandonedTurnFeed` | `sessionFeedEndsWhenItsAuthorIdles`, `stopEndsTheAuthorsTurn` | 7.3%, 20.7% | guarded | |
| K4 | A feed post retries three times with the same activity id, then is dropped. | `streamToSessionFeed` | `feedActivityPostsOnce` | 4.2% | weak | |
| K5 | The author's todo list becomes the session plan only when the workflow lacks a chat thread. | `publishSessionPlan` | `chatWorkflowNeverSetsASessionPlan` | 2.8% | weak | A rule does not check that a workflow without a chat thread gets the plan. |
| K6 | The router posts "On it. Reading the issue." when a tracker session starts work. | `postStartingThought` | | | unguarded | |
| K7 | A start without an authorized actor gets "No workflow is working on this issue. Delegate it to me or mention me to start one.", after the starting thought. | `postTrackerAck` | | | unguarded | |
| K8 | A job start claims its issue: started state and delegation to the app user. The plan moves the origin issue to started. A done workflow moves tracker issues to completed. A failed or cancelled workflow does not move them. | `claimIssue`, `moveIssue` | `workflowStartsOnlyFromAPlan` checks that the issue does not move before the plan | 11.2% | unguarded | A rule does not check the claim or the completed move. |
| K9 | A chat workflow links each worked issue to its chat thread once. | `linkChatThread`, `attach_chat_thread` | `eachIssueLinksTheChatThreadOnce` | 33.0% (two issues 3.5%) | guarded | |
| K10 | A session message to a running author goes to that author as a prompt, does not post, and does not wake a turn. | `inbound/job-session` | `sessionMessageReachesItsRunningAuthorSilently` | 2.8% | weak | #62 tightens the clause for a model-call author. |
| K11 | A session message without a running author gets an agent turn or a reply. | `inbound/events` | `sessionMessageWithoutAnAuthorIsAnswered` | 22.1% | guarded | |

## Router, identity and install

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| O1 | An event joins the first running workflow bound to one of its bindings. | `routeOf`, `findBinding` | | | unguarded | |
| O2 | A start event that joins a running workflow rebinds every binding it carries to that workflow, including a binding another running workflow holds. | `joinOrHandle` | | | unguarded | |
| O3 | A person's message on a binding whose workflow ended starts exactly one new workflow, and the binding moves to it. Other events on an ended workflow are dropped. | `routeOf`, `startNextWorkflow`, `claimBinding` | `messageAfterEndStartsNextWorkflow` | router property | guarded | |
| O4 | A failed Durable Object create rolls back the new bindings and marks the workflow failed. | `abandonWorkflow` | | | unguarded | |
| O5 | A push to a base branch fans out to every workflow with a pull request in the repository. A failed delivery stops the rest. | `fanOutBaseMoved` | | | unguarded | |
| O6 | The D1 workflow status mirrors the Durable Object status. The router reads it to decide whether a workflow ended. | `changeWorkflowStatus` | | | unguarded | |
| O7 | A workflow that ends removes its code host bindings and keeps chat, issue and session bindings. | `unbindCodeHost` | | | unguarded | |
| O8 | Access: a tracker user must be in the tracker team, a chat user in the chat team or joined by email to a tracker team member, a document user joined by email, a code user able to push. Any App passes. A failed lookup refuses. | `Identity`, `resolveCodeActor` | | | unguarded | |
| O9 | An unauthorized person's message does not start work. A prompt from an unauthorized person on a running workflow still reaches the workflow, which ignores it for controls. | `deliver`, `inbound/controls` | | | unguarded | |
| O10 | Persons rows are upserted and merged by email before the access check. | `upsertPerson`, `mergePersons` | | | unguarded | |
| O11 | A repeated event id is dropped once per workflow. A base move copy gets the workflow id appended. | `markEventSeen`, `fanOutBaseMoved` | | | unguarded | |
| O12 | The tracker install link mints a single-use state. The callback consumes it, exchanges the code, refuses a second workspace, and saves the tokens. | `linearInstallUrl`, `completeLinearInstall` | | | unguarded | |
| O13 | A tracker token refresh spends the refresh token with compare-and-set. The loser adopts the stored tokens. A failed refresh keeps the old token while it is valid. | `InstallToken.refresh`, `updateLinearTokens` | | | unguarded | |
| O14 | A sandbox bridge dial to a workflow without a row gets 404. | orchestrator `fetch` | | | unguarded | |

## Ingress routes

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| I1 | Linear webhook: HMAC and a 60 second timestamp window, then the mapper, then one delivery. A bad signature gets 401. | `routes/linear` | | | unguarded | In progress: `badSignatureNeverDelivers`. |
| I2 | GitHub webhook: HMAC on the raw body without a timestamp window, then one delivery. A missing delivery id gets a random event id. | `routes/github` | | | unguarded | In progress: `badSignatureNeverDelivers`. |
| I3 | Slack webhook: HMAC and a 300 second window. The route answers 200 at once and maps and delivers after the reply. Every Slack retry is dropped. A failed delivery is only logged. | `routes/slack` | | | unguarded | In progress: `badSignatureNeverDelivers`. |
| I4 | Slack greeting when the app joins a channel. | `handleCallback`, `GREETING` | | | unguarded | |
| I5 | Notion webhook: an unsigned handshake while the token is unset, then HMAC without a window. Only `comment.created` maps. The mapper fetches the comment before delivery. | `routes/notion` | | | unguarded | In progress: `badSignatureNeverDelivers`. |
| I6 | Linear OAuth callback relies on the single-use state. | `routes/linear-oauth` | | | unguarded | |
| I7 | Admin install link and debug dumps need the admin token. The dumps answer 404 unless debug is on. | `routes/admin` | | | unguarded | |
| I8 | Bridge WebSocket upgrades pass to the orchestrator, which checks the bridge token. | `routes/bridge`, `bridgeTokenOf` | | | unguarded | |

## Inbound mappers

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| M1 | Slack: a mention becomes `start`, or `status` for a bare status question in a thread. A thread reply becomes `prompt` or `status`. A check mark reaction becomes `prompt`. Edits, bots, the app itself, Slack Connect channels and tags of other people are ignored. | `slackInbound` | | | unguarded | In progress: `inboundMapperNeverThrows`. |
| M2 | GitHub: pull request opened, ready, closed or reopened become `pr_event`. Reviews, review comments and pull request comments become `feedback`. Check suites and failed check runs become `ci_event`. A push to the default branch becomes `base_moved`. Forks, foreign branches, bots and the app's own reviews are ignored. | `githubInbound` | | | unguarded | In progress: `inboundMapperNeverThrows`. |
| M3 | GitHub: one review with N inline comments arrives as N+1 feedback events. A failed check arrives as two `ci_event`s. | `githubReviewEvent`, `githubCheckRunEvent` | | | unguarded | |
| M4 | Linear: a session created becomes `start`. A session prompt becomes `stop` on the stop signal, else `prompt` or `status`. A document comment becomes `feedback`. An issue moved to canceled or completed by a person becomes `control` cancel. Other workspaces are ignored. | `linearInbound` | | | unguarded | In progress: `inboundMapperNeverThrows`. |
| M5 | Notion: a page comment becomes `feedback` after a fetch. The mapper does not filter the bot's own comments. The resolver drops them because a bot lacks an email. | `notionInbound` | | | unguarded | |

## Adapter writes and external calls

| ID | Effect | Where | Guarded by | Reach | Status | Open work |
|---|---|---|---|---|---|---|
| X1 | Slack thread replies split into chunks. A failure partway leaves the first chunks posted. Every Slack write throws on error. | `SlackChat` | | | unguarded | |
| X2 | Linear issue updates, activities, plans and thread sync throw on an error. A repeated activity id is swallowed so the post is idempotent. The SDK `success` flag is not read. | `LinearTracker` | | | unguarded | |
| X3 | GitHub writes are a pull request comment, a comment reaction and token minting. Paged reads stop at 10 pages and repository lists at 100. | `GithubCodeHost` | | | unguarded | |
| X4 | Notion page create, page text change, move, rename, comment, acknowledgement and reply throw on error. Inline findings swallow a per-block error and come back unposted. Not found reads as a removed page. | `NotionDocuments` | | | unguarded | |
| X5 | A page text change plans at most 100 edits that each match once and turn the read text into the revised text. | `planPageTextUpdate` | four property tests in `page-text-update.test.ts` | n/m | tested | |
| X6 | Linear document text change is a read-modify-write of the whole content. A person's edit between the read and the write is lost. | `LinearDocuments.updatePageContent` | | | unguarded | |
| X7 | Held comments: a person comment without a later bot acknowledgement in its discussion. The bot's own comments are never held. | `notionHeldComments`, `linearHeldComments` | property tests in `held-comments.test.ts` | n/m | tested | |
| X8 | Decisions calls try each configured model in order with per-attempt deadlines. Cloudflare throws on a missing probability and moves to the next model. OpenRouter reads it as 0. | `decide` in each gateway | `aDecisionsCallFallsBackOnlyAfterEveryModelFailed` checks the orchestrator side over a scripted gateway, not the gateways | | unguarded | |
| X9 | `fetch_url` follows redirects with a 20 second timeout and a 512 KB cap. | `HttpWeb.readPage` | | | unguarded | |
