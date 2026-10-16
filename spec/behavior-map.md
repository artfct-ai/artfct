# Behavior map

This file lists each effect a person sees or the system relies on, and the invariants that guard it. A scheduled audit compares the code against it.

Effects use the terms of the glossary. A guard is the exact function name of an invariant. A row with an empty guard list is unguarded.

The workflow invariants live in `packages/orchestrator/test/invariants.ts`. The agent turn invariants live in `packages/orchestrator/test/agent-invariants.ts`. The router, chat acknowledgement and page revision invariants live beside them. The router binding invariants live in the Quint spec at `spec/router-bindings/routerBindings.qnt`. The webhook invariants live in `packages/ingress/test/webhook-invariants.ts`, and the inbound mapper invariants in `packages/adapters/test/inbound-invariants.ts`.

## Workflow, tasks and statuses

| ID | Effect | Guarded by |
|---|---|---|
| T1 | A job and its task start only into a free slot, and only after the plan started the workflow. A harness task also gets a sandbox row. | `jobStartsOnlyIntoAFreeSlot`, `workflowStartsOnlyFromAPlan` |
| T2 | Only one live job works from one input artifact in a workflow. An unfinished job holds its input. A finished job holds it while its output exists, unless that output is the input itself. | `oneLiveJobPerInputArtifact` |
| T3 | A job start on an issue points the issue's binding at its workflow before it writes the job. A job start writes the job and its task before the router's status and branch binding writes. A failed router write leaves a `queued` task without a provision alarm. | |
| T4 | A sandbox start moves the task to `provisioning` with a new generation and bridge token, and clears the session state. | |
| T5 | The first bridge hello moves the task to `working`. | |
| T6 | A model-call author is `working` only while its model turn is in flight, or after a stop ended its first turn before the page existed. | `aModelCallAuthorWorksOnlyWhileItsCallIsOut` |
| T7 | An author moves to `in_review` only when its job has an artifact, a prompt is not in flight, and its handshake is not pending. It leaves `in_review` only for a prompt. | `inReviewTaskHasAnArtifact`, `anAuthorInReviewWorksOnlyWithAPrompt` |
| T8 | A finished task (`done`, `failed`, `cancelled`) never changes status again. A restart or a completion that finds the task finished when it reads it again leaves it finished. A stop writes its stopped state before it awaits the destroy, so a destroy that returns late writes nothing. | `finishedTaskKeepsItsStatus` |
| T9 | A failed author or researcher closes its review as blocked, posts `failed`, and wakes the agent. A failed reviewer or polisher hands the artifact over blocked. | |
| T10 | A cancelled author or researcher closes its review as blocked, flushes the board, and tells the agent. | `finishedTaskKeepsItsStatus`, `endedWorkflowHasNoUnfinishedTask` |
| T11 | Each usage update replaces a harness task's cost. A restart can lower the reported cost. | |
| T12 | The workflow is `running` after the plan, a job start, or a person's message on a `waiting_input` workflow. | `workflowStartsOnlyFromAPlan` |
| T13 | The workflow moves to `waiting_input` on the sleep message or on `ask`, only while every author and researcher is idle. | `workflowWaitsOnlyWhileNoAuthorWorks` |
| T14 | A workflow that is `done`, `failed` or `cancelled` keeps that status and every task finished, and an event does not reopen it. While the workflow ends, `set_plan`, `start_job`, `finish_workflow`, `fail_workflow` and a cancel are refused. | `endedWorkflowHasNoUnfinishedTask`, `nothingReopensAFinishedWorkflow`, `finishedWorkflowKeepsItsStatus` |
| T15 | A later plan cannot change the workflow definition. | `workflowKeepsItsDefinition` |
| T16 | An artifact is recorded as `drafted` from a link in the turn text, an open pull request on the branch, or a created page. Its todo list is complete and fixed from then on. A researcher never records one. | `todoListIsFixedAfterFirstArtifact` |
| T17 | An artifact status moves only along the legal moves, and `accepted` and `removed` are final. | `artifactStatusMovesAreLegal`, `anAcceptedArtifactNeverMovesBack` |
| T18 | The first handover sets the time the humans got the artifact, and it is never cleared. | `deliveredToHumansIsNeverCleared` |
| T19 | A harness author moves to `working` only when a prompt goes out for it. | |
| T56 | Every event, alarm and tool call settles within a bounded amount of store work. A loop that never settles does not hang the workflow. | `everyActionSettlesWithinItsWorkBudget` |

### Restart, nudge, give up and fail

| ID | Effect | Guarded by |
|---|---|---|
| T20 | A task restarts at most twice, whatever the cause, then fails. The count lives on the task and covers harness and model-call tasks. A restart whose container closed after another restart counted, or after a newer generation began, is dropped. | `taskRestartsAtMostTwice` |
| T21 | Recovery of a lost harness turn starts a fresh sandbox without counting a restart. A sandbox that keeps dying mid-turn restarts without a limit. | |
| T22 | A harness process exit counts a restart and starts a fresh sandbox. It does not close the container, write the board note, or tell the agent. | |
| T23 | A sandbox start that throws restarts or fails. A spec error, a gateway error or a stage the definition stopped declaring fails at once. A start of an older generation that throws changes nothing. | `aFailedSandboxStartRestartsOrFails`, `taskRestartsAtMostTwice` |
| T24 | After the hello, the handshake runs without a timer. An `initialize` or `session/new` that never answers leaves the task `working` without an alarm until the socket closes. | |
| T25 | A stalled author gets one nudge. A second stall restarts it. | `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` |
| T26 | An author turn the decisions model reads as blocked queues the gave up text and restarts or fails. A failed decisions call falls back to a heuristic. The outcome of a turn of an older generation is dropped. | `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone`, `anAuthorInReviewRunsNoTurn` |
| T27 | A researcher or refiner turn that gave up or stopped on a limit restarts or fails. | |
| T28 | A researcher's payload passes to its author. A missing or oversized payload restarts or fails the researcher. | `researchReadsCompleteOnceTheAuthorStarts` |
| T29 | A prompt RPC error clears the prompt, writes a board note, and wakes the agent for an idle author. A researcher or refiner drains its queue or restarts. | |
| T30 | A model-call author fails without a restart on a model error, an empty answer, a missing closing text, a comment reply that does not validate, or a page host error. | |
| T31 | A model turn that a restart or its deadline cut runs again as a restart. A revise keeps its prompt queued until it applies the answer. An author with its page out goes back in review and takes that prompt. One without its page produces it again. A paused author stays paused. Past the restart limit the task fails with a post to the person. | `aRestartDoesNotLoseAModelTurn` |
| T32 | A prompt queued for an unpaused model-call author reaches it. A model turn is in flight, the author is starting, or a polisher holds its page. | `aQueuedPromptReachesItsModelCallAuthor` |
| T33 | A restart after the host wrote the page but before the store recorded it runs the turn again. A first turn creates a second page. A revise runs again on the revised text and can post its comment replies twice. | |

### Task alarms

| ID | Effect | Guarded by |
|---|---|---|
| T40 | The provision alarm starts the task only while it is still `queued`. A model-call task runs its first model turn. | |
| T41 | The `no_progress` alarm ignores a stale generation, an idle, finished or paused task. Without a socket it recovers the lost turn. Otherwise it nudges or restarts. | `staleAlarmIsIgnored`, `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone` |
| T42 | The wall clock alarm fails a task whose turn ran past the limit, without a restart. It belongs to the task, not to a generation. | |
| T43 | The hello timeout restarts or fails a task that never said hello. While the start is still awaited in this isolate it rearms without a limit. | `staleAlarmIsIgnored` |
| T44 | The keep alive chain keeps an active sandbox awake and stops when the task is idle or finished. A restart that another restart made stale does not stop it. | `staleAlarmIsIgnored`, `aRunningTurnKeepsItsSandboxAwake` |
| T45 | The queue retry alarm drains a prompt queued while the bridge was briefly closed. | `staleAlarmIsIgnored` |
| T46 | The bridge lost alarm recovers the turn of a socket that closed with a prompt in flight and did not reconnect. | `staleAlarmIsIgnored` |
| T47 | The token refresh alarm mints a new workflow repo token before expiry and retries every 60 seconds without a limit. A first mint that fails starts the sandbox without a token and does not arm a refresh. | |
| T48 | The idle alarm posts the sleep message. | `sleepMessageOnlyDuringAWorkflow` |
| T49 | The model turn deadline alarm fires 20 minutes after a model turn starts, and at once for every model turn in flight when the Durable Object starts. An alarm of an older turn does not act. | `staleAlarmIsIgnored`, `aRestartDoesNotLoseAModelTurn` |

### Task external calls

| ID | Effect | Guarded by |
|---|---|---|
| T50 | The bridge accepts a dial only with the task's bridge token. A newer socket closes the older one. | |
| T51 | Every harness permission request is allowed. Other agent requests get method not found. | |
| T52 | A sandbox destroy that fails is logged and ignored. A bridge process check that fails reads as running. | |
| T53 | A token mint that fails starts the sandbox without the token. A failed all-repos read token only narrows access. | |
| T54 | A model call of a model-call author has a 13 minute deadline. A stop or a finished task before the answer leaves the page as it was. | `stoppedModelCallLeavesThePage` |
| T55 | A page model answer that is blank or throws fails the task. | |

## Orchestrator agent turn

| ID | Effect | Guarded by |
|---|---|---|
| A1 | Every inbox row a turn takes moves into the transcript once and leaves the inbox, also when the model fails or the turn times out. | `everyInboxRowReachesTheTranscriptOnce` |
| A2 | The decisions model reads a person's message: owed reply, requests work, asks for a revision, requested runtime, input artifact. A failed call falls back to an unread message, and every later decisions call of the turn falls back too. | `laterDecisionsCallsFallBackOnceOneFails`, `aDecisionsCallFallsBackOnlyAfterEveryModelFailed`, `aPersonGetsTheAnswerDuringADecisionsOutage` |
| A3 | A message that asks for a revision sends the held comments of every running page author before the model runs. Unreadable or unadmitted comments stay held, and the agent is told. | `aPromptToAPageAuthorCarriesItsHeldComments` |
| A4 | Compaction replaces the rows before the turn with one recap. A failed summarization leaves the transcript whole. | `compactionReplacesOnlyEarlierRows` |
| A5 | Every tool call in the transcript keeps its result. | `everyToolCallKeepsItsResult` |
| A6 | In a person's turn, only `acknowledge` and `ask` are offered until one of them succeeds. | `aPersonHearsBackBeforeAnyWork` |
| A7 | The chat thread shows a working status per step and leaves it when the turn ends. A turn the watchdog already answered releases the thread when it ends. | `theWorkingStatusNeverOutlivesItsTurn` |
| A8 | A person's turn that left them without a reply runs the model once more with a note that says so. | `aPersonsTurnNeverEndsUnanswered` |
| A9 | Closing text posts only as the answer to a person who wrote, once, and is withheld when the board change was the reply. A resumed turn keeps the board change of the lost turn on a person's message. | `closingTextAnswersOnlyAPersonWhoWrote` |
| A10 | A model that fails twice posts the stuck text. The post goes to the workflow audience with an empty answer list, so in a workflow without a chat thread the session the person wrote from does not get it. | |
| A11 | The turn deadline aborts the attempt and posts the timeout text. The same empty answer list applies. | `aWaitingPersonHearsBackByTheTimeout` |
| A12 | A turn lost with its Durable Object resumes, posts the restart notice in chat, keeps the lost turn's board change, and answers what the lost turn owed. | `aResumedTurnAnswersWhatItsLostTurnOwed`, `closingTextAnswersOnlyAPersonWhoWrote` |
| A13 | Tool results from MCP, `fetch_url`, `read_artifact` and `ready_issues` pass the screen. Fixed text replaces a quarantined or unchecked result. | `quarantinedTextNeverEntersTheTranscript` |
| A14 | `read_channel` screens each message. A flagged message does not remove another from the read. | `aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead`, `quarantinedTextNeverEntersTheTranscript` |
| A15 | A tool result over the context limit is replaced by its summarization under a marker, or by a fixed "too large" text. | |
| A16 | A failed MCP connect is logged, and the turn runs without the MCP tools. | |
| A17 | Turn answers reach the people the turn answers, read as the turn takes its inbox, so a post after the watchdog fired still reaches them. They reach the chat thread and do not reach a session when a chat thread exists. Otherwise they reach the sessions people wrote from. | `sessionMessageWithoutAnAuthorIsAnswered` |

### Agent turn alarms

| ID | Effect | Guarded by |
|---|---|---|
| A20 | The heads-up alarm at 60 seconds posts the heads-up in chat and keeps the thread working, when a person's message was taken and the turn it was armed for still runs. | |
| A21 | The watchdog alarm at the turn timeout records that no turn runs, deletes taken rows and posts the timeout text. The hung turn keeps running, its tools keep acting, its closing text can still post, and it releases the threads when it ends. | `oneTurnRunsAtATime`, `aWaitingPersonHearsBackByTheTimeout`, `theWorkingStatusNeverOutlivesItsTurn` |
| A22 | The start step of a Durable Object with a turn still marked as running resumes the lost turn. With no lost turn, inbox rows that wait to wake the agent get a `runAgent` alarm. A finished workflow only releases its threads. | `aResumedTurnAnswersWhatItsLostTurnOwed`, `aWaitingInboxRowHasATurnComing` |
| A23 | A `runAgent` alarm runs a turn when none runs. `tellAgent` arms one and cancels it once its call to the turn loop returns, which is at once when a turn already runs. | `aWaitingInboxRowHasATurnComing` |
| A24 | A stale heads-up or watchdog alarm, armed for a turn that no longer runs, does not act. | |
| A25 | One agent turn runs at a time. The store marks a turn as running from its start until it ends or the watchdog fires. | `oneTurnRunsAtATime` |

### Agent tools

| ID | Effect | Guarded by |
|---|---|---|
| A30 | `acknowledge` puts a thumbs-up on each taken chat message, or posts one line to the people who wrote. A failed reaction partway leaves some messages without it. | `aPersonHearsBackBeforeAnyWork`, `aPersonsTurnNeverEndsUnanswered` |
| A31 | `ask` posts a question, and sets the workflow `waiting_input` when every author and researcher is idle. | `linearOnlyAsksReachTheStartingSession` |
| A32 | `tell` posts info to the people who wrote, and `stay_silent` stays quiet. Both end the turn. | `closingTextAnswersOnlyAPersonWhoWrote`, `aPersonsTurnNeverEndsUnanswered` |
| A33 | `set_plan` sets the definition, stages, slots, repository, page parent and root page. It sets the workflow `running`, moves the origin issue to started, and can create the root page on the document host. | `workflowStartsOnlyFromAPlan`, `workflowKeepsItsDefinition` |
| A34 | `start_job` inserts the job and task, binds the issue and branch in the router, claims the issue, links the chat thread, schedules the provision alarm, and links the input page from the root page. | `jobStartsOnlyIntoAFreeSlot`, `oneLiveJobPerInputArtifact`, `eachIssueLinksTheChatThreadOnce`, `workflowStartsOnlyFromAPlan` |
| A35 | `start_job` on an issue starts only when the issue's binding points at no workflow, at this workflow, or at a workflow that ended. The binding row alone decides. A workflow whose session maps the issue refuses another workflow's job on it until it ends, even without a job on the issue. `start_job` also refuses when the binding moved after it read it. | `oneRunningWorkflowHasAJobOnAnIssue` |
| A36 | `complete_job` stores a selection, or advances a host-accepted artifact. It ends the author `done`, destroys its sandbox, cancels its refiner run, and hands the artifact over. | `aFailedCheckNeverCompletesAJob`, `aFailedCheckNeverAsksThePersonAgain` |
| A37 | `cancel_job` cancels the author or researcher. It closes its feed, destroys its sandbox, cancels its refiner run, and closes the artifact. | `finishedTaskKeepsItsStatus`, `artifactStatusMovesAreLegal`, `oneUnfinishedRefinerRunPerArtifact` |
| A38 | `prompt_task` reads and screens held page comments, marks them read, and queues the prompt. It marks the comments read before it queues the prompt. | `aPromptToAPageAuthorCarriesItsHeldComments` |
| A39 | `pause_task` and `resume_task` set or clear the pause, send a cancel to the harness session, post "Paused" or "Resumed", and queue "Continue where you left off." on resume. They report success on a no-op. A paused task gets no prompt until it resumes. The first prompt of a session that opens while the task is paused waits at the head of its queue, and the restart of a paused task waits for the resume to start the next generation. | `pausedAuthorGetsNoPrompt` |
| A40 | `cancel_task` cancels a refiner run. A cancelled polisher hands the artifact over as it was left. | `oneUnfinishedRefinerRunPerArtifact`, `finishedTaskKeepsItsStatus` |
| A41 | `request_review` starts the reviewer segment from its first entry. `finish_review` moves past the open entry to the next refiner or the handover. | `refinersRunAgainOnlyOnChangedRevision`, `oneUnfinishedRefinerRunPerArtifact`, `authorIsIdleWhileAPolisherRuns` |
| A42 | `rule_on_review` with approve moves on, or first sends the author the findings of the judge's segment. With reject it posts the signed reason on the artifact host and sends it to the author with those findings. | `judgeRulesAtMostOnce`, `authorGetsEveryPullFinding` |
| A43 | `finish_workflow` sets `done`, posts the done event, moves tracker issues to completed, and removes code host bindings. It refuses while an author or researcher is active. | `endedWorkflowHasNoUnfinishedTask`, `nothingReopensAFinishedWorkflow` |
| A44 | `fail_workflow` cancels every active task and refiner run, sets `failed`, posts the failure, and removes code host bindings. | `endedWorkflowHasNoUnfinishedTask`, `linearOnlyAsksReachTheStartingSession` |
| A45 | `move_into_root_page` moves a page under the root page on the document host and drops its link. | |
| A46 | The MCP tracker tools write to the tracker under prompt rules only. A result the screen does not admit reads to the model as not given, though the write happened. | |
| A47 | The read tools only read, and they screen text that comes from outside. | `quarantinedTextNeverEntersTheTranscript` |

### Agent external calls

| ID | Effect | Guarded by |
|---|---|---|
| A50 | The main model request retries once per turn and fails into the stuck text. A hang ends at the turn deadline. | `aPersonsTurnNeverEndsUnanswered`, `aWaitingPersonHearsBackByTheTimeout` |
| A51 | A decisions call that fails, hangs or lacks a gateway returns its site's fallback. The fallback of the acceptance and selection checks keeps the job open. | `laterDecisionsCallsFallBackOnceOneFails`, `aFailedCheckNeverCompletesAJob` |
| A52 | A failed model list for a requested runtime reads to the person as "matched none clearly". | |
| A53 | A host acceptance lookup that throws reads as "not accepted". | |

## Refiners, reviews and handover

| ID | Effect | Guarded by |
|---|---|---|
| R1 | Refiners settle only once the author is quiet and the checks gate is open. Each settle reads the store again after the host read. | `authorIsIdleWhileAPolisherRuns`, `oneUnfinishedRefinerRunPerArtifact` |
| R2 | An artifact has at most one unfinished refiner run, and the artifact points at it. | `oneUnfinishedRefinerRunPerArtifact` |
| R3 | A refiner run starts on an artifact the humans hold only after an author turn ended on a changed revision. | `refinersRunAgainOnlyOnChangedRevision` |
| R4 | A reviewer does not run again on a revision it already reviewed. One rule picks the next entry on every path that runs the list: after the author's turn, `request_review`, `finish_review`, a review again decision, a stale segment restart, and a finished entry handing on. It passes over an entry that already reviewed or ruled on the current revision, and a judge that ruled. `request_review` refuses when that leaves no entry of the open segment, and a review again decision of yes then advances, as no does. A host that cannot say the revision allows the run. | `reviewerRunsOnlyOnAnUnreviewedRevision` |
| R5 | A findings reviewer entry runs at most `max_review_runs` times on one artifact. The limit adds the unreviewed revision note at handover. A stale segment restart does not count against the limit. | |
| R6 | A judge rules at most once on an artifact, and its ruling never changes. Later runs skip judge entries that ruled. A ruling that lands while the decisions model or the host is asked stands, and the later one is dropped. | `judgeRulesAtMostOnce` |
| R7 | The decisions model rules a judge conclusion. A missing conclusion, a failed call or a middle probability asks a person to rule. | |
| R8 | A refiner run ends `done` only after its turn ended normally. A polisher waiting on the checks of its push ends later, only if it did not take a prompt since. | `refinerRunIsDoneOnlyAfterItsTurnEnded` |
| R9 | The review again decision reads a model-call author's closing text. An answer of yes reruns the segment from its first entry that did not review the revision, and an answer of no advances. A failed call asks the agent to route. | |
| R10 | The agent routes a harness author's review with `request_review` or `finish_review`. The agent is told again on every settle until it routes. | |
| R11 | A segment merges the latest reviews of its entries and sends the merged review to the author when it holds findings or blocks. A segment that ends with a judge sends it once the judge rules: with the rejection, or on its own after an approval. A clean or empty segment advances. | `authorGetsEveryPullFinding` |
| R12 | The handover moves the artifact from drafted to ready once, records the delivered revision, posts `artifact_ready` and arms the idle alarm. Blocked paths hand over with a reason. | `deliveredToHumansIsNeverCleared`, `artifactStatusMovesAreLegal`, `inReviewTaskHasAnArtifact` |
| R13 | A cancelled judge run leaves the artifact drafted with its pointer until the agent routes it. A failed reviewer hands over blocked. A cancelled or failed polisher hands over blocked. | |
| R14 | An author turn that ends on a ready artifact with a changed or unreadable revision reopens it to drafted and reruns the refiners. A stage without refiners posts `artifact_ready` again. | `artifactStatusMovesAreLegal`, `refinersRunAgainOnlyOnChangedRevision` |
| R15 | A pull request review read that fails reads as if the reviewer did not file a review, and the segment advances as if clean. | |
| R16 | A reviewer that failed or gave up restarts while it has restarts, then the artifact is handed over blocked. | `finishedTaskKeepsItsStatus` |
| R17 | An accepted artifact stays accepted, and a refiner run does not start on its job. Its job completes once. A second `complete_job` does not change a task or the artifact, and does not post. | `anAcceptedArtifactNeverMovesBack` |

### Polish and checks

| ID | Effect | Guarded by |
|---|---|---|
| R20 | The author does not take a prompt while a polisher runs. The first prompt of a session that opens meanwhile, such as after a restart, waits at the head of its queue until the polisher ends. | `authorIsIdleWhileAPolisherRuns` |
| R21 | The checks gate waits for checks on the pushed revision. Passed checks stand 60 seconds, unreported ones wait 5 minutes, and running ones wait up to 2 hours, then the gate blocks. Failed checks or a conflict go back to the pusher once per revision. | |
| R22 | An unreadable revision opens the checks gate, so the refiners and the handover skip CI. | |
| R23 | The `recheck` alarm ticks every 60 seconds while the gate waits and stops when it opens, blocks, or the workflow ends. | |
| R24 | While the humans hold the artifact, failed checks or a conflict go to an idle author once per revision. A conflict with a finished author tells the agent. Failed checks with a finished author are dropped. | |
| R25 | A follow-up starts when a prompt reaches an idle author while the humans hold the artifact. The board moves to the end of the thread. | |

### Writes to the artifact host

| ID | Effect | Guarded by |
|---|---|---|
| R30 | A pull request reviewer posts its own review with its own token. | |
| R31 | A page review posts each finding with a passage as an inline comment, then one outcome comment with the review line. A failed inline comment moves into the outcome comment. The post happens before the check that the run still owns the artifact. | |
| R32 | A judge rejection posts the signed reason on the pull request or page, or in the thread for issues. A failed post is logged, and the author still gets the rejection. | |
| R33 | Person feedback on a pull request gets the eyes reaction per comment, or "Relayed to the author." when it lacks comment handles, before routing. One failure skips the rest. | |
| R34 | A page comment is acknowledged with the eyes reply when it is sent to the author. | `aPromptToAPageAuthorCarriesItsHeldComments` |
| R35 | A model-call author's revise posts one comment reply per handled comment before it writes the page. A failed reply fails the task, and replies already posted stay. | `sentCommentIsAnsweredBeforeItsLineGoes`, `replyGoesOnlyToASentComment`, `failedReplyLeavesThePage` |
| R36 | A page text change keeps the identity of every line the answer left alone. | `untouchedLinesKeepTheirIdentity` |
| R37 | The root page holds a resources section that code writes: a heading, one link line per linked page, and the link removed when a page moves under the root page. The author text goes above it. | |

### Inbound events in the workflow

| ID | Effect | Guarded by |
|---|---|---|
| E1 | Every feedback event on a running workflow gets one routing decision: author, agent, or `nobody`. A failed decisions call routes to the agent. | `everyFeedbackGetsOneRoutingDecision` |
| E2 | Feedback the screen does not admit reaches neither the agent nor the author. | `unadmittedFeedbackReachesNobody` |
| E3 | A pull request review claims its review id only when the host read succeeds. On a failed read, the review and its comments can each prompt the author. | |
| E4 | A page comment that does not mention the bot stays held. A mention sends every held comment with it as one feedback. | `aPromptToAPageAuthorCarriesItsHeldComments` |
| E5 | A finished workflow ignores events. It refuses a person's message, and the router starts the next workflow with it. A stop still stops the author, a status gets the summary, and anything else gets "This workflow is X". | `nothingReopensAFinishedWorkflow`, `endedWorkflowHasNoUnfinishedTask`, `aPersonsMessageNeverReachesAnEndedWorkflow` |
| E6 | A message wakes a workflow from `waiting_input` to `running` and rearms the idle alarm. | |
| E7 | A stop clears the author's queue, cancels its turn or ends a starting turn, and closes the feed with "Stopped.". The workflow does not change, and the orchestrator does not post. | `stopEndsTheAuthorsTurn`, `stoppedModelCallLeavesThePage` |
| E8 | Control words cancel, pause, resume and instruct. Cancel ends the workflow, or the one job on an issue that is not the origin issue. Other control words act only when one author or researcher is active. In a session with a running author, the words go to the author as a prompt. | |
| E9 | A pull request opened records the artifact and settles refiners. Marked ready cancels the refiner run and hands over. Merged accepts the artifact and tells the agent, and does not cancel a running polisher. Closed unmerged removes it and cancels the author. Reopened does not change the artifact. | `artifactStatusMovesAreLegal` |
| E10 | A check or base branch event settles the checks of each matched job. | |
| E11 | An event that does not match a job adds a note. One that matches several active jobs asks the agent which. | |
| E12 | The workflow notices a deleted page only when `start_job` checks the earlier output. | |

## Boards and chat output

| ID | Effect | Guarded by |
|---|---|---|
| C1 | Each job gets one board in each chat thread the workflow replies to. A tracker session never holds one. | `boardsLiveOnlyInChat` |
| C2 | The rendered board shows each researcher and author as its todo list or its work line. | `everyJobTaskIsOnItsBoard` |
| C3 | A researcher's todo list reads complete once the author of its job exists. | `researchReadsCompleteOnceTheAuthorStarts` |
| C4 | A board post or edit that fails is retried only on the next flush, and the flush is not scheduled. The chat can hold a stale or missing board until something else changes on the job. | |
| C5 | A board is created once per job and thread. An isolate lost between the post and the row update posts a second board on the next flush. | |
| C6 | A board a person deleted is posted again once. A second delete leaves it deleted. | |
| C7 | A follow-up moves the board to the end of the thread. It posts a new board, then deletes the old one or edits it to a pointer. | |
| C8 | The `board_flush` alarm coalesces changes into one edit per 10 seconds. Edits happen only when the body hash changes. | |
| C9 | A board note shows a restart reason or a prompt error until the turn ends. | |
| C10 | With a chat thread, every post goes to the chat threads and does not reach a tracker session. | `orchestratorStaysOutOfSessionsWhenChatExists`, `sessionMessageWithoutAnAuthorIsAnswered` |
| C11 | A chat post that fails writes a delivery error row and is not retried. The post still counts as posted, so the thread may not be released. | |
| C12 | After a chat post outside a turn, the thread status goes to active, or closed when the workflow finished. | |
| C13 | The sleep message posts after the idle hours while the workflow runs and every author and researcher is idle. The workflow moves to `waiting_input`. | `sleepMessageOnlyDuringAWorkflow` |
| C14 | A failed task posts "❌ reason". A failed workflow posts the failure and the "tag me again" line. | |
| C15 | A finished workflow posts "Done." with the result. | |
| C16 | Controls post "Cancelled.", "Paused", "Resumed" or "Not authorized.". | |
| C17 | A reply target on a document page gets a page comment. | |
| C18 | The chat eyes reaction marks a delivery slower than 3 seconds and comes off when it settles. The caller gets what the delivery gave. | `eyesNeverOutliveTheDelivery`, `eyesMarkOnlyASlowChatDelivery`, `theCallerGetsWhatTheDeliveryGave` |
| C19 | A received chat message sets the thread to its working status. | |

## Tracker output

| ID | Effect | Guarded by |
|---|---|---|
| K1 | Without a chat thread, the starting session gets every ask and failure and only those. A session gets an answer only where a person wrote. | `linearOnlyAsksReachTheStartingSession` |
| K2 | The author's completed tool calls post to its job session as activities, once each. | `feedActivityPostsOnce` |
| K3 | A turn that leaves its author idle ends the session feed with a reply or an error. A stop ends it with "Stopped.". | `sessionFeedEndsWhenItsAuthorIdles`, `stopEndsTheAuthorsTurn` |
| K4 | A feed post retries three times with the same activity id, then is dropped. | `feedActivityPostsOnce` |
| K5 | The author's todo list becomes the session plan only when the workflow lacks a chat thread. | `chatWorkflowNeverSetsASessionPlan` |
| K6 | The router posts "On it. Reading the issue." when a tracker session starts work. | |
| K7 | A start without an authorized actor gets "No workflow is working on this issue. Delegate it to me or mention me to start one.", after the starting thought. | |
| K8 | A job start claims its issue: started state and delegation to the app user. The plan moves the origin issue to started. A done workflow moves tracker issues to completed. A failed or cancelled workflow does not move them. | |
| K9 | A chat workflow links each worked issue to its chat thread once. | `eachIssueLinksTheChatThreadOnce` |
| K10 | A session message to a running author goes to that author as a prompt, does not post, and does not wake a turn. A prompt queued for an unpaused model-call author waits on an author at work. | `sessionMessageReachesItsRunningAuthorSilently` |
| K11 | A session message without a running author gets an agent turn or a reply. | `sessionMessageWithoutAnAuthorIsAnswered` |

## Router, identity and install

| ID | Effect | Guarded by |
|---|---|---|
| O1 | An event joins the first running workflow bound to one of its bindings. A workflow whose create has not returned refuses every event, and the router drops it. | `aWorkflowGetsEventsOnlyOnceCreated` |
| O2 | A start event that a running workflow took moves to it each binding it carries that was unbound or whose workflow ended. A binding that points at another running workflow keeps pointing at it. A new workflow takes a binding only while it still points where the delivery read it. | `aDeliveryLeavesTheBindingsOfARunningWorkflow` |
| O3 | A person's message on a binding whose workflow ended starts exactly one new workflow, and the binding moves to it. This holds when the Durable Object ended before the router's status did. Other events on an ended workflow are dropped. | `messageAfterEndStartsNextWorkflow`, `aPersonsMessageNeverReachesAnEndedWorkflow` |
| O4 | A failed Durable Object create removes the bindings the new workflow took, points each back at the workflow it pointed at unless another delivery bound it since, and marks the workflow failed. | `anAbandonedWorkflowKeepsNoBinding` |
| O5 | A push to a base branch fans out to every workflow with a pull request in the repository. A failed delivery stops the rest. | |
| O6 | The router's workflow status mirrors the Durable Object status. The router reads it to decide whether a workflow ended. | |
| O7 | A workflow that ends removes its code host bindings and keeps chat, issue and session bindings. A workflow does not bind a pull request once its status ended. | `anEndedWorkflowKeepsNoCodeHostBinding` |
| O8 | Access: a tracker user must be in the tracker team, a chat user in the chat team or joined by email to a tracker team member, a document user joined by email, a code user able to push. Any App passes. A failed lookup refuses. | |
| O9 | An unauthorized person's message does not start work. A prompt from an unauthorized person on a running workflow still reaches the workflow, which ignores it for controls. | |
| O10 | Person rows are upserted and merged by email before the access check. | |
| O11 | A repeated event id is dropped once per workflow. A base move copy gets the workflow id appended. | |
| O12 | The tracker install link mints a single-use state. The callback consumes it, exchanges the code, refuses a second workspace, and saves the tokens. | |
| O13 | A tracker token refresh spends the refresh token with compare-and-set. The loser adopts the stored tokens. A failed refresh keeps the old token while it is valid. | |
| O14 | A sandbox bridge dial to a workflow without a row gets 404. | |

## Ingress routes

| ID | Effect | Guarded by |
|---|---|---|
| I1 | The Linear webhook checks the HMAC and a 60 second timestamp window, then maps the payload and delivers one event. A bad signature gets 401. | |
| I2 | The GitHub webhook checks the HMAC on the raw body without a timestamp window, then delivers one event. A missing delivery id gets a random event id. | |
| I3 | The Slack webhook checks the HMAC and a 300 second window. The route answers 200 at once and maps and delivers after the reply. Every Slack retry is dropped. A failed delivery is only logged. | |
| I4 | The app posts a Slack greeting when it joins a channel. | |
| I5 | The Notion webhook answers an unsigned handshake while the token is unset, then checks the HMAC without a window. Only `comment.created` maps. The mapper fetches the comment before delivery. | |
| I6 | The Linear OAuth callback relies on the single-use state. | |
| I7 | The admin install link and the debug dumps need the admin token. The dumps answer 404 unless debug is on. | |
| I8 | Bridge WebSocket upgrades pass to the orchestrator, which checks the bridge token. | |
| I9 | A webhook with a changed signature, a stale or missing timestamp, a wrong secret, a body changed after signing, or a changed header does not reach the orchestrator. The route does not deliver or look anyone up. | `badSignatureNeverDelivers` |

## Inbound mappers

| ID | Effect | Guarded by |
|---|---|---|
| M1 | Slack: a mention becomes `start`, or `status` for a bare status question in a thread. A thread reply becomes `prompt` or `status`. A check mark reaction becomes `prompt`. Edits, bots, the app itself, Slack Connect channels and tags of other people are ignored. | |
| M2 | GitHub: pull request opened, ready, closed or reopened become `pr_event`. Reviews, review comments and pull request comments become `feedback`. Check suites and failed check runs become `ci_event`. A push to the default branch becomes `base_moved`. Forks, foreign branches, bots and the app's own reviews are ignored. | |
| M3 | GitHub: one review with N inline comments arrives as N+1 feedback events. A failed check arrives as two `ci_event`s. | |
| M4 | Linear: a session created becomes `start`. A session prompt becomes `stop` on the stop signal, else `prompt` or `status`. A document comment becomes `feedback`. An issue moved to canceled or completed by a person becomes `control` cancel. Other workspaces are ignored. | |
| M5 | Notion: a page comment becomes `feedback` after a fetch. The mapper does not filter the bot's own comments. The resolver drops them because a bot lacks an email. | |
| M6 | Every inbound mapper returns an event, or an ignore that names its reason, for any payload. It never throws. | `inboundMapperNeverThrows` |

## Adapter writes and external calls

| ID | Effect | Guarded by |
|---|---|---|
| X1 | Slack thread replies split into chunks. A failure partway leaves the first chunks posted. Every Slack write throws on error. | |
| X2 | Linear issue updates, activities, plans and thread sync throw on an error. A repeated activity id is swallowed so the post is idempotent. The SDK `success` flag is not read. | |
| X3 | GitHub writes are a pull request comment, a comment reaction and token minting. Paged reads stop at 10 pages and repository lists at 100. | |
| X4 | Notion page create, page text change, move, rename, comment, acknowledgement and reply throw on error. Inline findings swallow a per-block error and come back unposted. Not found reads as a removed page. | |
| X5 | A page text change plans at most 100 edits that each match once and turn the read text into the revised text. | |
| X6 | A Linear document text change is a read-modify-write of the whole content. A person's edit between the read and the write is lost. | |
| X7 | A held comment is a person comment without a later bot acknowledgement in its discussion. The bot's own comments are never held. | |
| X8 | Decisions calls try each configured model in order with per-attempt deadlines. Cloudflare throws on a missing probability and moves to the next model. OpenRouter reads it as 0. | |
| X9 | `fetch_url` follows redirects with a 20 second timeout and a 512 KB cap. | |
