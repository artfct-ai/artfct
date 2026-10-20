/// The lifecycle of one workflow and its jobs, from the request to the end of the workflow.
/// Each action is one step of the orchestrator that runs to its end before the next event lands.
/// Four calls split a step: the destroy of a harness author's sandbox, the acceptance check of
/// `complete_job`, and the model call and the page write of a model-call author. One action sends
/// the call and a later action returns it. A restart of the Durable Object drops every call that is
/// out, with the rest of its step. The world answers every other await at once, so the model folds
/// those into the step. The start of a task folds into the step that queues it: a harness gets its
/// first prompt, and a model-call author sends its model call. A refiner run is modelled only as
/// running, done, cancelled or failed. The review loop spec holds the rules of the run itself.
/// A setup works pages for a chat request, issues for a chat request, pages for a tracker issue,
/// or pulls for a tracker issue. The host and the tracker of a setup with pulls change outside the
/// workflow, and the workflow hears of it as events.
module workflowLifecycleTypes {
  type WorkflowStatus = New | Running | WaitingInput | Done | Failed | Cancelled

  /// The workflow definition the plan started the workflow from, by its place in the deployment.
  type PlanDefinition = Unplanned | Planned(int)

  /// `Busy` covers queued, provisioning and working. `InReview` is an author whose page is out.
  type TaskStatus = Busy | InReview | TaskDone | TaskCancelled | TaskFailed

  /// The role of a job task: the researcher that runs before the author, or the author.
  type Role = Researcher | Author

  /// A prompt queued for a task: a person's instruction, or another prompt.
  type QueuedPrompt = Instruction | OtherPrompt

  /// The instruction that the running turn of a harness task took. It stays queued until the turn
  /// ends. `HeldInACancelledTurn` is one whose turn a pause cancelled, so it waits again once
  /// that turn ends.
  type InstructionHold = NoInstructionHeld | InstructionHeld | HeldInACancelledTurn

  /// A researcher or author task. `turnRunning` holds while a prompt is in flight in its harness,
  /// also after the task finished. `promptsSent` counts the prompts the workflow sent the task:
  /// those its harness got, and for a model-call author those a model turn started on.
  /// `promptsQueued` lists the prompts that wait for a turn, oldest first. `instructionHold` is
  /// the instruction the running harness turn took. `generationClosed` holds while the
  /// container of the task's generation is closed and the task waits for a prompt to start the
  /// next one. A restart of a paused task closes it, and so does a polisher as it starts.
  /// `startOrder` is the place of the task among the researchers and authors of the workflow, in
  /// the order they started. `stopped` holds once a stop left a model-call author without a turn,
  /// until a prompt or a resume reaches it. A stop that reached a page write leaves the author
  /// without a turn once the write returns.
  type Task = {
    role: Role,
    startOrder: int,
    status: TaskStatus,
    restarts: int,
    paused: bool,
    turnRunning: bool,
    promptsSent: int,
    promptsQueued: List[QueuedPrompt],
    instructionHold: InstructionHold,
    generationClosed: bool,
    stopped: bool,
  }

  /// `Accepted` and `Removed` record that the host merged or closed the artifact. Only a pull gets
  /// there here.
  type ArtifactStatus = NoArtifact | Drafted | Ready | Accepted | Removed

  /// What the jobs of a setup work on: pages for a request in a chat thread, the issues the
  /// breakdown stage writes for a request in a chat thread, pages for the tracker issue the
  /// workflow started from, or pulls for tracker issues under the issue the workflow started from.
  /// A setup on a tracker issue has one stage that ends a single-issue workflow. A pull setup has
  /// the host move pulls on the subject issue, a person end the subject issue or a sub-issue, or
  /// jobs on both issues without moves from outside.
  type Work =
    | PagesForAChatRequest
    | IssuesForAChatRequest
    | PagesForAnIssue
    | PullsTheHostMoves
    | PullsForAnEndedSubject
    | PullsForAnEndedSubIssue
    | PullsForTwoIssues

  /// Where the pull a job's author opened stands on the host. A job that opened none, such as one
  /// that continues a pull, has `NoPull`.
  type PullOnHost = NoPull | PullOpen | PullMerged | PullClosed

  /// What a person does to a pull on the host.
  type HostMove = Merged | ClosedUnmerged | Reopened

  /// The refiner of the stage. A judge runs as a reviewer does here.
  type Refiner = NoRefiner | AReviewer | APolisher

  /// How the stage of each job ends. On a choice ending, `complete_job` checks the option a person
  /// selects from those its page lists, so it refuses a job that does not have a page yet.
  type StageEnding = AcceptanceEnding | ChoiceEnding

  /// What the acceptance check reads: the person accepts or selects, or the host merged the pull,
  /// it does not, or the decisions call failed.
  type CheckAnswer = CheckPasses | CheckDoesNotPass | CheckUnavailable

  /// What `complete_job` told the agent in a step. `NotAnswered` is a step in which it did not
  /// answer. `AsksAgain` tells the agent to ask the person again. `SaysUnavailable` tells it to
  /// tell the person the check is unavailable. `Refuses` is any other answer that leaves the job
  /// open.
  type CompletionAnswer = NotAnswered | Completes | AsksAgain | SaysUnavailable | Refuses

  /// A refiner run of a job. The reviewer approves it done, the end of its review cancels it,
  /// and its sandbox dying fails it.
  type RefinerRunStatus = RefinerRunning | RefinerDone | RefinerCancelled | RefinerFailed

  /// What a job works from: the text of a request, the artifact of an earlier job, or a tracker
  /// issue. With pulls, `FromArtifactOf` names the job that opened the pull the job continues.
  type Input = FromRequest(int) | FromArtifactOf(int) | FromIssue(int)

  /// A job with its tasks and its refiner runs, each in the order they started. The last task is
  /// the job's task now, and the last refiner run the one on its artifact now.
  type Job = {
    input: Input,
    tasks: List[Task],
    artifact: ArtifactStatus,
    refinerRuns: List[RefinerRunStatus],
    pullOnHost: PullOnHost,
  }

  type CallKind = SandboxDestroy | AcceptanceCheck | ModelCall | PageWrite | FailurePost

  /// The end of a task that went on after its teardown.
  type Teardown = AfterCancel | AfterFail | AfterComplete

  /// Who waits in this instance for a workflow end to finish: a person's event, which then tells
  /// the agent, `complete_job` on the job of the subject issue, which then answers, or neither.
  type EndWaiter = NobodyWaits | AnEventWaits | CompletionWaits

  /// A workflow end as its loop runs: the status it ends as and who waits for it.
  type EndRun = { endsAs: WorkflowStatus, waiter: EndWaiter }

  /// Who ended the task: a tool call or an event, the end of the workflow, or the completion of
  /// the job of the subject issue, which ends the workflow done once the teardown went on. That
  /// end has `complete_job` waiting on it, or nobody once the task end alarm resumes the completion.
  type Caller = ToolOrEvent | WorkflowEnd(EndRun) | SubjectJobCompletes(EndWaiter)

  /// The workflow end the store holds, with the status it ends as. The end stores it before its
  /// first cancel, records once its post returned, and drops it once the code host bindings are
  /// gone, so an instance restart keeps it.
  type StoredEnd = NoStoredEnd | EndStored(WorkflowStatus) | EndPosted(WorkflowStatus)

  /// The call a workflow end has out once its status is written: the post that tells the people
  /// of the end, then the unbind of its code host bindings.
  type EndCall = NoEndCall | EndPostOut(EndWaiter) | CodeHostUnbindOut(EndWaiter)

  /// The rest of the step that runs when the call returns. `RestartAfterWake` is a restart whose
  /// author a resume woke in a new generation while its old container went. It stops there.
  /// `PageWriteStarts` is the model turn that writes the answer of its model call to the page.
  /// `ModelTurnGoesOn` is the model turn that goes on once its page write landed.
  /// `ModelCallStopped` is the model call of a model turn that a stop ended. Its answer changes
  /// nothing. `StoppedTurnGoesOn` is the page write of a model turn that a stop reached. The turn
  /// goes on once the write returns, without the prompt the stop dropped.
  /// `AgentHearsTheFailure` is the failure post of a researcher or author. Once it returns, the
  /// task end alarm is cancelled and the agent hears of the failure. `ResearcherSandboxGone` is
  /// the destroy of the sandbox of a researcher that handed over. Once it returns, the task end
  /// alarm of the researcher is cancelled. `CompletionResumes` is the destroy that the task end
  /// alarm of a done author sent. Once it returns, the completion goes on for the caller, and no
  /// tool call waits on it.
  type Rest =
    | TeardownGoesOn({ teardown: Teardown, caller: Caller })
    | AgentHearsTheFailure
    | ResearcherSandboxGone
    | CompletionResumes(Caller)
    | RestartGoesOn
    | RestartAfterWake
    | CompletionGoesOn
    | PageWriteStarts(ModelTurn)
    | ModelTurnGoesOn(ModelTurn)
    | ModelCallStopped(ModelTurn)
    | StoppedTurnGoesOn(ModelTurn)

  /// A model turn in flight. `eventWaits` is true when a person's event started it with a prompt
  /// and waits for the turn to end before it tells the agent. `prompt` is the queued prompt a
  /// revise turn runs on.
  type ModelTurn = { eventWaits: bool, prompt: TurnPrompt }

  /// What a model turn runs on: nothing when it produces the page, a queued prompt when it
  /// revises it.
  type TurnPrompt = ProducesThePage | Revises(QueuedPrompt)

  /// A call that is out. It leaves the list when it returns, or when a restart of the Durable
  /// Object drops it.
  type Call = { kind: CallKind, job: int, rest: Rest }

  /// The stages a plan set, with the number of job slots it gave the workflow. A plan without
  /// stages only starts the workflow.
  type StagePlan = NoStages | StagesPlanned(int)

  /// The one issue or tracker project the workflow works on, once a tracker origin, the plan or
  /// a recorded tracker output set it. `SubjectIssue` names the issue by its number.
  type Subject = NoSubject | SubjectIssue(int) | SubjectProject

  /// `endingPosts` holds the posts that tell the person of an end, in the order they went out.
  /// `taskEndAlarms` holds the jobs whose finished researcher or author has its task end alarm
  /// armed. The store keeps it across an instance restart. `researcherEndAlarms` holds the jobs
  /// whose researcher handed over and has its task end alarm armed. `destroyedSandboxes` holds the jobs
  /// whose finished harness author had its sandbox destroyed by its teardown.
  /// Only the invariants read it, so the replay does not compare it.
  /// `issueMoves` counts the moves of a tracker issue the workflow made. `endedIssues` holds the
  /// issues a person moved to a canceled or completed state on the tracker.
  /// `restartAlarms` holds each armed restart alarm by the jobs whose lost model turn it still
  /// decides. A job leaves every one once its author no longer holds that turn.
  /// `runAgainAlarms` holds the jobs whose restarted author has its alarm to run the lost model
  /// turn again armed. The store keeps both alarms across an instance restart.
  /// `turnsToRunAgain` holds the jobs whose restarted author still holds the new turn id that its
  /// run-again alarm names. A stop takes it, so that alarm does nothing.
  /// `restartAlarmFired` and `ranAgain` record the alarms that already fired, which the platform
  /// may deliver again. `storedEnd` is the workflow end the store holds, and `endCall` the call
  /// it has out.
  type Workflow = {
    status: WorkflowStatus,
    definition: PlanDefinition,
    stagePlan: StagePlan,
    subject: Subject,
    idleArmed: bool,
    jobs: List[Job],
    calls: List[Call],
    endingPosts: List[EndingPost],
    issueMoves: int,
    endedIssues: Set[int],
    restartAlarms: Set[Set[int]],
    runAgainAlarms: Set[int],
    turnsToRunAgain: Set[int],
    restartAlarmFired: bool,
    ranAgain: Set[int],
    storedEnd: StoredEnd,
    endCall: EndCall,
    taskEndAlarms: Set[int],
    researcherEndAlarms: Set[int],
    destroyedSandboxes: Set[int],
  }

  /// A post that tells the person of an end: the researcher or author of the job failed, the
  /// workflow failed, or the workflow is done.
  type EndingPost = TaskFailurePost(int) | WorkflowFailurePost | DonePost

  /// A verbal command that acts on a job. The cancel ends the workflow, so it is an `Ending`.
  type VerbalCommand = Pause | Resume | Instruct

  /// What an observer knows about the last step besides the states around it. `PlanStep` is a
  /// plan with its workflow definition and the subject it names, `NoSubject` when it leaves the
  /// subject out. `JobStartStep` is `start_job` on a request or on the pull an earlier job
  /// opened, and `IssueStartStep` is `start_job` on the issue. Each says whether a router write of
  /// the start failed. `OutputStep` is the turn end of a
  /// breakdown author with the subject its output names. `DeadlineStep` is the deadline alarm of
  /// the model turn of a job. `PromptStep` is the agent's prompt to a task. `FinishStep` is
  /// `finish_workflow`. `SubjectCompletionStep` runs `complete_job` on the job of the subject issue
  /// up to its end or its next call, and so does the return of each call it waits on.
  /// `MessageStep` is a person's message in the chat thread. `IssueEndStep` is a person moving
  /// the issue to a canceled or completed state.
  /// `FailedCheckStep` is the return of the acceptance check of the job when the check failed.
  /// `StopStep` is a person pressing Stop in the session of the subject issue.
  /// `StoppedCallReturnStep` is the return of the model call of the job that a stop ended.
  /// `RestartAlarmStep` is the restart alarm that decides the lost model turns of the jobs it
  /// holds. `RestartAlarmAgainStep` is a restart alarm the platform delivers again.
  /// `RunAgainStep` is the alarm that runs the lost model turn of the job again, also once more.
  /// `LostTurnDeadlineStep` is the deadline alarm of the lost model turn of the job, which fires
  /// while its author waits for the alarm that runs the turn again. `HostErrorStep` is the page
  /// model failing the model call of the job, or the document host failing its page write.
  /// `EndResumeStep` is the alarm that goes on with a workflow end an instance restart cut off.
  /// `EndPostReturnStep` is the return of the post of a workflow end, and `UnbindReturnStep` the
  /// return of the unbind of its code host bindings.
  /// `TaskEndAlarmStep` is the task end alarm of the job's finished task.
  type StepKind =
    | OtherStep
    | PlanStep({ definition: int, subject: Subject })
    | JobStartStep({ routerWriteFails: bool })
    | IssueStartStep({ issue: int, routerWriteFails: bool })
    | OutputStep(Subject)
    | EventStep
    | MessageStep
    | VerbalCommandStep(VerbalCommand)
    | PromptStep
    | StaleAlarmStep
    | SleepStep
    | RestartStep
    | DeadlineStep(int)
    | FinishStep
    | SubjectCompletionStep
    | IssueEndStep(int)
    | FailedCheckStep(int)
    | StopStep
    | StoppedCallReturnStep(int)
    | RestartAlarmStep(Set[int])
    | RestartAlarmAgainStep
    | RunAgainStep(int)
    | LostTurnDeadlineStep(int)
    | HostErrorStep(int)
    | EndResumeStep
    | EndPostReturnStep
    | UnbindReturnStep
    | TaskEndAlarmStep(int)

  /// The timers whose alarms are about one sandbox generation.
  type GenerationTimer = HelloTimeout | NoProgress | KeepAlive | BridgeLost | QueueRetry | SettleIdleAuthor

  /// One step: the workflow before it, the workflow after it, what an observer knows of it,
  /// whether it told the agent, and what `complete_job` answered in it.
  type Transition = {
    before: Workflow,
    after: Workflow,
    kind: StepKind,
    toldTheAgent: bool,
    answered: CompletionAnswer,
  }

  /// The workflow after part of a step, and whether that part told the agent.
  type Outcome = { flow: Workflow, told: bool }

  /// Whether the last step kept each before-and-after rule, by the name of the invariant that reads
  /// it. Each step writes it again, so the state does not keep the workflow before the step.
  type KeptRules = {
    jobStartsOnlyIntoAFreeSlot: bool,
    onlyAPlanStartsTheWorkflow: bool,
    anUndeclaredPlanChangesNothing: bool,
    workflowKeepsItsDefinition: bool,
    finishedTaskKeepsItsStatus: bool,
    nothingReopensAFinishedWorkflow: bool,
    staleAlarmIsIgnored: bool,
    sleepMessageOnlyDuringAWorkflow: bool,
    finishedWorkflowKeepsItsStatus: bool,
    pausedAuthorGetsNoPrompt: bool,
    workflowWaitsOnlyWhileNoAuthorWorks: bool,
    aRestartDoesNotLoseAModelTurn: bool,
    artifactStatusMovesAreLegal: bool,
    anAcceptedArtifactNeverMovesBack: bool,
    aSingleIssueWorkflowIsDoneWithItsSubjectsJob: bool,
    subjectNeverChanges: bool,
    aStartOutsideTheSubjectStartsNoJob: bool,
    aFailedCheckNeverCompletesAJob: bool,
    aFailedCheckNeverAsksThePersonAgain: bool,
    stoppedModelCallLeavesThePage: bool,
    aJobStartProvisionsItsTask: bool,
    aWorkflowEndReachesAFinishedStatus: bool,
    aPersonsMessageWakesTheWorkflow: bool,
    issuesMoveOnlyAtAStartOrADoneEnd: bool,
    aCompletedJobEndsItsReview: bool,
  }

  /// Whether the last step reached each before-and-after witness, by the name of the witness. Only
  /// witnesses read it, so model checking leaves it out of the state.
  type ReachedWitnesses = {
    aPlanStartsTheWorkflow: bool,
    aPlanLandsOnAStartedWorkflow: bool,
    anUndeclaredPlanLands: bool,
    aPlanLeavesFewerSlotsThanJobs: bool,
    aJobStartsIntoTheLastSlot: bool,
    aJobStartsBesideAResearcher: bool,
    aFinishedTaskIsInAStep: bool,
    anEventLandsOnAFinishedWorkflow: bool,
    aStaleAlarmFires: bool,
    theSleepMessagePosts: bool,
    aMessageWakesTheWorkflow: bool,
    aPausedAuthorResumes: bool,
    aPersonPausesAResearcher: bool,
    aPromptWaitsForAPausedTask: bool,
    aPromptWaitsForATurn: bool,
    aVerbalCommandFindsSeveralJobs: bool,
    anAuthorTakesAPromptAfterItsPolisher: bool,
    aWorkflowEndCancelsARefinerRun: bool,
    aCallWasDropped: bool,
    aRestartCutsAModelTurn: bool,
    aModelTurnOutlivesItsDeadline: bool,
    aReviseTurnIsCut: bool,
    aPausedAuthorLosesAModelTurn: bool,
    anAuthorFailsOnALostModelTurn: bool,
    aRestartCutsAPageWrite: bool,
    aDeadlinePassesDuringAPageWrite: bool,
    aSubjectsJobEndsTheWorkflow: bool,
    theAcceptanceCheckCompletesTheSubjectsJob: bool,
    aStartRecordsARemovedPull: bool,
    aStartOnAnIssueWhoseJobCompletedIsRefused: bool,
    aSubIssueEndCancelsItsJob: bool,
    theSubjectIssueEndCancelsTheWorkflow: bool,
    anIssueEndFindsAnAcceptedArtifact: bool,
    aCancelWordReachesTheSubjectsAuthor: bool,
    aStartBeforeTheSubjectIsRefused: bool,
    aStartOutsideTheSubjectIsRefused: bool,
    aPlanSetsTheSubject: bool,
    aPlanNamesAnotherSubject: bool,
    anOutputSetsTheSubject: bool,
    anOutputNamesAnotherSubject: bool,
    anAcceptanceCheckFails: bool,
    aCheckFailsAfterItsAuthorEnded: bool,
    aStopEndsAModelCall: bool,
    aStoppedModelCallReturns: bool,
    aJobStartsPastAFailedRouterWrite: bool,
    aStaleAlarmFindsAnEndedModelTurn: bool,
    aRestartCutsAProduceTurn: bool,
    aDeadlinePassesDuringAProduceTurn: bool,
    aRestartCutsARerunModelTurn: bool,
    aSessionMessageReachesAModelCallAuthorAtWork: bool,
    aStopLandsDuringAPageWrite: bool,
    anEventLandsBeforeTheRestartAlarm: bool,
    anEventLandsBeforeALostModelTurnRunsAgain: bool,
    aRestartLandsBeforeTheRestartAlarm: bool,
    aRestartLandsBeforeALostModelTurnRunsAgain: bool,
    theRestartAlarmFailsAnAuthor: bool,
    aRestartAlarmFiresAgain: bool,
    aLostModelTurnRunsAgainOnceMore: bool,
    aStopTakesATurnThatWaitsToRunAgain: bool,
    aRunAgainAlarmFindsAStoppedAuthor: bool,
    aLostModelTurnDeadlineFires: bool,
    aMessageLandsOnAWaitingWorkflow: bool,
    aTrackerWorkflowEndsWithoutDone: bool,
    aRestartCutsAPageCreate: bool,
    aHarnessAuthorPostsItsFailureAfterItsDestroy: bool,
    aResearcherPostsItsFailure: bool,
    aModelCallHostErrorPostsAFailure: bool,
    aRestartCutsTheDestroyOfACancelledAuthor: bool,
    aRestartCutsTheDestroyOfAFailedAuthor: bool,
    aRestartCutsTheDestroyOfACompletedAuthor: bool,
    aRestartCutsAFailurePost: bool,
    aTaskEndAlarmResumesATeardown: bool,
    aTaskEndAlarmFindsItsTeardownOut: bool,
    aJobCompletesDuringItsReview: bool,
    aHarnessAuthorCompletesAfterItsDestroy: bool,
    aRestartCutsTheDestroyOfAResearcherThatHandedOver: bool,
    aResearcherEndAlarmDestroysTheSandboxAgain: bool,
    aTaskEndAlarmFinishesACompletion: bool,
    aTaskEndAlarmEndsASingleIssueWorkflow: bool,
    aRestartAlarmDecidesATurnThatWaitedToRunAgain: bool,
    aRestartLandsDuringAWorkflowEnd: bool,
    aWorkflowEndResumesAfterARestart: bool,
    aRestartCutsTheEndPost: bool,
    aResumedEndFindsItsPostReturned: bool,
  }

  type Ending = PersonCancels | AgentFails | AgentFinishes
}

/// The lifecycle of a workflow whose jobs each write a page or open a pull with an author, after
/// a researcher when the stage runs one.
module workflowLifecycle {
  import workflowLifecycleTypes.*

  /// What the jobs work on, and where the request came from.
  const WORK: Work

  /// The refiner the stage runs on the page of each job.
  const REFINER: Refiner

  /// True when the author of each job runs as model calls, without a sandbox. A polisher does not
  /// run on such a page here.
  const MODEL_AUTHOR: bool

  /// True when a researcher runs before the author of each job.
  const RESEARCH: bool

  /// How the stage of each job ends. Only a stage that writes pages ends on a choice.
  const STAGE_ENDING: StageEnding

  /// The numbers of job slots a plan can set.
  const SLOT_COUNTS: Set[int]

  /// How often a task restarts before it fails.
  pure val MAX_RESTARTS: int = 2

  /// The most jobs a trace starts.
  pure val MAX_JOBS: int = 3

  /// The request texts a job can work from.
  pure val REQUESTS: Set[int] = if (WRITES_ISSUES) Set(0) else 0.to(1)

  /// True when the jobs open pulls for tracker issues.
  pure val WORKS_ON_PULLS: bool = not(WRITES_PAGES or WRITES_ISSUES)

  /// What the acceptance check can read. The host's merge lookup on a pull reads a failure as not
  /// merged, so only the decisions call of a page or issues fails.
  pure val CHECK_ANSWERS: Set[CheckAnswer] =
    if (WORKS_ON_PULLS) Set(CheckPasses, CheckDoesNotPass)
    else Set(CheckPasses, CheckDoesNotPass, CheckUnavailable)

  /// True when the jobs of the breakdown stage end their turns with the link of the issues they
  /// wrote.
  pure val WRITES_ISSUES: bool = WORK == IssuesForAChatRequest

  /// True when the agent may start a job on a tracker issue.
  pure val STARTS_ON_ISSUES: bool = WORK != PagesForAChatRequest

  /// True when the jobs write pages.
  pure val WRITES_PAGES: bool = WORK == PagesForAChatRequest or WORK == PagesForAnIssue

  /// True when the workflow started from the session of a tracker issue, which sets the subject
  /// as the workflow opens. A setup with pulls does, and so does one with pages for an issue.
  pure val TRACKER_ORIGIN: bool = WORKS_ON_PULLS or WORK == PagesForAnIssue

  /// The issue a tracker origin starts the workflow from, and a plan or an output may name.
  pure val SUBJECT_ISSUE: int = 0

  /// A sub-issue of the subject issue.
  pure val SUB_ISSUE: int = 1

  /// An issue that is not a sub-issue of the subject issue and not in the project.
  pure val STRAY_ISSUE: int = 2

  /// The issues of the tracker project: the subject issue and its sub-issue.
  pure val PROJECT_ISSUES: Set[int] = Set(SUBJECT_ISSUE, SUB_ISSUE)

  /// The tracker issues a job can work from, also one outside the subject.
  pure val ISSUES: Set[int] = match WORK {
    | PullsForAnEndedSubIssue => Set(SUB_ISSUE, STRAY_ISSUE)
    | PullsForTwoIssues => Set(SUBJECT_ISSUE, SUB_ISSUE, STRAY_ISSUE)
    | IssuesForAChatRequest => Set(SUBJECT_ISSUE, SUB_ISSUE, STRAY_ISSUE)
    | _ => Set(SUBJECT_ISSUE, STRAY_ISSUE)
  }

  /// The subjects a plan or an output can name: the subject issue and the project.
  pure val TRACKER_LINKS: Set[Subject] = Set(SubjectIssue(SUBJECT_ISSUE), SubjectProject)

  /// The subjects a plan can name, or `NoSubject` when it leaves the subject out. Only a setup
  /// that starts jobs on issues names one.
  pure val PLAN_SUBJECTS: Set[Subject] =
    if (STARTS_ON_ISSUES) TRACKER_LINKS.union(Set(NoSubject)) else Set(NoSubject)

  /// True when a person presses Stop in the session of the subject issue. The spec has a stop only
  /// for a model-call author.
  pure val A_PERSON_STOPS: bool = TRACKER_ORIGIN and MODEL_AUTHOR

  /// True when a person ends issues on the tracker.
  pure val A_PERSON_ENDS_ISSUES: bool = WORK == PullsForAnEndedSubject or WORK == PullsForAnEndedSubIssue

  /// The job slots the workflow holds when it opens, until a plan sets the stages.
  pure val UNPLANNED_SLOTS: int = 2

  /// The workflow definitions of the deployment.
  pure val DEFINITIONS: Set[int] = 0.to(1)

  /// The workflow definitions a plan can name: those of the deployment and one it does not hold.
  pure val NAMED_DEFINITIONS: Set[int] = 0.to(2)

  /// The timers whose alarm can fire for a generation before the current one.
  pure val GENERATION_TIMERS: Set[GenerationTimer] =
    Set(HelloTimeout, NoProgress, KeepAlive, BridgeLost, QueueRetry, SettleIdleAuthor)

  /// The sandboxes a stale alarm can be about, counted round those with an earlier generation.
  pure val STALE_SANDBOXES: Set[int] = 0.to(2)

  pure val INITIAL_WORKFLOW: Workflow = {
    status: New,
    definition: Unplanned,
    stagePlan: NoStages,
    subject: if (TRACKER_ORIGIN) SubjectIssue(SUBJECT_ISSUE) else NoSubject,
    idleArmed: true,
    jobs: List(),
    calls: List(),
    endingPosts: List(),
    issueMoves: 0,
    endedIssues: Set(),
    restartAlarms: Set(),
    runAgainAlarms: Set(),
    turnsToRunAgain: Set(),
    restartAlarmFired: false,
    ranAgain: Set(),
    storedEnd: NoStoredEnd,
    endCall: NoEndCall,
    taskEndAlarms: Set(),
    researcherEndAlarms: Set(),
    destroyedSandboxes: Set(),
  }

  var workflow: Workflow
  var lastStepKept: KeptRules
  var lastStepReached: ReachedWitnesses

  /// True when the last step told the agent. Only the replay reads it, so model checking leaves it
  /// out of the state.
  var lastStepToldTheAgent: bool

  /// What `complete_job` told the agent in the last step. Only the replay reads it, so model
  /// checking leaves it out of the state.
  var lastStepAnswered: CompletionAnswer

  pure def isFinished(status: TaskStatus): bool =
    status == TaskDone or status == TaskCancelled or status == TaskFailed

  pure def refinerRunHasFinished(status: RefinerRunStatus): bool =
    status == RefinerDone or status == RefinerCancelled or status == RefinerFailed

  /// True while the last refiner run of the job runs.
  pure def refinerRunning(job: Job): bool =
    job.refinerRuns.length() > 0 and job.refinerRuns[job.refinerRuns.length() - 1] == RefinerRunning

  /// True when a refiner run of the job ended as `status`.
  pure def hasRefinerRun(job: Job, status: RefinerRunStatus): bool =
    job.refinerRuns.indices().exists(index => job.refinerRuns[index] == status)

  /// The job with its last refiner run ended as `status`.
  pure def endLastRefinerRun(job: Job, status: RefinerRunStatus): Job =
    { ...job, refinerRuns: job.refinerRuns.replaceAt(job.refinerRuns.length() - 1, status) }

  /// The job with a new refiner run on its artifact.
  pure def startRefinerRun(job: Job): Job = { ...job, refinerRuns: job.refinerRuns.append(RefinerRunning) }

  pure def hasEnded(status: WorkflowStatus): bool =
    status == Done or status == Failed or status == Cancelled

  pure def jobIds(flow: Workflow): Set[int] = flow.jobs.indices()

  /// The task of the job now: its author once the researcher handed over, else its first task.
  pure def jobTask(flow: Workflow, id: int): Task =
    flow.jobs[id].tasks[flow.jobs[id].tasks.length() - 1]

  pure def unfinishedJobIds(flow: Workflow): List[int] =
    range(0, MAX_JOBS).select(id => id < flow.jobs.length() and not(isFinished(jobTask(flow, id).status)))

  pure def busyJobs(flow: Workflow): Set[int] =
    jobIds(flow).filter(id => jobTask(flow, id).status == Busy)

  pure def outCalls(flow: Workflow, kind: CallKind): Set[int] =
    flow.calls.indices().filter(id => flow.calls[id].kind == kind)

  pure def withJob(flow: Workflow, id: int, job: Job): Workflow =
    { ...flow, jobs: flow.jobs.replaceAt(id, job) }

  pure def withTask(flow: Workflow, id: int, task: Task): Workflow = {
    val job = flow.jobs[id]
    withJob(flow, id, { ...job, tasks: job.tasks.replaceAt(job.tasks.length() - 1, task) })
  }

  pure def withoutCall(flow: Workflow, id: int): Workflow =
    { ...flow, calls: flow.calls.slice(0, id).concat(flow.calls.slice(id + 1, flow.calls.length())) }

  pure def sendCall(flow: Workflow, kind: CallKind, id: int, rest: Rest): Workflow =
    { ...flow, calls: flow.calls.append({ kind: kind, job: id, rest: rest }) }

  /// True for a model-call author, which runs without a sandbox.
  pure def runsAsModelCalls(task: Task): bool = MODEL_AUTHOR and task.role == Author

  /// True when the destroy of the task's sandbox is a call: the destroy of a harness author's.
  pure def destroyIsACall(task: Task): bool = task.role == Author and not(MODEL_AUTHOR)

  /// True for the calls of a model turn the task holds: its model call and its page write, also
  /// one a stop reached. The model call of a turn that a stop ended is not one.
  pure def isModelTurnCall(call: Call): bool = match call.rest {
    | PageWriteStarts(_) => true
    | ModelTurnGoesOn(_) => true
    | StoppedTurnGoesOn(_) => true
    | _ => false
  }

  /// True for the page write of a model turn that a stop reached.
  pure def isStoppedPageWrite(call: Call): bool = match call.rest {
    | StoppedTurnGoesOn(_) => true
    | _ => false
  }

  /// True for the model call of a model turn that a stop ended.
  pure def isStoppedModelCall(call: Call): bool = match call.rest {
    | ModelCallStopped(_) => true
    | _ => false
  }

  /// True while the model turn of the job's unfinished model-call author is in flight: its model
  /// call or its page write is out, or an instance restart cut it and the author still holds it,
  /// also while it waits for its run-again alarm.
  pure def modelTurnInFlight(flow: Workflow, id: int): bool = and {
    not(isFinished(jobTask(flow, id).status)),
    or {
      flow.calls.indices().exists(callId =>
        isModelTurnCall(flow.calls[callId]) and flow.calls[callId].job == id),
      lostModelTurn(flow, id),
      flow.turnsToRunAgain.contains(id),
    },
  }

  /// True while an instance restart cut the model turn of the job and no restart alarm decided it.
  pure def lostModelTurn(flow: Workflow, id: int): bool =
    flow.restartAlarms.exists(jobs => jobs.contains(id))

  /// The workflow once the author of the job no longer holds its lost model turn, also one that
  /// waits for its run-again alarm. A restart alarm left without a job decides nothing, so it goes.
  pure def withoutLostModelTurn(flow: Workflow, id: int): Workflow = {
    ...flow,
    turnsToRunAgain: flow.turnsToRunAgain.exclude(Set(id)),
    restartAlarms: flow.restartAlarms.map(jobs => jobs.exclude(Set(id))).filter(jobs => jobs.size() > 0),
  }

  /// True while the page write of the job's model turn is out.
  pure def pageWriteOut(flow: Workflow, id: int): bool = pageWritesOut(flow, id) > 0

  /// The page writes of the job that are out.
  pure def pageWritesOut(flow: Workflow, id: int): int =
    flow.calls.indices().filter(callId => flow.calls[callId].kind == PageWrite and flow.calls[callId].job == id).size()

  /// The model calls out whose model turn a stop ended.
  pure def stoppedModelCallsOut(flow: Workflow): int =
    flow.calls.indices().filter(callId => isStoppedModelCall(flow.calls[callId])).size()

  /// True while the deadline alarm of a model turn of the job's model-call author that already
  /// ended is armed: the turn that produced the page, or a turn whose model call a stop ended.
  /// Nothing cancels the deadline alarm of a turn that ends.
  pure def staleModelTurnDeadlineArmed(flow: Workflow, id: int): bool = and {
    runsAsModelCalls(jobTask(flow, id)),
    or {
      flow.jobs[id].artifact != NoArtifact,
      flow.calls.indices().exists(callId =>
        isStoppedModelCall(flow.calls[callId]) and flow.calls[callId].job == id),
    },
  }

  /// The page writes out whose model turn a stop reached.
  pure def stoppedPageWritesOut(flow: Workflow): int =
    flow.calls.indices().filter(callId => isStoppedPageWrite(flow.calls[callId])).size()

  pure def modelTurnsInFlight(flow: Workflow): Set[int] =
    jobIds(flow).filter(id => modelTurnInFlight(flow, id))

  /// The researchers and authors the workflow started.
  pure def tasksStarted(flow: Workflow): int =
    flow.jobs.foldl(0, (count, job) => count + job.tasks.length())

  /// A task as it starts. A harness gets its first prompt. A model-call author sends its model call
  /// to produce the page, which takes no prompt.
  pure def newTask(flow: Workflow, role: Role): Task = {
    val harness = not(MODEL_AUTHOR and role == Author)
    {
      role: role,
      startOrder: tasksStarted(flow),
      status: Busy,
      restarts: 0,
      paused: false,
      turnRunning: harness,
      promptsSent: if (harness) 1 else 0,
      promptsQueued: List(),
      instructionHold: NoInstructionHeld,
      generationClosed: false,
      stopped: false,
    }
  }

  /// The model call a task sends as it starts, when it is a model-call author.
  pure def sendFirstModelCall(flow: Workflow, id: int): Workflow =
    if (runsAsModelCalls(jobTask(flow, id))) sendCall(flow, ModelCall, id, PageWriteStarts({ eventWaits: false, prompt: ProducesThePage }))
    else flow

  /// The part of a step that does not tell the agent.
  pure def untold(flow: Workflow): Outcome = { flow: flow, told: false }

  /// The status a task takes from `finishTask`. The status is written before the sandbox goes.
  /// A prompt in flight stays in flight on the finished task. The model turn of a model-call
  /// author ends with it, also one an instance restart cut.
  pure def finishTask(flow: Workflow, id: int, status: TaskStatus): Workflow =
    withoutLostModelTurn(withTask(flow, id, {
      ...jobTask(flow, id),
      status: status,
      promptsQueued: List(),
      instructionHold: NoInstructionHeld,
      generationClosed: false,
    }), id)

  /// The input of a new job: the artifact of the latest done job whose artifact the humans have,
  /// or the request.
  pure def inputFor(flow: Workflow, request: int): Input = {
    val builtOn = jobIds(flow).filter(id =>
      jobTask(flow, id).status == TaskDone and flow.jobs[id].artifact == Ready)
    if (builtOn.size() == 0) FromRequest(request)
    else FromArtifactOf(builtOn.fold(0, (latest, id) => if (id > latest) id else latest))
  }

  /// True for a job that continues the pull of an earlier job, so its artifact is its input.
  pure def continuesAPull(job: Job): bool =
    WORKS_ON_PULLS and match job.input { | FromArtifactOf(_) => true | _ => false }

  /// True when the issue is in the subject: the subject issue and its sub-issue, or an issue of
  /// the project. An issue is not in the subject of a workflow that does not have one yet.
  pure def issueInSubject(subject: Subject, issue: int): bool = match subject {
    | NoSubject => false
    | SubjectIssue(subjectIssue) => issue == subjectIssue or (subjectIssue == SUBJECT_ISSUE and issue == SUB_ISSUE)
    | SubjectProject => PROJECT_ISSUES.contains(issue)
  }

  /// True when the output of the job is its input: a breakdown job on the subject issue whose
  /// output names it. A recorded output names the subject, since the output sets a missing
  /// subject and another one is refused.
  pure def outputIsItsInput(flow: Workflow, id: int): bool = and {
    WRITES_ISSUES,
    flow.jobs[id].artifact != NoArtifact,
    match flow.subject {
      | SubjectIssue(issue) => flow.jobs[id].input == FromIssue(issue)
      | _ => false
    },
  }

  /// A job holds its input while its task is unfinished, and after that while its output exists
  /// and the host has not removed it. A job that continues a pull does not hold it once finished,
  /// and neither does a job whose output is its input.
  pure def holdsItsInput(flow: Workflow, id: int): bool = {
    val job = flow.jobs[id]
    or {
      not(isFinished(job.tasks[job.tasks.length() - 1].status)),
      and {
        job.artifact != NoArtifact,
        job.artifact != Removed,
        not(continuesAPull(job)),
        not(outputIsItsInput(flow, id)),
      },
    }
  }

  pure def inputHeld(flow: Workflow, input: Input): bool =
    jobIds(flow).exists(id => flow.jobs[id].input == input and holdsItsInput(flow, id))

  /// True from the request of a workflow end until its code host bindings are gone. The store
  /// holds the end, so an instance restart keeps it.
  pure def workflowEnding(flow: Workflow): bool = flow.storedEnd != NoStoredEnd

  /// The status the workflow end the store holds ends as, or none when it does not hold one.
  pure def storedEndStatus(flow: Workflow): Set[WorkflowStatus] = match flow.storedEnd {
    | NoStoredEnd => Set()
    | EndStored(endsAs) => Set(endsAs)
    | EndPosted(endsAs) => Set(endsAs)
  }

  /// True when the store holds a workflow end whose post has not returned.
  pure def endPostAwaited(flow: Workflow): bool = match flow.storedEnd {
    | EndStored(_) => true
    | _ => false
  }

  /// True when the store holds a workflow end whose post returned.
  pure def endPostReturned(flow: Workflow): bool = match flow.storedEnd {
    | EndPosted(_) => true
    | _ => false
  }

  /// True when a call that is out goes on for this caller once it returns.
  pure def callOutFor(flow: Workflow, caller: Caller): bool =
    flow.calls.indices().exists(callId => match flow.calls[callId].rest {
      | TeardownGoesOn(teardown) => teardown.caller == caller
      | _ => false
    })

  /// True when the caller is the loop of a workflow end that ends as `endsAs`.
  pure def isEndLoopOf(caller: Caller, endsAs: WorkflowStatus): bool = match caller {
    | WorkflowEnd(endRun) => endRun.endsAs == endsAs
    | _ => false
  }

  /// True when a destroy is out that the loop of a workflow end that ends as `endsAs` waits on.
  pure def endDestroyOut(flow: Workflow, endsAs: WorkflowStatus): bool =
    flow.calls.indices().exists(callId => match flow.calls[callId].rest {
      | TeardownGoesOn(teardown) => isEndLoopOf(teardown.caller, endsAs)
      | _ => false
    })

  /// Who waits on the post of a workflow end while it is out, or none while it is not.
  pure def endPostWaiters(flow: Workflow): Set[EndWaiter] = match flow.endCall {
    | EndPostOut(waiter) => Set(waiter)
    | _ => Set()
  }

  /// Who waits on the unbind of the code host bindings of a workflow end while it is out, or none
  /// while it is not.
  pure def unbindWaiters(flow: Workflow): Set[EndWaiter] = match flow.endCall {
    | CodeHostUnbindOut(waiter) => Set(waiter)
    | _ => Set()
  }

  /// True while the unbind of the code host bindings of a workflow end is out.
  pure def unbindOut(flow: Workflow): bool = unbindWaiters(flow).size() > 0

  /// True while a call of a workflow end that `complete_job` waits on is out: its post or unbind.
  pure def endCallAwaitsCompletion(flow: Workflow): bool = match flow.endCall {
    | EndPostOut(waiter) => waiter == CompletionWaits
    | CodeHostUnbindOut(waiter) => waiter == CompletionWaits
    | NoEndCall => false
  }

  /// The job slots of the workflow: those the plan set with the stages. Before that, a page
  /// stage does not have any, and any other stage has those the workflow opened with.
  pure def jobSlotsOf(flow: Workflow): int = match flow.stagePlan {
    | NoStages => if (WRITES_PAGES) 0 else UNPLANNED_SLOTS
    | StagesPlanned(jobSlots) => jobSlots
  }

  /// True when a job slot is free. A refiner run takes no slot.
  pure def hasAFreeJobSlot(flow: Workflow): bool = unfinishedJobIds(flow).length() < jobSlotsOf(flow)

  /// `startJob`: the job starts with its researcher when the stage runs one, else with its author.
  pure def startedJob(flow: Workflow, input: Input): Workflow = {
    val task = newTask(flow, if (RESEARCH) Researcher else Author)
    val job = { input: input, tasks: List(task), artifact: NoArtifact, refinerRuns: List(), pullOnHost: NoPull }
    sendFirstModelCall({ ...flow, jobs: flow.jobs.append(job), status: Running }, flow.jobs.length())
  }

  /// `startJob` whose router write fails after it wrote the task: the D1 status write when the
  /// status changes, else the branch binding. The start armed the provision alarm before it, so
  /// the task starts as it does without the failure.
  pure def startedJobPastAFailedRouterWrite(flow: Workflow, input: Input): Workflow =
    startedJob(flow, input)

  /// True when the task of job `id` got its first prompt, or its model call is out.
  pure def taskProvisioned(flow: Workflow, id: int): bool =
    if (runsAsModelCalls(jobTask(flow, id)))
      flow.calls.indices().exists(callId => flow.calls[callId].job == id and flow.calls[callId].kind == ModelCall)
    else jobTask(flow, id).turnRunning

  /// A job start provisions the task it writes, also when a router write of the start fails.
  pure def provisionsEveryStartedTask(step: Transition): bool =
    0.to(MAX_JOBS - 1).forall(id =>
      (id >= step.before.jobs.length() and id < step.after.jobs.length()) implies taskProvisioned(step.after, id))

  /// True when a step starts a job past a failed router write of the start.
  pure def startsAJobPastAFailedRouterWrite(step: Transition): bool = and {
    step.after.jobs.length() > step.before.jobs.length(),
    match step.kind {
      | JobStartStep(start) => start.routerWriteFails
      | IssueStartStep(start) => start.routerWriteFails
      | _ => false
    },
  }

  /// `startAuthorAfterResearch`: the researcher finishes done once its turn ended with the research
  /// payload, with its task end alarm armed, and the author of its job starts. The destroy of the
  /// researcher's sandbox goes out last.
  pure def researchHandedOver(flow: Workflow, id: int): Workflow = {
    val done = finishTask(
      withTask(flow, id, { ...jobTask(flow, id), turnRunning: false }),
      id,
      TaskDone,
    )
    val job = done.jobs[id]
    val queued = withJob(done, id, { ...job, tasks: job.tasks.append(newTask(done, Author)) })
    val destroying = sendCall(
      { ...queued, researcherEndAlarms: queued.researcherEndAlarms.union(Set(id)) },
      SandboxDestroy,
      id,
      ResearcherSandboxGone,
    )
    sendFirstModelCall(destroying, id)
  }

  /// True while the destroy of the sandbox of the job's researcher that handed over is out.
  pure def researcherDestroyOut(flow: Workflow, id: int): bool =
    flow.calls.indices().exists(callId =>
      flow.calls[callId].job == id and flow.calls[callId].rest == ResearcherSandboxGone)

  /// The task end alarm of the job's researcher that handed over fires. While this instance still
  /// destroys its sandbox, the alarm is armed again and nothing else changes. Otherwise the
  /// destroy goes out again.
  pure def resumeResearcherEnd(flow: Workflow, id: int): Outcome =
    if (researcherDestroyOut(flow, id)) untold(flow)
    else untold(sendCall(flow, SandboxDestroy, id, ResearcherSandboxGone))

  /// `endReviewAndBoard`: the refiner run of the job is cancelled and the humans get the artifact.
  pure def endReview(flow: Workflow, id: int): Workflow = {
    val job = flow.jobs[id]
    val handedOver = job.artifact == Drafted
    val ended = {
      ...if (refinerRunning(job)) endLastRefinerRun(job, RefinerCancelled) else job,
      artifact: if (handedOver) Ready else job.artifact,
    }
    { ...withJob(flow, id, ended), idleArmed: flow.idleArmed or handedOver }
  }

  /// The loop of a workflow end cancels the unfinished refiner runs and sets the status. A
  /// cancelled polisher hands the page it holds to the humans blocked. It then sends the post that
  /// tells the people of the end. An end whose post returned before an instance restart does not
  /// post again: it moves the issue of a done tracker workflow to completed and sends the unbind
  /// of its code host bindings.
  pure def finishWorkflowEnd(flow: Workflow, endsAs: WorkflowStatus, waiter: EndWaiter): Workflow = {
    val stopped = range(0, MAX_JOBS).select(id => id < flow.jobs.length()).foldl(flow, (ending, id) =>
      if (not(refinerRunning(ending.jobs[id]))) ending
      else {
        val cancelled = withJob(ending, id, endLastRefinerRun(ending.jobs[id], RefinerCancelled))
        if (REFINER == APolisher) handOverPage(cancelled, id) else cancelled
      })
    val posted = endPostReturned(flow)
    {
      ...stopped,
      status: endsAs,
      issueMoves: if (posted and movesItsIssue(endsAs)) stopped.issueMoves + 1 else stopped.issueMoves,
      endCall: if (posted) CodeHostUnbindOut(waiter) else EndPostOut(waiter),
    }
  }

  /// True when the end of a workflow that ends as `endsAs` moves its tracker issue to completed.
  pure def movesItsIssue(endsAs: WorkflowStatus): bool = endsAs == Done and TRACKER_ORIGIN

  /// The post of a workflow end returns. A workflow that ended done or failed posted its end. The
  /// store records that the post returned, the issue of a done tracker workflow moves to
  /// completed, and the unbind of the code host bindings goes out.
  pure def endPostLanded(flow: Workflow, waiter: EndWaiter): Workflow = match flow.storedEnd {
    | EndStored(endsAs) => {
      ...flow,
      endingPosts: match endsAs {
        | Done => flow.endingPosts.append(DonePost)
        | Failed => flow.endingPosts.append(WorkflowFailurePost)
        | _ => flow.endingPosts
      },
      issueMoves: if (movesItsIssue(endsAs)) flow.issueMoves + 1 else flow.issueMoves,
      storedEnd: EndPosted(endsAs),
      endCall: CodeHostUnbindOut(waiter),
    }
    | _ => flow
  }

  /// The jobs whose task is unfinished, in the order their tasks started.
  pure def unfinishedJobsInStartOrder(flow: Workflow): List[int] =
    range(0, 2 * MAX_JOBS).foldl(List(), (order, place) =>
      order.concat(unfinishedJobIds(flow).select(id => jobTask(flow, id).startOrder == place)))

  /// The loop of a workflow end stores the end before its first cancel, and keeps an end the store
  /// holds when it goes on after a restart. It reads the unfinished
  /// researchers and authors again before each cancel and cancels the one that started first. A
  /// task without a sandbox destroy to wait on ends at once, and its cancel tells the agent. The
  /// loop waits on the destroy of a harness author's sandbox, with the task end alarm of that
  /// author armed.
  pure def continueWorkflowEnd(unstored: Workflow, endsAs: WorkflowStatus, waiter: EndWaiter): Outcome = {
    val flow = if (workflowEnding(unstored)) unstored else { ...unstored, storedEnd: EndStored(endsAs) }
    val left = unfinishedJobsInStartOrder(flow)
    val awaited = range(0, MAX_JOBS).select(index =>
      index < left.length() and destroyIsACall(jobTask(flow, left[index])))
    val firstAwaited = if (awaited.length() > 0) awaited.head() else left.length()
    val endedAtOnce = range(0, MAX_JOBS).select(index => index < firstAwaited).foldl(flow, (ending, index) =>
      endReview(finishTask(ending, left[index], TaskCancelled), left[index]))
    val ended =
      if (firstAwaited == left.length()) finishWorkflowEnd(endedAtOnce, endsAs, waiter)
      else {
        val id = left[firstAwaited]
        sendCall(
          armTaskEndAlarm(finishTask(endedAtOnce, id, TaskCancelled), id),
          SandboxDestroy,
          id,
          TeardownGoesOn({ teardown: AfterCancel, caller: WorkflowEnd({ endsAs: endsAs, waiter: waiter }) }),
        )
      }
    { flow: ended, told: firstAwaited > 0 }
  }


  /// The task end alarm of the job's task is armed as its end writes the status.
  pure def armTaskEndAlarm(flow: Workflow, id: int): Workflow =
    { ...flow, taskEndAlarms: flow.taskEndAlarms.union(Set(id)) }

  /// The teardown of the job's task finished, so its task end alarm is cancelled.
  pure def cancelTaskEndAlarm(flow: Workflow, id: int): Workflow =
    { ...flow, taskEndAlarms: flow.taskEndAlarms.exclude(Set(id)) }

  /// The end of a task goes on once its sandbox is gone: the review of its job ends. A failed
  /// task then sends its failure post, and the rest waits on it. A cancel or a completion cancels
  /// its task end alarm, and a cancel tells the agent. `complete_job` on the job of the subject
  /// issue then ends the workflow done once a plan set the stages, unless the workflow ended or
  /// another end runs. A failure is always the end of a tool call or an event.
  pure def teardownGoesOn(flow: Workflow, id: int, teardown: Teardown, caller: Caller): Outcome = {
    val reviewed = endReview(flow, id)
    if (teardown == AfterFail) untold(sendCall(reviewed, FailurePost, id, AgentHearsTheFailure))
    else {
      val ended = cancelTaskEndAlarm(reviewed, id)
      val continued = match caller {
        | ToolOrEvent => untold(ended)
        | WorkflowEnd(endRun) => continueWorkflowEnd(ended, endRun.endsAs, endRun.waiter)
        | SubjectJobCompletes(waiter) =>
          if (hasEnded(ended.status) or workflowEnding(ended) or ended.stagePlan == NoStages) untold(ended)
          else continueWorkflowEnd(ended, Done, waiter)
      }
      { ...continued, told: teardown != AfterComplete or continued.told }
    }
  }

  /// The failure post of the job's task returns. The task end alarm is cancelled, and the agent
  /// hears of the failure.
  pure def failureHeard(flow: Workflow, id: int): Outcome = {
    flow: cancelTaskEndAlarm({ ...flow, endingPosts: flow.endingPosts.append(TaskFailurePost(id)) }, id),
    told: true,
  }

  /// `failTask`, `cancelTask` or `completeJob` ends a task and arms its task end alarm with the
  /// status. A harness author's end waits on the destroy of its sandbox. Any other end goes on at
  /// once.
  pure def endTask(flow: Workflow, id: int, status: TaskStatus, teardown: Teardown, caller: Caller): Outcome = {
    val ended = armTaskEndAlarm(finishTask(flow, id, status), id)
    if (destroyIsACall(jobTask(flow, id)))
      untold(sendCall(ended, SandboxDestroy, id, TeardownGoesOn({ teardown: teardown, caller: caller })))
    else teardownGoesOn(ended, id, teardown, caller)
  }

  /// True while a call of the teardown of the job's task is out: the destroy of its sandbox or
  /// its failure post.
  pure def teardownCallOut(flow: Workflow, id: int): bool =
    flow.calls.indices().exists(callId => and {
      flow.calls[callId].job == id,
      match flow.calls[callId].rest {
        | TeardownGoesOn(_) => true
        | AgentHearsTheFailure => true
        | CompletionResumes(_) => true
        | _ => false
      },
    })

  /// The task end alarm of the job fires. While this instance still runs the teardown, the alarm
  /// is armed again and nothing else changes. A done author destroys its sandbox again, and its
  /// completion goes on from there. Any other teardown goes on from the destroy of the sandbox, as
  /// a tool call or an event would.
  pure def resumeTaskEnd(flow: Workflow, id: int): Outcome = {
    val task = jobTask(flow, id)
    val teardown = if (task.status == TaskFailed) AfterFail else AfterCancel
    if (teardownCallOut(flow, id)) untold(flow)
    else if (task.status == TaskDone)
      if (destroyIsACall(task)) untold(sendCall(flow, SandboxDestroy, id, CompletionResumes(completionCaller(flow, id, NobodyWaits))))
      else untold(cancelTaskEndAlarm(flow, id))
    else if (destroyIsACall(task))
      untold(sendCall(flow, SandboxDestroy, id, TeardownGoesOn({ teardown: teardown, caller: ToolOrEvent })))
    else teardownGoesOn(flow, id, teardown, ToolOrEvent)
  }

  /// True when the first prompt of a new generation of the task takes its oldest queued prompt.
  /// An author resumes with it. A researcher starts over on its research prompt and leaves the
  /// queue as it is.
  pure def wakesWithAQueuedPrompt(task: Task): bool = task.role == Author

  /// `sendPrompt` with the oldest queued prompt. A harness task's turn holds an instruction it
  /// takes.
  pure def takeQueuedPrompt(task: Task): Task = {
    ...task,
    promptsQueued: task.promptsQueued.tail(),
    instructionHold:
      if (not(runsAsModelCalls(task)) and task.promptsQueued.head() == Instruction) InstructionHeld
      else NoInstructionHeld,
  }

  /// A new generation forgets the turn of the old one, and the instruction that turn held waits
  /// again at the head of the queue.
  pure def returnHeldInstruction(task: Task): Task =
    if (task.instructionHold == NoInstructionHeld) task
    else { ...task, promptsQueued: List(Instruction).concat(task.promptsQueued), instructionHold: NoInstructionHeld }

  /// `onTurnEnd` drops the instruction a turn held, unless a pause cancelled the turn. Then it
  /// waits again at the head of the queue.
  pure def endHeldTurn(task: Task): Task =
    if (task.instructionHold == HeldInACancelledTurn) returnHeldInstruction(task)
    else { ...task, instructionHold: NoInstructionHeld }

  /// The restart reads the task again once its old container went. The restart counted before
  /// the destroy. A finished task stays finished. A paused task waits for its resume to start the
  /// next generation. Otherwise the sandbox comes up, the instruction the old turn held waits
  /// again, and the harness gets its first prompt.
  pure def restartGoesOn(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val returned = returnHeldInstruction(task)
    val woken =
      if (wakesWithAQueuedPrompt(task) and returned.promptsQueued.length() > 0) takeQueuedPrompt(returned)
      else returned
    if (isFinished(task.status)) flow
    else if (task.paused) withTask(flow, id, { ...task, generationClosed: true })
    else
      withTask(flow, id, {
        ...woken,
        status: Busy,
        turnRunning: true,
        promptsSent: task.promptsSent + 1,
      })
  }

  /// True when the job works on the subject issue of a single-issue workflow. A plan that holds
  /// the breakdown stage plans issues, so its workflow is not single-issue.
  pure def worksOnTheSingleSubjectIssue(flow: Workflow, id: int): bool = and {
    not(WRITES_ISSUES),
    match flow.subject {
      | SubjectIssue(issue) => flow.jobs[id].input == FromIssue(issue)
      | _ => false
    },
  }

  /// True when `complete_job` on the job ends the workflow: the job works on the subject issue at
  /// the last planned stage of a single-issue workflow. A plan with stages plans the one stage.
  pure def completesTheWorkflow(flow: Workflow, id: int): bool =
    worksOnTheSingleSubjectIssue(flow, id) and flow.stagePlan != NoStages

  /// Who the completion of the job goes on for: the end of a single-issue workflow that `waiter`
  /// waits on when the job works on its subject issue, a tool call otherwise.
  pure def completionCaller(flow: Workflow, id: int, waiter: EndWaiter): Caller =
    if (worksOnTheSingleSubjectIssue(flow, id)) SubjectJobCompletes(waiter) else ToolOrEvent

  /// `completeJob` ends the author done with the row it read before the check.
  pure def completeAuthor(flow: Workflow, id: int): Outcome =
    endTask(flow, id, TaskDone, AfterComplete, completionCaller(flow, id, CompletionWaits))

  /// `drainModelAuthor` on a model-call author that is not at work. An unpaused author in review
  /// starts a revise turn on its next prompt. An author without its page waits for its provision
  /// alarm to produce it. `eventWaits` is true when a person's event waits for the turn to end.
  pure def takeNextModelTurn(flow: Workflow, id: int, eventWaits: bool): Workflow = {
    val task = jobTask(flow, id)
    if (task.paused or task.status != InReview or task.promptsQueued.length() == 0) flow
    else
      sendCall(
        withTask(flow, id, {
          ...takeQueuedPrompt(task),
          status: Busy,
          promptsSent: task.promptsSent + 1,
        }),
        ModelCall,
        id,
        PageWriteStarts({ eventWaits: eventWaits, prompt: Revises(task.promptsQueued.head()) }),
      )
  }

  /// True for a model-call author queued to produce its page, once the step queued it.
  pure def waitsToProduce(flow: Workflow, id: int): bool = and {
    runsAsModelCalls(jobTask(flow, id)),
    jobTask(flow, id).status == Busy,
    not(jobTask(flow, id).paused),
    flow.jobs[id].artifact == NoArtifact,
    not(modelTurnInFlight(flow, id)),
  }

  /// The provision alarm of each model-call author of the jobs that `drainModelAuthor` queued to
  /// produce its page sends its model call, in the order the authors started. An author that a
  /// stop ended before its page existed is not queued until its next prompt.
  pure def startQueuedModelAuthors(flow: Workflow, drained: Set[int]): Workflow =
    unfinishedJobsInStartOrder(flow).foldl(flow, (starting, id) =>
      if (drained.contains(id) and waitsToProduce(starting, id))
        sendCall(starting, ModelCall, id, PageWriteStarts({ eventWaits: false, prompt: ProducesThePage }))
      else starting)

  /// The prompt that the model turn of the call keeps queued until it applies its answer: the
  /// prompt of a revise turn whose page write a stop did not reach.
  pure def keptPrompt(call: Call): List[QueuedPrompt] = {
    val turnPrompt = match call.rest {
      | PageWriteStarts(turn) => turn.prompt
      | ModelTurnGoesOn(turn) => turn.prompt
      | _ => ProducesThePage
    }
    match turnPrompt {
      | Revises(prompt) => List(prompt)
      | ProducesThePage => List()
    }
  }

  /// The prompt that the cut model turn of the call kept waits again at the head of the queue.
  pure def requeueCutPrompt(flow: Workflow, call: Call): Workflow = {
    val task = jobTask(flow, call.job)
    withTask(flow, call.job, { ...task, promptsQueued: keptPrompt(call).concat(task.promptsQueued) })
  }

  /// `restartLostModelTurn`: past its restarts the author fails. Otherwise the restart counts, and
  /// the author goes back in review when its page is out, or waits busy to produce it. Only the
  /// failure tells the agent.
  pure def restartLostModelTurn(flow: Workflow, id: int): Outcome = {
    val task = jobTask(flow, id)
    val released = withoutLostModelTurn(flow, id)
    if (task.restarts >= MAX_RESTARTS) endTask(released, id, TaskFailed, AfterFail, ToolOrEvent)
    else
      untold(withTask(released, id, {
        ...task,
        restarts: task.restarts + 1,
        status: if (flow.jobs[id].artifact != NoArtifact) InReview else Busy,
      }))
  }

  /// `drainQueue` on a restarted model-call author: it takes its next turn, or produces its page.
  /// An author at work, paused, or finished does not.
  pure def runLostModelTurnAgain(flow: Workflow, id: int): Workflow =
    startQueuedModelAuthors(takeNextModelTurn(flow, id, false), Set(id))

  /// The humans get the page of the job, and the idle clock starts over.
  pure def handOverPage(flow: Workflow, id: int): Workflow =
    { ...withJob(flow, id, { ...flow.jobs[id], artifact: Ready }), idleArmed: true }

  /// The model call returns. A finished author drops the answer, and an event that waited on the
  /// turn tells the agent. Otherwise the model turn writes the answer to the page: a produce turn
  /// creates the page, and a revise turn rewrites it.
  pure def modelCallAnswered(flow: Workflow, id: int, turn: ModelTurn): Outcome =
    if (isFinished(jobTask(flow, id).status)) { flow: flow, told: turn.eventWaits }
    else untold(sendCall(flow, PageWrite, id, ModelTurnGoesOn(turn)))

  /// True when the author of the job does not work and no prompt waits for it: no harness turn
  /// runs, and no model turn is in flight.
  pure def authorQuiet(flow: Workflow, id: int): bool = and {
    not(jobTask(flow, id).turnRunning),
    not(modelTurnInFlight(flow, id)),
    jobTask(flow, id).promptsQueued.length() == 0,
  }

  /// The settle after a turn of a model-call author on a draft: a reviewer starts on it once the
  /// author is quiet and no refiner run is on it.
  pure def reviewModelPage(flow: Workflow, id: int): Workflow =
    if (REFINER == NoRefiner or refinerRunning(flow.jobs[id]) or not(authorQuiet(flow, id))) flow
    else withJob(flow, id, startRefinerRun(flow.jobs[id]))

  /// The page write of a model turn returns, and the turn goes on. An author that finished
  /// meanwhile leaves its job as it was. A produce turn hands the page over. A revise turn makes
  /// the page a draft again until the author takes no further prompt. A stage with a reviewer
  /// keeps the page a draft, and its reviewer starts once the author is quiet. The next turn
  /// carries the event that waits on this one. Once the author takes no next turn, the agent hears
  /// that the turn ended unless the stage runs refiners, and the event that waited tells the agent.
  pure def modelTurnEnds(flow: Workflow, id: int, turn: ModelTurn): Outcome = {
    val task = jobTask(flow, id)
    val inReview = withTask(flow, id, { ...task, status: InReview })
    val drafted = withJob(inReview, id, { ...inReview.jobs[id], artifact: Drafted })
    val ended =
      if (isFinished(task.status)) flow
      else if (REFINER != NoRefiner) takeNextModelTurn(reviewModelPage(drafted, id), id, turn.eventWaits)
      else if (flow.jobs[id].artifact == NoArtifact) takeNextModelTurn(handOverPage(inReview, id), id, turn.eventWaits)
      else {
        val drained = takeNextModelTurn(drafted, id, turn.eventWaits)
        if (modelTurnInFlight(drained, id)) drained else handOverPage(drained, id)
      }
    val turnsEnd = isFinished(task.status) or not(modelTurnInFlight(ended, id))
    val toldTheTurnEnd = not(isFinished(task.status)) and REFINER == NoRefiner
    { flow: ended, told: turnsEnd and (turn.eventWaits or toldTheTurnEnd) }
  }

  /// The teardown of the job's finished harness author destroyed its sandbox.
  pure def sandboxDestroyed(flow: Workflow, id: int): Workflow =
    { ...flow, destroyedSandboxes: flow.destroyedSandboxes.union(Set(id)) }

  pure def returnCall(flow: Workflow, callId: int): Outcome = {
    val call = flow.calls[callId]
    val returned = withoutCall(flow, callId)
    match call.rest {
      | TeardownGoesOn(teardown) =>
        teardownGoesOn(sandboxDestroyed(returned, call.job), call.job, teardown.teardown, teardown.caller)
      | AgentHearsTheFailure => failureHeard(returned, call.job)
      | ResearcherSandboxGone =>
        untold({ ...returned, researcherEndAlarms: returned.researcherEndAlarms.exclude(Set(call.job)) })
      | CompletionResumes(caller) =>
        teardownGoesOn(sandboxDestroyed(returned, call.job), call.job, AfterComplete, caller)
      | RestartGoesOn => untold(restartGoesOn(returned, call.job))
      | RestartAfterWake => untold(returned)
      | CompletionGoesOn => untold(returned)
      | PageWriteStarts(turn) => modelCallAnswered(returned, call.job, turn)
      | ModelTurnGoesOn(turn) => modelTurnEnds(returned, call.job, turn)
      | ModelCallStopped(turn) => { flow: returned, told: turn.eventWaits }
      | StoppedTurnGoesOn(turn) => stoppedTurnEnds(returned, call.job, turn)
    }
  }

  /// The page write of a model turn that a stop reached returns, and the turn ends as any turn
  /// does. An author left without a turn and without a prompt since the stop stays stopped.
  pure def stoppedTurnEnds(flow: Workflow, id: int, turn: ModelTurn): Outcome = {
    val ended = modelTurnEnds(flow, id, turn)
    val task = jobTask(ended.flow, id)
    if (isFinished(task.status) or modelTurnInFlight(ended.flow, id) or task.promptsQueued.length() > 0) ended
    else { ...ended, flow: withTask(ended.flow, id, { ...task, stopped: true }) }
  }

  /// A restart of the Durable Object drops every call that is out. A task whose restart it
  /// dropped waits queued with its restart counted, so the start step provisions it as the
  /// restart would have. A paused one keeps its generation closed until its resume.
  pure def dropCalls(flow: Workflow): Workflow = {
    val stranded = flow.calls.indices().filter(callId =>
      flow.calls[callId].rest == RestartGoesOn and
      not(isFinished(jobTask(flow, flow.calls[callId].job).status))).map(callId => flow.calls[callId].job)
    val dropped = { ...flow, calls: List(), endCall: NoEndCall }
    range(0, MAX_JOBS).select(id => stranded.contains(id)).foldl(dropped, (restarting, id) =>
      restartGoesOn(restarting, id))
  }

  /// An instance restart drops every call that is out. The start step arms one restart alarm for
  /// every model turn the authors still hold, also one an earlier restart cut and one that waits
  /// for its run-again alarm. That one counts as lost again. The prompt of a
  /// revise turn the restart cut waits again unless a stop reached its page write. The alarms of
  /// earlier restarts stay armed. The review loop spec holds the lost rulings the alarm asks again.
  /// The workflow end the store holds stays, and the start step arms the alarm that goes on with it.
  /// Each task end alarm stays armed.
  pure def restartWorkflow(flow: Workflow): Workflow = {
    val held = modelTurnsInFlight(flow)
    val cut = held.filter(id => not(lostModelTurn(flow, id)) and not(flow.turnsToRunAgain.contains(id)))
    val requeued = flow.calls.foldl(dropCalls(flow), (requeuing, call) =>
      if (isModelTurnCall(call) and cut.contains(call.job)) requeueCutPrompt(requeuing, call) else requeuing)
    if (held.size() == 0) requeued else { ...requeued, restartAlarms: requeued.restartAlarms.union(Set(held)) }
  }

  /// The restart alarm decides the lost model turn of each of its jobs, in the order their authors
  /// started. Each author it restarts holds a new turn id until its own alarm runs that turn again.
  pure def decideLostModelTurns(flow: Workflow, jobs: Set[int]): Outcome = {
    val decided = unfinishedJobsInStartOrder(flow).select(id => jobs.contains(id)).foldl(untold(flow), (deciding, id) => {
      val lost = restartLostModelTurn(deciding.flow, id)
      val runsAgain = if (isFinished(jobTask(lost.flow, id).status)) lost.flow
        else {
          ...lost.flow,
          runAgainAlarms: lost.flow.runAgainAlarms.union(Set(id)),
          turnsToRunAgain: lost.flow.turnsToRunAgain.union(Set(id)),
        }
      { flow: runsAgain, told: deciding.told or lost.told }
    })
    { ...decided, flow: { ...decided.flow, restartAlarmFired: true } }
  }

  /// The alarm of the job's restarted author fires. While the author still holds the turn id the
  /// alarm names, it lets go of it and runs its lost model turn again. Otherwise it does nothing.
  pure def lostTurnRunsAgain(flow: Workflow, id: int): Workflow = {
    val ran =
      if (flow.turnsToRunAgain.contains(id)) runLostModelTurnAgain(withoutLostModelTurn(flow, id), id)
      else flow
    { ...ran, runAgainAlarms: ran.runAgainAlarms.exclude(Set(id)), ranAgain: ran.ranAgain.union(Set(id)) }
  }

  /// `resumeTask` on a harness task queues the resume prompt and sends the head of the queue.
  /// The prompt waits while the bridge still runs the turn the pause cancelled. Without a bridge
  /// it starts the next generation for it, also while a restart is closing the old container. A
  /// restart that an earlier resume overtook left that resume's generation running, so the
  /// prompt waits for its turn. A researcher's turn runs until it hands over, so its resume
  /// prompt waits.
  pure def resumeHarnessTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val waits = task.turnRunning and not(task.generationClosed) and not(restartClosesTheContainer(flow, id))
    val queued = { ...task, promptsQueued: task.promptsQueued.append(OtherPrompt) }
    val calls = flow.calls.foldl(List(), (calls, call) => calls.append(
      if (call.job == id and call.rest == RestartGoesOn)
        { ...call, rest: RestartAfterWake }
      else call))
    withTask({ ...flow, calls: calls }, id, {
      ...if (waits) queued else takeQueuedPrompt(returnHeldInstruction(queued)),
      paused: false,
      turnRunning: true,
      promptsSent: if (waits) task.promptsSent else task.promptsSent + 1,
      generationClosed: false,
      status: if (task.status == InReview) Busy else task.status,
    })
  }

  /// True while the destroy of the old container of the job's restarting task is out.
  pure def restartClosesTheContainer(flow: Workflow, id: int): bool =
    flow.calls.indices().exists(callId =>
      flow.calls[callId].job == id and flow.calls[callId].kind == SandboxDestroy and
        flow.calls[callId].rest == RestartGoesOn)

  /// True while a polisher runs on the page of the job's author and holds the author's prompts.
  pure def polisherHoldsPrompts(flow: Workflow, id: int): bool = and {
    REFINER == APolisher,
    jobTask(flow, id).role == Author,
    refinerRunning(flow.jobs[id]),
  }

  /// `promptTask` queues a prompt for the job's task. A paused task keeps it, and so does an
  /// author whose page a polisher holds. An unpaused harness task gets it at once when no turn
  /// runs, in a new generation when its container is closed. A model-call author that is not at
  /// work takes its next turn, or produces its page first. `eventWaits` is true when the prompt
  /// comes from a person's event, which waits for the turn it starts.
  pure def promptTask(flow: Workflow, id: int, eventWaits: bool, prompt: QueuedPrompt): Workflow = {
    val task = jobTask(flow, id)
    val queuedTask = { ...task, promptsQueued: task.promptsQueued.append(prompt), stopped: false }
    val queued = withTask(flow, id, queuedTask)
    if (isFinished(task.status)) flow
    else if (task.paused or polisherHoldsPrompts(flow, id)) queued
    else if (runsAsModelCalls(task)) {
      if (modelTurnInFlight(flow, id)) queued
      else startQueuedModelAuthors(takeNextModelTurn(queued, id, eventWaits), Set(id))
    }
    else if (task.turnRunning) queued
    else
      withTask(flow, id, {
        ...takeQueuedPrompt(queuedTask),
        status: Busy,
        turnRunning: true,
        promptsSent: task.promptsSent + 1,
        generationClosed: false,
      })
  }

  /// The author whose page a polisher held takes its oldest queued prompt once the polisher ends,
  /// in a new generation.
  pure def takePromptAfterPolisher(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    if (REFINER != APolisher or isFinished(task.status) or task.paused or task.promptsQueued.length() == 0) flow
    else
      withTask(flow, id, {
        ...takeQueuedPrompt(task),
        status: Busy,
        turnRunning: true,
        promptsSent: task.promptsSent + 1,
        generationClosed: false,
      })
  }

  /// `pauseTask`: an unfinished task that is not paused holds its prompts from now on. It cancels
  /// the turn its harness runs, unless a restart is closing the container of that turn.
  pure def pauseTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val cancels = and {
      task.instructionHold == InstructionHeld,
      not(task.generationClosed),
      not(restartClosesTheContainer(flow, id)),
    }
    if (isFinished(task.status) or task.paused) flow
    else withTask(flow, id, {
      ...task,
      paused: true,
      instructionHold: if (cancels) HeldInACancelledTurn else task.instructionHold,
    })
  }

  /// `resumeTask`: a paused task goes on with the resume prompt. A model-call author takes it as
  /// any prompt, and an author whose page a polisher holds queues it.
  pure def resumeTask(flow: Workflow, id: int, eventWaits: bool): Workflow = {
    val task = jobTask(flow, id)
    val unpaused = withTask(flow, id, { ...task, paused: false })
    if (isFinished(task.status) or not(task.paused)) flow
    else if (runsAsModelCalls(task) or polisherHoldsPrompts(flow, id)) promptTask(unpaused, id, eventWaits, OtherPrompt)
    else resumeHarnessTask(flow, id)
  }

  /// A person's message wakes a sleeping workflow and starts the idle clock over.
  pure def messageWakes(flow: Workflow): Workflow =
    { ...flow, idleArmed: true, status: if (flow.status == WaitingInput) Running else flow.status }

  /// A verbal command acts on the task of the one active job. With none or several, it goes to
  /// the agent.
  pure def verbalCommandActs(flow: Workflow, command: VerbalCommand): Workflow = {
    val active = unfinishedJobIds(flow)
    if (active.length() != 1) flow
    else match command {
      | Pause => pauseTask(flow, active[0])
      | Resume => resumeTask(flow, active[0], true)
      | Instruct => promptTask(flow, active[0], true, Instruction)
    }
  }

  /// The turn that wrote the page ends. A queued prompt goes out at once, and the refiners wait
  /// for the author to be quiet. Without refiners the humans get the page at once. A polisher
  /// closes the author's container as it starts.
  pure def pageWritten(flow: Workflow, id: int): Workflow = {
    val job = flow.jobs[id]
    val author = endHeldTurn(jobTask(flow, id))
    val queued = author.promptsQueued.length() > 0
    val wrote =
      if (queued)
        withTask(flow, id, { ...takeQueuedPrompt(author), promptsSent: author.promptsSent + 1 })
      else withTask(flow, id, { ...author, status: InReview, turnRunning: false })
    val tasks = wrote.jobs[id].tasks
    if (REFINER == NoRefiner) { ...withJob(wrote, id, { ...job, tasks: tasks, artifact: Ready }), idleArmed: true }
    else if (queued) withJob(wrote, id, { ...job, tasks: tasks, artifact: Drafted })
    else {
      val reviewed = withJob(wrote, id, { ...startRefinerRun(job), tasks: tasks, artifact: Drafted })
      if (REFINER == APolisher) withTask(reviewed, id, { ...jobTask(reviewed, id), generationClosed: true })
      else reviewed
    }
  }

  /// The refiner run approves. The humans get the page only while the author is quiet. The author
  /// takes a prompt that waited for the polisher.
  pure def refinerRunFinished(flow: Workflow, id: int): Workflow = {
    val job = flow.jobs[id]
    val handedOver = job.artifact == Drafted and authorQuiet(flow, id)
    val finished = { ...endLastRefinerRun(job, RefinerDone), artifact: if (handedOver) Ready else job.artifact }
    takePromptAfterPolisher({ ...withJob(flow, id, finished), idleArmed: flow.idleArmed or handedOver }, id)
  }

  /// The refiner run fails, and the humans get the page blocked, also while the author works. The
  /// author takes a prompt that waited for the polisher.
  pure def refinerRunFailed(flow: Workflow, id: int): Workflow =
    takePromptAfterPolisher(handOverPage(withJob(flow, id, endLastRefinerRun(flow.jobs[id], RefinerFailed)), id), id)

  /// True when the task's harness is on a turn the agent did not pause, in a generation that runs.
  pure def taskWorks(flow: Workflow, id: int): bool =
    taskStuck(flow, id) and not(jobTask(flow, id).generationClosed)

  /// True when the task's harness turn runs unpaused and its sandbox is not on its way out.
  pure def taskStuck(flow: Workflow, id: int): bool = and {
    jobTask(flow, id).status == Busy,
    jobTask(flow, id).turnRunning,
    not(jobTask(flow, id).paused),
    not(flow.calls.indices().exists(callId =>
      flow.calls[callId].job == id and flow.calls[callId].kind == SandboxDestroy)),
  }

  pure def sleeps(flow: Workflow): bool = flow.status == Running and busyJobs(flow).size() == 0

  /// The job that opened the pull the job works on: the job itself, or the one whose pull it
  /// continues.
  pure def pullOpenerOf(flow: Workflow, id: int): int = match flow.jobs[id].input {
    | FromArtifactOf(opener) => opener
    | _ => id
  }

  /// The jobs on the pull the opener opened: the opener and each job that continues its pull, in
  /// the order they started.
  pure def pullChain(flow: Workflow, opener: int): List[int] =
    range(0, MAX_JOBS).select(id =>
      id < flow.jobs.length() and (id == opener or flow.jobs[id].input == FromArtifactOf(opener)))

  /// The job whose artifact stands for the opener's pull: the one whose task is unfinished, else
  /// the one that started last. The opener records its artifact as it opens the pull.
  pure def pullHolder(flow: Workflow, opener: int): int = {
    val recorded = pullChain(flow, opener).select(id => flow.jobs[id].artifact != NoArtifact)
    val working = recorded.select(id => not(isFinished(jobTask(flow, id).status)))
    if (working.length() > 0) working[0] else recorded[recorded.length() - 1]
  }

  pure def withPullOnHost(flow: Workflow, opener: int, state: PullOnHost): Workflow =
    withJob(flow, opener, { ...flow.jobs[opener], pullOnHost: state })

  /// `advanceArtifact`: a drafted or ready artifact of the job moves to `status`. Any other stays.
  pure def advanceArtifact(flow: Workflow, id: int, status: ArtifactStatus): Workflow = {
    val artifact = flow.jobs[id].artifact
    if (artifact == Drafted or artifact == Ready) withJob(flow, id, { ...flow.jobs[id], artifact: status })
    else flow
  }

  /// True when a job on the issue completed.
  pure def issueJobCompleted(flow: Workflow, issue: int): bool =
    jobsOnIssue(flow, issue).foldl(false, (found, id) => found or jobTask(flow, id).status == TaskDone)

  /// True when an unfinished job works from the input.
  pure def inputInWork(flow: Workflow, input: Input): bool =
    jobIds(flow).exists(id => flow.jobs[id].input == input and not(isFinished(jobTask(flow, id).status)))

  /// `validateEarlierOutputRemoved` on the finished jobs on the issue, in the order they started.
  /// A pull the host closed unmerged is recorded removed. The first artifact the host still holds
  /// refuses the start, unless it is the job's input, and the removals recorded before it stay.
  pure def recordEarlierPullsRemoved(flow: Workflow, issue: int): { flow: Workflow, clear: bool } =
    range(0, MAX_JOBS).foldl({ flow: flow, clear: true }, (checked, id) => {
      val earlier = and {
        id < flow.jobs.length(),
        flow.jobs[id].input == FromIssue(issue),
        isFinished(jobTask(flow, id).status),
      }
      if (not(checked.clear) or not(earlier)) checked
      else {
        val artifact = checked.flow.jobs[id].artifact
        if (artifact == NoArtifact or artifact == Removed or outputIsItsInput(checked.flow, id)) checked
        else if (artifact != Accepted and checked.flow.jobs[id].pullOnHost == PullClosed)
          { ...checked, flow: advanceArtifact(checked.flow, id, Removed) }
        else { ...checked, clear: false }
      }
    })

  /// The host moves the opener's pull. A merge records the artifact that stands for it accepted.
  /// A close without a merge records it removed and cancels its job. A reopen records nothing,
  /// and neither does an ended workflow.
  pure def pullMoved(flow: Workflow, opener: int, hostMove: HostMove): Outcome = {
    val holder = pullHolder(flow, opener)
    match hostMove {
      | Merged => {
        val merged = withPullOnHost(flow, opener, PullMerged)
        untold(if (hasEnded(flow.status)) merged else advanceArtifact(merged, holder, Accepted))
      }
      | ClosedUnmerged => {
        val closed = withPullOnHost(flow, opener, PullClosed)
        val removed = advanceArtifact(closed, holder, Removed)
        if (hasEnded(flow.status)) untold(closed)
        else if (isFinished(jobTask(removed, holder).status)) untold(removed)
        else endTask(removed, holder, TaskCancelled, AfterCancel, ToolOrEvent)
      }
      | Reopened => untold(withPullOnHost(flow, opener, PullOpen))
    }
  }

  /// The cancel of the workflow, unless another end runs.
  pure def cancelUnlessEnding(flow: Workflow): Outcome =
    if (workflowEnding(flow)) untold(flow) else continueWorkflowEnd(flow, Cancelled, AnEventWaits)

  /// The jobs on the issue, in the order they started.
  pure def jobsOnIssue(flow: Workflow, issue: int): List[int] =
    range(0, MAX_JOBS).select(id => id < flow.jobs.length() and flow.jobs[id].input == FromIssue(issue))

  /// A person moves the issue to a canceled or completed state, and the tracker shows it ended.
  /// The newest job on the issue owns the cancel. An accepted artifact of the owner keeps the
  /// workflow as it is. The owner on an issue other than the subject issue is cancelled alone,
  /// unless it is over. Any other cancel ends the workflow.
  pure def issueEnded(flow: Workflow, issue: int): Outcome = {
    val ended = { ...flow, endedIssues: flow.endedIssues.union(Set(issue)) }
    val owners = jobsOnIssue(flow, issue)
    if (hasEnded(flow.status)) untold(ended)
    else if (owners.length() == 0) cancelUnlessEnding(ended)
    else {
      val owner = owners[owners.length() - 1]
      if (flow.jobs[owner].artifact == Accepted) untold(ended)
      else if (flow.subject == SubjectIssue(issue)) cancelUnlessEnding(ended)
      else if (isFinished(jobTask(flow, owner).status)) untold(ended)
      else endTask(ended, owner, TaskCancelled, AfterCancel, ToolOrEvent)
    }
  }

  /// `authorInSession` on the session of the subject issue: the unfinished author of a job on the
  /// subject issue, else the author of the last one. A job whose researcher runs has no author yet.
  pure def sessionAuthor(flow: Workflow): List[int] = {
    val onSubject = jobsOnIssue(flow, SUBJECT_ISSUE).select(id => jobTask(flow, id).role == Author)
    val unfinished = onSubject.select(id => not(isFinished(jobTask(flow, id).status)))
    if (unfinished.length() > 0) List(unfinished[0])
    else if (onSubject.length() > 0) List(onSubject[onSubject.length() - 1])
    else List()
  }

  /// `runningAuthorInSession` on the session of the subject issue: its author while it runs. A
  /// person's text there goes to it as a prompt.
  pure def runningSessionAuthor(flow: Workflow): List[int] =
    sessionAuthor(flow).select(id => jobTask(flow, id).status == Busy)

  /// `stopAuthor` on the author of the job: its queued prompts go. A model turn whose model call
  /// is out ends, and the answer of that call changes nothing. The author goes back in review when
  /// its page is out, and otherwise waits busy for its next prompt. A lost model turn that waits
  /// for its run-again alarm ends too. A model turn whose page write is out stays in flight and
  /// ends once the write returns. A model-call author the stop leaves without a turn is stopped.
  pure def stopAuthor(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val stoppedCalls = flow.calls.foldl(List(), (calls, call) => calls.append(
      if (call.job != id) call
      else match call.rest {
        | PageWriteStarts(turn) => { ...call, rest: ModelCallStopped(turn) }
        | ModelTurnGoesOn(turn) => { ...call, rest: StoppedTurnGoesOn(turn) }
        | _ => call
      }))
    val dropped = { ...task, promptsQueued: List(), instructionHold: NoInstructionHeld }
    val quiet = { ...dropped, stopped: runsAsModelCalls(task) }
    if (not(modelTurnInFlight(flow, id))) withTask(flow, id, quiet)
    else if (pageWriteOut(flow, id)) withTask({ ...flow, calls: stoppedCalls }, id, dropped)
    else
      withoutLostModelTurn(withTask({ ...flow, calls: stoppedCalls }, id, {
        ...quiet,
        status: if (flow.jobs[id].artifact == NoArtifact) Busy else InReview,
      }), id)
  }

  /// True for a call whose return the event that sent it waits on: a sandbox destroy, a failure
  /// post, or a model turn its prompt started.
  pure def eventWaitsOn(call: Call): bool = match call.rest {
    | TeardownGoesOn(_) => true
    | AgentHearsTheFailure => true
    | PageWriteStarts(turn) => turn.eventWaits
    | ModelTurnGoesOn(turn) => turn.eventWaits
    | _ => false
  }

  /// An event on a live workflow tells the agent once its handling ends. The handling waits on
  /// each sandbox destroy it sends, on the model turn its prompt starts, and on the calls of the
  /// workflow end it starts. A cancel that ends a task at once tells the agent in the step.
  pure def eventHandled(before: Workflow, handled: Outcome): Outcome = {
    val sent = handled.flow.calls.indices().filter(callId => callId >= before.calls.length())
    val sentAnEndCall = before.endCall == NoEndCall and handled.flow.endCall != NoEndCall
    val waits = sentAnEndCall or sent.exists(callId => eventWaitsOn(handled.flow.calls[callId]))
    { ...handled, told: not(hasEnded(before.status)) and (handled.told or not(waits)) }
  }

  action move(after: Outcome, kind: StepKind): bool = moveAnswering(after, kind, NotAnswered)

  /// A step in which `complete_job` told the agent `answered`.
  action moveAnswering(after: Outcome, kind: StepKind, answered: CompletionAnswer): bool = {
    val step = { before: workflow, after: after.flow, kind: kind, toldTheAgent: after.told, answered: answered }
    all {
      workflow' = after.flow,
      lastStepKept' = rulesKeptBy(step),
      lastStepReached' = witnessesReachedBy(step),
      lastStepToldTheAgent' = after.told,
      lastStepAnswered' = answered,
    }
  }

  action onJob(act: int => bool): bool = all {
    workflow.jobs.length() > 0,
    nondet id = jobIds(workflow).oneOf()
    act(id),
  }

  action onJobWhere(eligible: int => bool, act: int => bool): bool = {
    val ids = jobIds(workflow).filter(eligible)
    all {
      ids.size() > 0,
      nondet id = ids.oneOf()
      act(id),
    }
  }

  action init: bool = {
    val step = {
      before: INITIAL_WORKFLOW,
      after: INITIAL_WORKFLOW,
      kind: OtherStep,
      toldTheAgent: false,
      answered: NotAnswered,
    }
    all {
      workflow' = INITIAL_WORKFLOW,
      lastStepKept' = rulesKeptBy(step),
      lastStepReached' = witnessesReachedBy(step),
      lastStepToldTheAgent' = false,
      lastStepAnswered' = NotAnswered,
    }
  }

  /// The agent calls `set_plan` with a workflow definition while the workflow has not ended. The
  /// call that starts the workflow may leave out the stages. A plan with stages sets the number of
  /// job slots, also below the jobs that run. A plan may name the subject, which it sets when the
  /// workflow does not have one. A plan is refused while the workflow ends, when it names a workflow
  /// definition the deployment does not hold or another one than the workflow started from, when
  /// it names another subject than the workflow has, and when it leaves out the stages on a
  /// started workflow. The plan that starts a workflow from a tracker origin moves its issue to
  /// started.
  action agentSetsPlan: bool = all {
    not(hasEnded(workflow.status)),
    nondet definition = NAMED_DEFINITIONS.oneOf()
    nondet withStages = Set(true, false).oneOf()
    nondet jobSlots = SLOT_COUNTS.oneOf()
    nondet subjectLink = PLAN_SUBJECTS.oneOf()
    agentSetsPlanWith(definition, withStages, jobSlots, subjectLink),
  }

  /// The agent sets a plan again with fewer job slots than the jobs that run. It is a copy of
  /// `agentSetsPlan` that a step picks as often as any other kind of step.
  action theAgentPlansFewerSlotsThanJobsRun: bool = all {
    not(hasEnded(workflow.status)),
    SLOT_COUNTS.exists(slots => slots < unfinishedCount(workflow)),
    NAMED_DEFINITIONS.exists(definition => workflow.definition == Planned(definition)),
    nondet definition = NAMED_DEFINITIONS.filter(named => workflow.definition == Planned(named)).oneOf()
    nondet withStages = Set(true).oneOf()
    nondet jobSlots = SLOT_COUNTS.filter(slots => slots < unfinishedCount(workflow)).oneOf()
    nondet subjectLink = Set(NoSubject).oneOf()
    agentSetsPlanWith(definition, withStages, jobSlots, subjectLink),
  }

  /// The agent calls `set_plan` with the definition, the stages and their job slots, and the subject.
  action agentSetsPlanWith(definition: int, withStages: bool, jobSlots: int, subjectLink: Subject): bool = {
    val refused = planRefused(workflow, definition, withStages, subjectLink)
    val movesTheIssue = workflow.definition == Unplanned and TRACKER_ORIGIN
    val planned = {
      ...workflow,
      definition: Planned(definition),
      status: Running,
      stagePlan: if (withStages) StagesPlanned(jobSlots) else workflow.stagePlan,
      subject: if (workflow.subject == NoSubject) subjectLink else workflow.subject,
      issueMoves: if (movesTheIssue) workflow.issueMoves + 1 else workflow.issueMoves,
    }
    move(untold(if (refused) workflow else planned), PlanStep({ definition: definition, subject: subjectLink }))
  }

  /// True when `set_plan` refuses a plan: the workflow ends, the plan names a definition the
  /// deployment does not hold or another one than the workflow started from, it names another
  /// subject, or it leaves out the stages on a started workflow.
  pure def planRefused(flow: Workflow, definition: int, withStages: bool, subjectLink: Subject): bool = or {
    workflowEnding(flow),
    not(DEFINITIONS.contains(definition)),
    flow.definition != Unplanned and flow.definition != Planned(definition),
    and {
      subjectLink != NoSubject,
      flow.subject != NoSubject,
      subjectLink != flow.subject,
    },
    not(withStages) and flow.definition != Unplanned,
  }

  /// The agent calls `start_job` for the stage in a turn a request woke. It may be refused. A
  /// workflow from a tracker origin starts its jobs on issues here.
  action agentStartsJob: bool = all {
    not(TRACKER_ORIGIN),
    workflow.jobs.length() < MAX_JOBS,
    nondet request = REQUESTS.oneOf()
    agentStartsJobOnRequest(request),
  }

  /// The agent starts a job that `start_job` takes, on a request or on an issue. It is a copy of
  /// `agentStartsJob` and `agentStartsJobOnAnIssue` that a step picks as often as any other kind of
  /// step, so the workflow does not spend its steps on refused starts.
  action theAgentStartsAJobItTakes: bool = any { theAgentStartsAJobOnARequest, theAgentStartsAJobOnAnIssue }

  /// The agent starts a job on a request whose input no job holds.
  action theAgentStartsAJobOnARequest: bool = all {
    not(TRACKER_ORIGIN),
    workflow.jobs.length() < MAX_JOBS,
    startAllowed(workflow),
    requestsItTakes(workflow).size() > 0,
    nondet request = requestsItTakes(workflow).oneOf()
    agentStartsJobOnRequest(request),
  }

  /// The agent starts a job on an issue that `start_job` does not refuse at once.
  action theAgentStartsAJobOnAnIssue: bool = all {
    STARTS_ON_ISSUES,
    workflow.jobs.length() < MAX_JOBS,
    issuesItTakes(workflow).size() > 0,
    nondet issue = issuesItTakes(workflow).oneOf()
    agentStartsJobOn(issue),
  }

  /// The requests whose input no job holds.
  pure def requestsItTakes(flow: Workflow): Set[int] =
    REQUESTS.filter(request => not(inputHeld(flow, inputFor(flow, request))))

  /// The issues that `start_job` does not refuse at once.
  pure def issuesItTakes(flow: Workflow): Set[int] = ISSUES.filter(issue => not(issueStartRefusedAtOnce(flow, issue)))

  /// The agent sets the first plan of the workflow with a definition the deployment holds. It is a
  /// copy of `agentSetsPlan` that a step picks as often as any other kind of step, so the workflow
  /// does not spend its steps on refused plans.
  action theAgentPlansTheWorkflow: bool = all {
    workflow.definition == Unplanned,
    not(hasEnded(workflow.status)),
    not(workflowEnding(workflow)),
    nondet definition = DEFINITIONS.oneOf()
    nondet withStages = Set(true, false).oneOf()
    nondet jobSlots = SLOT_COUNTS.oneOf()
    nondet subjectLink = PLAN_SUBJECTS.oneOf()
    agentSetsPlanWith(definition, withStages, jobSlots, subjectLink),
  }

  /// The agent calls `start_job` on the request.
  action agentStartsJobOnRequest(request: int): bool = {
    val input = inputFor(workflow, request)
    val refused = not(startAllowed(workflow)) or inputHeld(workflow, input)
    nondet routerWriteFails = Set(true, false).oneOf()
    val started =
      if (routerWriteFails) startedJobPastAFailedRouterWrite(workflow, input) else startedJob(workflow, input)
    move(
      untold(if (refused) workflow else started),
      JobStartStep({ routerWriteFails: routerWriteFails }),
    )
  }

  /// True while a job can start: a plan started the workflow, it has not ended, no end runs, and
  /// a slot is free.
  pure def startAllowed(flow: Workflow): bool = and {
    flow.definition != Unplanned,
    not(hasEnded(flow.status)),
    not(workflowEnding(flow)),
    hasAFreeJobSlot(flow),
  }

  /// The agent calls `start_job` for the stage on the subject issue, its sub-issue, or an issue
  /// outside the subject, also one an earlier job took. An issue outside the subject is refused,
  /// and so is any issue before the workflow has a subject. The tracker refuses an issue a person
  /// ended. An unfinished job on the issue refuses it, and so does a job on it that completed.
  /// After that, an earlier artifact the host still holds refuses it. A start on an issue whose
  /// earlier jobs were cancelled or failed is a retry. The start claims the issue, which moves it
  /// to started. The status write comes before the claim, so a status write that fails leaves the
  /// issue where it was.
  action agentStartsJobOnAnIssue: bool = all {
    STARTS_ON_ISSUES,
    workflow.jobs.length() < MAX_JOBS,
    nondet issue = ISSUES.oneOf()
    agentStartsJobOn(issue),
  }

  /// True when `start_job` refuses the issue before it reads the host for earlier artifacts.
  pure def issueStartRefusedAtOnce(flow: Workflow, issue: int): bool = or {
    not(startAllowed(flow)),
    not(issueInSubject(flow.subject, issue)),
    flow.endedIssues.contains(issue),
    inputInWork(flow, FromIssue(issue)),
    issueJobCompleted(flow, issue),
  }

  /// The agent calls `start_job` for the stage on `issue`.
  action agentStartsJobOn(issue: int): bool = {
    nondet routerWriteFails = Set(true, false).oneOf()
    val input = FromIssue(issue)
    val earlier = recordEarlierPullsRemoved(workflow, issue)
    val started =
      if (routerWriteFails) startedJobPastAFailedRouterWrite(earlier.flow, input)
      else startedJob(earlier.flow, input)
    val claimed = not(routerWriteFails) or workflow.status == Running
    move(
      untold(
        if (issueStartRefusedAtOnce(workflow, issue)) workflow
        else if (not(earlier.clear)) earlier.flow
        else { ...started, issueMoves: if (claimed) started.issueMoves + 1 else started.issueMoves },
      ),
      IssueStartStep({ issue: issue, routerWriteFails: routerWriteFails }),
    )
  }

  /// The agent starts a job on a request once a job completed with a page the humans have, so the
  /// job builds on that page. It is a copy of `agentStartsJob` that a step picks as often as any
  /// other kind of step.
  action agentStartsJobOnADonePage: bool = all {
    startAllowed(workflow),
    jobIds(workflow).exists(id => jobTask(workflow, id).status == TaskDone and workflow.jobs[id].artifact == Ready),
    REQUESTS.exists(request => not(inputHeld(workflow, inputFor(workflow, request)))),
    agentStartsJob,
  }

  /// The agent starts a job on an issue in the subject whose earlier job finished. It is a copy of
  /// `agentStartsJobOnAnIssue` that a step picks as often as any other kind of step, so a job
  /// retries an issue, or a start on an issue whose job completed is refused.
  action agentStartsJobAgainOnAnIssue: bool = all {
    STARTS_ON_ISSUES,
    workflow.jobs.length() < MAX_JOBS,
    startAllowed(workflow),
    issuesWithAFinishedJob(workflow).size() > 0,
    nondet issue = issuesWithAFinishedJob(workflow).oneOf()
    agentStartsJobOn(issue),
  }

  /// The issues in the subject, which a person did not end, whose job finished and none works.
  pure def issuesWithAFinishedJob(flow: Workflow): Set[int] = ISSUES.filter(issue => and {
    issueInSubject(flow.subject, issue),
    not(flow.endedIssues.contains(issue)),
    not(inputInWork(flow, FromIssue(issue))),
    jobsOnIssue(flow, issue).length() > 0,
  })

  /// The issues that `start_job` takes, whose finished job has a page and a pull the host closed,
  /// which the store does not record removed yet.
  pure def issuesWithAnUnrecordedClosedPull(flow: Workflow): Set[int] =
    ISSUES.filter(issue => not(issueStartRefusedAtOnce(flow, issue)) and jobIds(flow).exists(id => and {
      flow.jobs[id].input == FromIssue(issue),
      isFinished(jobTask(flow, id).status),
      flow.jobs[id].pullOnHost == PullClosed,
      flow.jobs[id].artifact == Drafted or flow.jobs[id].artifact == Ready,
      not(outputIsItsInput(flow, id)),
    }))

  /// The agent starts a job on an issue whose earlier pull the host closed. It is a copy of
  /// `agentStartsJobOnAnIssue` that a step picks as often as any other kind of step, so a start
  /// records the closed pull removed.
  action agentStartsJobOnAnIssueWithAClosedPull: bool = all {
    STARTS_ON_ISSUES,
    workflow.jobs.length() < MAX_JOBS,
    issuesWithAnUnrecordedClosedPull(workflow).size() > 0,
    nondet issue = issuesWithAnUnrecordedClosedPull(workflow).oneOf()
    agentStartsJobOn(issue),
  }

  /// The agent calls `start_job` for the pull stage on the pull an earlier job opened, to continue
  /// it on its branch. An unfinished job on the pull refuses it, and so does a pull that is not
  /// open on the host.
  action agentContinuesAPull: bool = onJobWhere(
    id => WORKS_ON_PULLS and workflow.jobs[id].pullOnHost != NoPull,
    id => agentContinuesThePullOf(id),
  )

  /// The agent continues the open pull of a job whose chain finished, and whose opener has a page.
  /// It is a copy of `agentContinuesAPull` that a step picks as often as any other kind of step.
  action agentContinuesTheOpenPullOfAFinishedJob: bool = onJobWhere(
    id => and {
      WORKS_ON_PULLS,
      startAllowed(workflow),
      workflow.jobs[id].pullOnHost == PullOpen,
      workflow.jobs[id].artifact != NoArtifact,
      pullChain(workflow, id).select(other => not(isFinished(jobTask(workflow, other).status))).length() == 0,
    },
    id => agentContinuesThePullOf(id),
  )

  /// The agent calls `start_job` to continue the pull that the job `id` opened.
  action agentContinuesThePullOf(id: int): bool = all {
    workflow.jobs.length() < MAX_JOBS,
    val refused = or {
      not(startAllowed(workflow)),
      pullChain(workflow, id).select(other => not(isFinished(jobTask(workflow, other).status))).length() > 0,
      workflow.jobs[id].pullOnHost != PullOpen,
    }
    nondet routerWriteFails = Set(true, false).oneOf()
    val input = FromArtifactOf(id)
    val started =
      if (routerWriteFails) startedJobPastAFailedRouterWrite(workflow, input) else startedJob(workflow, input)
    move(untold(if (refused) workflow else started), JobStartStep({ routerWriteFails: routerWriteFails })),
  }

  /// The researcher's turn ends with its research payload written.
  action researcherHandsOver: bool = onJobWhere(
    id => taskWorks(workflow, id) and jobTask(workflow, id).role == Researcher,
    id => move(untold(researchHandedOver(workflow, id)), OtherStep),
  )

  /// The researcher's turn ends with its research payload written. It is a copy of
  /// `researcherHandsOver` that a step picks as often as any other kind of step, so the author
  /// after research runs out of restarts and fails.
  action theResearcherHandsOverItsResearch: bool = researcherHandsOver

  /// The harness author writes its page, or pushes to its pull, and its turn ends. An author that
  /// does not continue a pull opens one on the host. The turn end tells the agent unless a queued
  /// prompt goes out or the stage runs refiners.
  action authorWritesItsPage: bool = onJobWhere(authorMayWrite, authorWritesThePageOf)

  /// The harness author of a job that continues a pull pushes to it, and its turn ends. It is a
  /// copy of `authorWritesItsPage` that a step picks as often as any other kind of step, so a
  /// host close removes the continuing job's pull and leaves the opener's to a later start.
  action theAuthorOfAContinuingJobPushes: bool = onJobWhere(
    id => authorMayWrite(id) and continuesAPull(workflow.jobs[id]),
    authorWritesThePageOf,
  )

  /// True when the harness author of the job `id` works and has not written its page.
  def authorMayWrite(id: int): bool = and {
    not(WRITES_ISSUES),
    taskWorks(workflow, id),
    jobTask(workflow, id).role == Author,
    workflow.jobs[id].artifact == NoArtifact,
  }

  /// The harness author of the job `id` writes its page, or pushes to its pull.
  action authorWritesThePageOf(id: int): bool = {
    val written = pageWritten(workflow, id)
    val opensAPull = WORKS_ON_PULLS and not(continuesAPull(workflow.jobs[id]))
    move(
      {
        flow: if (opensAPull) withPullOnHost(written, id, PullOpen) else written,
        told: REFINER == NoRefiner and not(jobTask(written, id).turnRunning),
      },
      OtherStep,
    )
  }

  /// The breakdown author ends its turn with the link of the issues it wrote: the subject issue or
  /// the project. An output that names the subject is recorded as a page is, and it sets the
  /// subject of a workflow that does not have one. An output that names another subject is not recorded.
  /// The author gets the reason as its next prompt, its turn goes on, and the agent is not told.
  /// A recorded output is a task result, so it tells the agent even when a prompt waits.
  action authorLinksItsIssues: bool = onJobWhere(
    id => and {
      WRITES_ISSUES,
      taskWorks(workflow, id),
      jobTask(workflow, id).role == Author,
      workflow.jobs[id].artifact == NoArtifact,
    },
    id => {
      nondet outputLink = TRACKER_LINKS.oneOf()
      val author = jobTask(workflow, id)
      val otherSubject = workflow.subject != NoSubject and outputLink != workflow.subject
      val reason = { ...endHeldTurn(author), promptsQueued: endHeldTurn(author).promptsQueued.append(OtherPrompt) }
      val refused = withTask(workflow, id, { ...takeQueuedPrompt(reason), promptsSent: author.promptsSent + 1 })
      val recorded = { ...pageWritten(workflow, id), subject: outputLink }
      move(
        if (otherSubject) untold(refused)
        else { flow: recorded, told: REFINER == NoRefiner },
        OutputStep(outputLink),
      )
    },
  )

  /// The reviewer of the page approves it, and its turn ends.
  action refinerRunEnds: bool = onJobWhere(
    id => refinerRunning(workflow.jobs[id]),
    id => move(untold(refinerRunFinished(workflow, id)), OtherStep),
  )

  /// The sandbox of the refiner run dies.
  action refinerRunFails: bool = onJobWhere(
    id => refinerRunning(workflow.jobs[id]),
    id => move(untold(refinerRunFailed(workflow, id)), OtherStep),
  )

  /// A refiner run fails while a model turn of its author is in flight. It is a copy of
  /// `refinerRunFails` that a step picks as often as any other kind of step.
  action aRefinerRunFailsDuringAModelTurn: bool = all {
    jobIds(workflow).exists(id => refinerRunning(workflow.jobs[id]) and modelTurnInFlight(workflow, id)),
    refinerRunFails,
  }

  /// The agent prompts an author, or a refiner run fails, while a refiner run reads the page of a
  /// model-call author. A step picks it as often as any other kind of step, so a refiner run fails
  /// during a revise turn.
  action aRefinerRunMeetsAModelTurn: bool = all {
    jobIds(workflow).exists(id => and {
      refinerRunning(workflow.jobs[id]),
      runsAsModelCalls(jobTask(workflow, id)),
      not(isFinished(jobTask(workflow, id).status)),
    }),
    any { theAgentPromptsAModelCallAuthorUnderReview, refinerRunFails },
  }

  /// The agent prompts a model-call author whose page a refiner run reads.
  action theAgentPromptsAModelCallAuthorUnderReview: bool = onJobWhere(
    id => and {
      refinerRunning(workflow.jobs[id]),
      runsAsModelCalls(jobTask(workflow, id)),
      not(isFinished(jobTask(workflow, id).status)),
    },
    id => move(untold(promptTask(workflow, id, false, OtherPrompt)), PromptStep),
  )

  /// The agent calls `pause_task` on the job's task. A researcher is refused, and a finished or
  /// paused author is left alone.
  action agentPausesAuthor: bool = onJob(id => move(
    untold(if (jobTask(workflow, id).role == Author) pauseTask(workflow, id) else workflow),
    OtherStep,
  ))

  /// The agent calls `resume_task` on the job's task. A researcher is refused. A paused author
  /// gets a prompt to go on.
  action agentResumesAuthor: bool = onJob(id => move(
    untold(if (jobTask(workflow, id).role == Author) resumeTask(workflow, id, false) else workflow),
    OtherStep,
  ))

  /// The agent calls `prompt_task` on the job's task. A researcher and a finished author are
  /// refused.
  action agentPromptsAuthor: bool = onJob(id => move(
    untold(if (jobTask(workflow, id).role == Author) promptTask(workflow, id, false, OtherPrompt) else workflow),
    PromptStep,
  ))

  /// The no progress alarm finds the harness turn of the job's task stalled after a nudge. The
  /// task restarts in a fresh sandbox once its container is destroyed, or fails once its restarts
  /// are used up. The restart tells the agent before its container goes.
  action taskStalls: bool = onJobWhere(id => taskStuck(workflow, id), id => {
    val task = jobTask(workflow, id)
    val queued = withTask(workflow, id, { ...task, promptsQueued: task.promptsQueued.append(OtherPrompt) })
    move(
      if (task.restarts >= MAX_RESTARTS) endTask(workflow, id, TaskFailed, AfterFail, ToolOrEvent)
      else {
        val counted = withTask(queued, id, { ...jobTask(queued, id), restarts: task.restarts + 1 })
        {
          flow: if (destroyIsACall(task)) sendCall(counted, SandboxDestroy, id, RestartGoesOn)
            else restartGoesOn(counted, id),
          told: true,
        }
      },
      OtherStep,
    )
  })

  /// A task that restarted stalls again. It is a copy of `taskStalls` that a step picks as often
  /// as any other kind of step, so a task runs out of restarts and fails.
  action aRestartedTaskStalls: bool = all {
    jobIds(workflow).exists(id => taskStuck(workflow, id) and jobTask(workflow, id).restarts > 0),
    taskStalls,
  }

  /// A task that used up its restarts stalls again and fails. It is a copy of `taskStalls` that a
  /// step picks as often as any other kind of step, so a failure post goes out more often.
  action aTaskOutOfRestartsStalls: bool = all {
    jobIds(workflow).exists(id => taskStuck(workflow, id) and jobTask(workflow, id).restarts >= MAX_RESTARTS),
    taskStalls,
  }

  /// The harness turn of an author after research stalls. It is a copy of `taskStalls` that a
  /// step picks as often as any other kind of step, so the author runs out of restarts and fails.
  action anAuthorAfterResearchStalls: bool = all {
    RESEARCH,
    jobIds(workflow).exists(id => taskStuck(workflow, id) and jobTask(workflow, id).role == Author),
    taskStalls,
  }

  /// The agent cancels the unfinished job that opened a pull the host holds open. It is a copy
  /// of `agentCancelsJob` that a step picks as often as any other kind of step, so a later job
  /// continues the pull.
  action theAgentCancelsTheOpenerOfAnOpenPull: bool = onJobWhere(
    id => and {
      WORK == PullsTheHostMoves,
      workflow.jobs[id].pullOnHost == PullOpen,
      not(continuesAPull(workflow.jobs[id])),
      not(isFinished(jobTask(workflow, id).status)),
    },
    id => move(endTask(workflow, id, TaskCancelled, AfterCancel, ToolOrEvent), OtherStep),
  )

  /// The sandbox destroy of a stalled task, of a failed task, or of a task that completes under
  /// review returns. It is a copy of `sandboxDestroyReturns` that a step picks as often as any
  /// other kind of step, so a task stalls past its restarts and its failure is posted, and a job
  /// completes during its review.
  action theSandboxOfAnEndingTaskCloses: bool = all {
    outCalls(workflow, SandboxDestroy).exists(callId => match workflow.calls[callId].rest {
      | RestartGoesOn => true
      | TeardownGoesOn(teardown) => or {
        teardown.teardown == AfterFail,
        teardown.teardown == AfterComplete and refinerRunning(workflow.jobs[workflow.calls[callId].job]),
      }
      | _ => false
    }),
    sandboxDestroyReturns,
  }

  /// The agent calls `cancel_job`. A finished job is left alone.
  action agentCancelsJob: bool = onJob(id => move(
    if (isFinished(jobTask(workflow, id).status)) untold(workflow)
    else endTask(workflow, id, TaskCancelled, AfterCancel, ToolOrEvent),
    OtherStep,
  ))

  /// The kind of a step that may complete the job: `SubjectCompletionStep` when it completes the
  /// job of the subject issue.
  pure def completionStepKind(flow: Workflow, id: int, completes: bool): StepKind =
    if (completes and completesTheWorkflow(flow, id)) SubjectCompletionStep else OtherStep

  /// True while `complete_job` on the job waits on a call: the destroy of the sandbox of its
  /// author, or a destroy of the workflow end it started on the subject issue's job.
  pure def completionGoesOn(flow: Workflow, id: int): bool =
    flow.calls.indices().exists(callId => match flow.calls[callId].rest {
      | TeardownGoesOn(teardown) => or {
        flow.calls[callId].job == id and teardown.teardown == AfterComplete,
        teardown.caller == WorkflowEnd({ endsAs: Done, waiter: CompletionWaits }) and worksOnTheSingleSubjectIssue(flow, id),
      }
      | _ => false
    }) or (endCallAwaitsCompletion(flow) and worksOnTheSingleSubjectIssue(flow, id))

  /// What `complete_job` tells the agent in the step that ended the author of the job done: that
  /// the job is done, unless it still waits on a call.
  pure def answerOnceCompleted(flow: Workflow, id: int): CompletionAnswer =
    if (completionGoesOn(flow, id)) NotAnswered else Completes

  /// The agent calls `complete_job` in a turn where the person accepted the artifact, or selected
  /// an option it lists. It is refused while the researcher runs, and on a choice ending while the
  /// job does not have a page. On an acceptance ending, a job without an artifact, or with one the
  /// host accepted, completes at once. Otherwise the acceptance or the selection is checked first.
  action agentCompletesJob: bool = onJob(id => agentCompletesJobOf(id))

  /// The agent completes a job that has an artifact. It is a copy of `agentCompletesJob` that a
  /// step picks as often as any other kind of step, so the acceptance check goes out.
  action theAgentCompletesAJobWithAnArtifact: bool = onJobWhere(
    id => workflow.jobs[id].artifact != NoArtifact and not(completionRefused(workflow, id)),
    id => agentCompletesJobOf(id),
  )

  /// The agent completes a job while its refiner run reads the page. It is a copy of
  /// `agentCompletesJob` that a step picks as often as any other kind of step.
  action theAgentCompletesAJobUnderReview: bool = onJobWhere(
    id => refinerRunning(workflow.jobs[id]) and not(completionRefused(workflow, id)),
    id => agentCompletesJobOf(id),
  )

  /// True when `complete_job` refuses the job: its task finished, a researcher runs, or a choice
  /// ending finds the job without a page.
  pure def completionRefused(flow: Workflow, id: int): bool = or {
    isFinished(jobTask(flow, id).status),
    jobTask(flow, id).role == Researcher,
    STAGE_ENDING == ChoiceEnding and flow.jobs[id].artifact == NoArtifact,
  }

  /// The agent calls `complete_job` on the job `id`.
  action agentCompletesJobOf(id: int): bool = {
    val artifact = workflow.jobs[id].artifact
    val refused = completionRefused(workflow, id)
    val atOnce = and {
      not(refused),
      STAGE_ENDING == AcceptanceEnding,
      artifact == NoArtifact or artifact == Accepted,
    }
    val after =
      if (refused) untold(workflow)
      else if (atOnce) completeAuthor(workflow, id)
      else untold(sendCall(workflow, AcceptanceCheck, id, CompletionGoesOn))
    val answered =
      if (refused) Refuses
      else if (atOnce) answerOnceCompleted(after.flow, id)
      else NotAnswered
    moveAnswering(after, completionStepKind(workflow, id, atOnce), answered)
  }

  /// The acceptance check returns. For a page or issues, the decisions model reads an acceptance
  /// or a selection in the person's message, does not, or fails. For a pull, the host says whether
  /// it merged the pull, which it may have done without an event the workflow heard. A merged pull
  /// records the artifact accepted. A failed check tells the agent the check is unavailable before
  /// anything else. A check that does not pass on a page or issues has the agent ask the person
  /// again. `complete_job` reads the author again after the check, so an author that finished
  /// meanwhile keeps its status.
  action acceptanceCheckReturns: bool = all {
    outCalls(workflow, AcceptanceCheck).size() > 0,
    nondet callId = outCalls(workflow, AcceptanceCheck).oneOf()
    nondet answer = CHECK_ANSWERS.oneOf()
    val returned = withoutCall(workflow, callId)
    val id = workflow.calls[callId].job
    val opener = pullOpenerOf(workflow, id)
    val host = workflow.jobs[opener].pullOnHost
    val merged = host == PullMerged or (host == PullOpen and answer == CheckPasses)
    val checked =
      if (not(WORKS_ON_PULLS) or not(merged)) returned
      else advanceArtifact(withPullOnHost(returned, opener, PullMerged), id, Accepted)
    val passes = if (WORKS_ON_PULLS) merged else answer == CheckPasses
    val completes = passes and not(isFinished(jobTask(workflow, id).status))
    val after = if (completes) completeAuthor(checked, id) else untold(checked)
    val answered = acceptanceCheckAnswer(answer, passes, completes, after.flow, id)
    val stepKind =
      if (answer == CheckUnavailable) FailedCheckStep(id)
      else completionStepKind(workflow, id, completes)
    moveAnswering(after, stepKind, answered),
  }

  /// What `complete_job` tells the agent once the acceptance check of the job `id` returns
  /// `answer`: that the check is unavailable, that the job completes, that it is refused, or to ask
  /// the person again.
  pure def acceptanceCheckAnswer(
    answer: CheckAnswer,
    passes: bool,
    completes: bool,
    after: Workflow,
    id: int,
  ): CompletionAnswer =
    if (answer == CheckUnavailable) SaysUnavailable
    else if (completes) answerOnceCompleted(after, id)
    else if (passes or WORKS_ON_PULLS) Refuses
    else AsksAgain

  /// True when the call goes on toward the end of the workflow that `complete_job` on the job of
  /// the subject issue starts.
  pure def completesTheSubjectsJob(call: Call): bool = match call.rest {
    | TeardownGoesOn(teardown) => teardown.caller == SubjectJobCompletes(CompletionWaits) or isEndLoopOf(teardown.caller, Done)
    | CompletionResumes(caller) => caller == SubjectJobCompletes(NobodyWaits)
    | _ => false
  }

  /// The sandbox provider returns from the destroy of an author's sandbox. `complete_job` answers
  /// once the destroy of its author's sandbox returned, or the last destroy of the workflow end it
  /// started.
  action sandboxDestroyReturns: bool = all {
    outCalls(workflow, SandboxDestroy).size() > 0,
    nondet callId = outCalls(workflow, SandboxDestroy).oneOf()
    val call = workflow.calls[callId]
    val completing = completesTheSubjectsJob(call) and workflow.stagePlan != NoStages
    val stepKind = if (completing) SubjectCompletionStep else OtherStep
    val after = returnCall(workflow, callId)
    moveAnswering(after, stepKind, destroyAnswer(call, after.flow)),
  }

  /// What `complete_job` tells the agent once the sandbox destroy `call` returns: that the job is
  /// done when the destroy follows its completion.
  pure def destroyAnswer(call: Call, after: Workflow): CompletionAnswer = match call.rest {
    | TeardownGoesOn(teardown) =>
      if (teardown.teardown == AfterComplete) answerOnceCompleted(after, call.job) else NotAnswered
    | _ => NotAnswered
  }

  /// The chat host returns from the failure post of a researcher or author.
  action failurePostReturns: bool = all {
    outCalls(workflow, FailurePost).size() > 0,
    nondet callId = outCalls(workflow, FailurePost).oneOf()
    move(returnCall(workflow, callId), OtherStep),
  }

  /// The task end alarm of a finished researcher or author fires, at once or after other events
  /// and restarts.
  action theTaskEndAlarmFires: bool = onJobWhere(
    id => workflow.taskEndAlarms.contains(id),
    id => move(resumeTaskEnd(workflow, id), TaskEndAlarmStep(id)),
  )

  /// The task end alarm of a researcher that handed over fires, at once or after other events and
  /// restarts.
  action theResearcherEndAlarmFires: bool = onJobWhere(
    id => workflow.researcherEndAlarms.contains(id),
    id => move(resumeResearcherEnd(workflow, id), OtherStep),
  )

  /// The page model answers the model call of a model-call author, also one whose model turn a
  /// stop ended.
  action modelCallReturns: bool = all {
    outCalls(workflow, ModelCall).size() > 0,
    nondet callId = outCalls(workflow, ModelCall).oneOf()
    val call = workflow.calls[callId]
    val stepKind = if (isStoppedModelCall(call)) StoppedCallReturnStep(call.job) else OtherStep
    move(returnCall(workflow, callId), stepKind),
  }

  /// The page model fails the model call of an unfinished model-call author that a stop did not
  /// reach. The author fails at once, and its failure posts.
  action modelCallFails: bool = {
    val failing = outCalls(workflow, ModelCall).filter(callId => and {
      not(isStoppedModelCall(workflow.calls[callId])),
      not(isFinished(jobTask(workflow, workflow.calls[callId].job).status)),
    })
    all {
      failing.size() > 0,
      nondet callId = failing.oneOf()
      val id = workflow.calls[callId].job
      move(endTask(withoutCall(workflow, callId), id, TaskFailed, AfterFail, ToolOrEvent), HostErrorStep(id)),
    }
  }

  /// The document host fails the page write of an unfinished model-call author. The author fails
  /// at once, and its failure posts.
  action pageWriteFails: bool = {
    val failing = outCalls(workflow, PageWrite).filter(callId =>
      not(isFinished(jobTask(workflow, workflow.calls[callId].job).status))
    )
    all {
      failing.size() > 0,
      nondet callId = failing.oneOf()
      val id = workflow.calls[callId].job
      move(endTask(withoutCall(workflow, callId), id, TaskFailed, AfterFail, ToolOrEvent), HostErrorStep(id)),
    }
  }

  /// The document host returns from the page write of a model-call author.
  action pageWriteReturns: bool = all {
    outCalls(workflow, PageWrite).size() > 0,
    nondet callId = outCalls(workflow, PageWrite).oneOf()
    move(returnCall(workflow, callId), OtherStep),
  }

  /// The deadline alarm of a model turn in flight fires while its model call or its page write
  /// hangs. The turn is lost, and the call it waits on never returns, since the platform stops a
  /// step long before the deadline.
  action modelTurnOutlivesItsDeadline: bool = {
    val inFlight = workflow.calls.indices().filter(callId => and {
      isModelTurnCall(workflow.calls[callId]),
      not(isFinished(jobTask(workflow, workflow.calls[callId].job).status)),
    })
    all {
      inFlight.size() > 0,
      nondet callId = inFlight.oneOf()
      val id = workflow.calls[callId].job
      val cut = requeueCutPrompt(withoutCall(workflow, callId), workflow.calls[callId])
      val restarted = restartLostModelTurn(cut, id)
      move({ ...restarted, flow: runLostModelTurnAgain(restarted.flow, id) }, DeadlineStep(id)),
    }
  }

  /// A person writes a message in the chat thread. It wakes a sleeping workflow.
  action personWrites: bool =
    move(eventHandled(workflow, untold(if (hasEnded(workflow.status)) workflow else messageWakes(workflow))), MessageStep)

  /// A person's message in the session of the subject issue goes to its author as a prompt while
  /// the author runs. Only a workflow from a tracker origin has that session.
  pure def forwardedToTheSessionAuthor(flow: Workflow): List[int] =
    if (TRACKER_ORIGIN) runningSessionAuthor(flow) else List()

  /// A person sends a verbal command where the request came from: pause, resume, or instruct with
  /// its text. The message wakes a sleeping workflow. In the session of the subject issue it goes
  /// to the author that runs there as a prompt. Otherwise the command acts on the task of the one
  /// active job, a researcher too.
  action personSendsAVerbalCommand: bool = {
    nondet command = Set(Pause, Resume, Instruct).oneOf()
    val woke = messageWakes(workflow)
    val forwarded = forwardedToTheSessionAuthor(woke)
    val handled =
      if (hasEnded(workflow.status)) workflow
      else if (forwarded.length() > 0) promptTask(woke, forwarded[0], true, Instruction)
      else verbalCommandActs(woke, command)
    move(eventHandled(workflow, untold(handled)), VerbalCommandStep(command))
  }

  /// A person writes while the page write of a model turn that a stop reached is out. A step picks
  /// it as often as any other kind of step, so a prompt reaches the author before the write
  /// returns.
  action aPersonWritesDuringAStoppedPageWrite: bool = all {
    stoppedPageWritesOut(workflow) > 0,
    personSendsAVerbalCommand,
  }

  /// A person writes the cancel word in the session of the subject issue. The message wakes a
  /// sleeping workflow and goes to the author that runs there as a prompt. Otherwise it cancels
  /// the workflow, unless another end runs.
  pure def cancelWordInTheSession(flow: Workflow): Outcome = {
    val woke = messageWakes(flow)
    val forwarded = forwardedToTheSessionAuthor(woke)
    if (forwarded.length() > 0) untold(promptTask(woke, forwarded[0], true, Instruction)) else cancelUnlessEnding(woke)
  }

  /// The workflow ends once a job started. A person sends the cancel verbal command where the
  /// request came from, the agent calls `fail_workflow`, or the agent calls `finish_workflow`,
  /// which is refused while a task is unfinished. Each is refused while another end runs. The
  /// cancel word may land on a workflow that already ended.
  action workflowEnds: bool = all {
    workflow.jobs.length() > 0,
    nondet ending = Set(PersonCancels, AgentFails, AgentFinishes).oneOf()
    val refused = hasEnded(workflow.status) or workflowEnding(workflow)
    match ending {
      | PersonCancels =>
        move(
          eventHandled(
            workflow,
            if (hasEnded(workflow.status)) untold(workflow)
            else if (TRACKER_ORIGIN) cancelWordInTheSession(workflow)
            else cancelUnlessEnding(workflow),
          ),
          EventStep,
        )
      | AgentFails => all {
        not(hasEnded(workflow.status)),
        move(if (refused) untold(workflow) else continueWorkflowEnd(workflow, Failed, NobodyWaits), OtherStep),
      }
      | AgentFinishes => all {
        not(hasEnded(workflow.status)),
        move(
          if (refused or unfinishedJobIds(workflow).length() > 0) untold(workflow)
          else continueWorkflowEnd(workflow, Done, NobodyWaits),
          FinishStep,
        ),
      }
    },
  }

  /// A person merges the pull a job opened, closes it unmerged, or reopens it once closed, on the
  /// host. The host tells the workflow, also once it ended.
  action theHostMovesAPull: bool = onJobWhere(
    id => WORK == PullsTheHostMoves and workflow.jobs[id].pullOnHost != NoPull,
    id => {
      nondet hostMove = Set(Merged, ClosedUnmerged, Reopened).oneOf()
      theHostMovesThePullOf(id, hostMove)
    },
  )

  /// The host moves the pull that the job `id` opened.
  action theHostMovesThePullOf(id: int, hostMove: HostMove): bool = {
    val host = workflow.jobs[id].pullOnHost
    all {
      if (hostMove == Reopened) host == PullClosed else host == PullOpen,
      move(eventHandled(workflow, pullMoved(workflow, id, hostMove)), EventStep),
    }
  }

  /// A person reopens a pull the host closed. It is a copy of `theHostMovesAPull` that a step picks
  /// as often as any other kind of step.
  action theHostReopensAClosedPull: bool = onJobWhere(
    id => WORK == PullsTheHostMoves and workflow.jobs[id].pullOnHost == PullClosed,
    id => {
      nondet hostMove = Set(Reopened).oneOf()
      theHostMovesThePullOf(id, hostMove)
    },
  )

  /// A person closes a pull unmerged after a later job continued it, while the job that opened it
  /// finished with a page. It is a copy of `theHostMovesAPull` that a step picks as often as any
  /// other kind of step, so a later start on the issue records the opener's pull removed.
  action theHostClosesAContinuedPull: bool = onJobWhere(
    id => and {
      WORK == PullsTheHostMoves,
      workflow.jobs[id].pullOnHost == PullOpen,
      isFinished(jobTask(workflow, id).status),
      workflow.jobs[id].artifact == Drafted or workflow.jobs[id].artifact == Ready,
      pullHolder(workflow, id) != id,
    },
    id => {
      nondet hostMove = Set(ClosedUnmerged).oneOf()
      theHostMovesThePullOf(id, hostMove)
    },
  )

  /// A person moves the subject issue, or an issue a job took, to a canceled or completed state.
  /// The tracker tells the workflow, also once it ended. The spec has it once a job started.
  action aPersonEndsAnIssue: bool = all {
    A_PERSON_ENDS_ISSUES,
    workflow.jobs.length() > 0,
    nondet issue = Set(SUBJECT_ISSUE).union(ISSUES.filter(taken => jobsOnIssue(workflow, taken).length() > 0)).oneOf()
    move(eventHandled(workflow, issueEnded(workflow, issue)), IssueEndStep(issue)),
  }

  /// A person ends an issue while the host has accepted an artifact. A step picks it as often as
  /// any other kind of step, so an issue end lands before the workflow ends on its accepted pull.
  action aPersonEndsAnIssueAfterAnAcceptance: bool = all {
    jobIds(workflow).exists(id => workflow.jobs[id].artifact == Accepted),
    aPersonEndsAnIssue,
  }

  /// The idle alarm fires. A running workflow whose tasks are not busy goes to sleep.
  action idleAlarmFires: bool = all {
    workflow.idleArmed,
    val disarmed = { ...workflow, idleArmed: false }
    if (sleeps(workflow)) move(untold({ ...disarmed, status: WaitingInput }), SleepStep)
    else move(untold(disarmed), OtherStep),
  }

  /// A person presses Stop in the session of the subject issue. On a workflow that has not ended,
  /// the stop reaches the author of the session and tells the agent. A session without an author
  /// ignores it.
  action aPersonPressesStop: bool = {
    val author = sessionAuthor(workflow)
    val stops = not(hasEnded(workflow.status)) and author.length() > 0
    val stopped = if (stops) author.foldl(workflow, (flow, id) => stopAuthor(flow, id)) else workflow
    all {
      A_PERSON_STOPS,
      move({ flow: stopped, told: stops }, StopStep),
    }
  }

  /// A person presses Stop while the page write of the session author's model turn is out. A step
  /// picks it as often as any other kind of step, so a stop lands during a page write.
  action aPersonPressesStopDuringAPageWrite: bool = all {
    sessionAuthor(workflow).select(id => modelTurnInFlight(workflow, id) and pageWriteOut(workflow, id)).length() > 0,
    aPersonPressesStop,
  }

  /// An alarm of a sandbox generation before the current one fires. The timer and the sandbox it
  /// is about change nothing here. Only the replay reads them.
  action staleAlarmFires: bool = all {
    workflow.jobs.length() > 0,
    nondet timer = GENERATION_TIMERS.oneOf()
    nondet sandbox = STALE_SANDBOXES.oneOf()
    move(untold(workflow), StaleAlarmStep),
  }

  /// The deadline alarm of a model turn of the job that already ended fires late. The task holds
  /// another turn or none, so the alarm changes nothing. Only the replay reads the job.
  action aStaleModelTurnDeadlineFires: bool = onJobWhere(
    id => staleModelTurnDeadlineArmed(workflow, id),
    _ => move(untold(workflow), StaleAlarmStep),
  )

  /// The Durable Object restarts while a call is out, an alarm of an earlier restart or a task end
  /// alarm is armed, or the store holds a workflow end. Every call that is out is lost with its isolate. A page write
  /// that is out may have landed on the host first. That changes nothing here, since the store
  /// does not hear of it. Only the replay reads it.
  action workflowRestarts: bool = all {
    or {
      workflow.calls.length() > 0,
      workflow.restartAlarms.size() > 0,
      workflow.runAgainAlarms.size() > 0,
      workflow.taskEndAlarms.size() > 0,
      workflow.researcherEndAlarms.size() > 0,
      workflowEnding(workflow),
    },
    nondet landed = Set(true, false).oneOf()
    move(untold(restartWorkflow(workflow)), RestartStep),
  }

  /// The Durable Object restarts while a task recovers or revises: a model turn of an author that
  /// restarted or that revises its page is in flight, or the destroy of a failed task is out. It
  /// is a copy of `workflowRestarts` that a step picks as often as any other kind of step, so an
  /// author runs out of restarts on lost model turns, a restart cuts a revise turn, and a restart
  /// cuts the destroy of a failed task.
  action anInstanceRestartsWhileATaskRecovers: bool = all {
    jobIds(workflow).exists(id => or {
      modelTurnInFlight(workflow, id) and jobTask(workflow, id).restarts > 0,
      modelTurnInFlight(workflow, id) and workflow.jobs[id].artifact != NoArtifact,
      teardownOut(workflow, id, AfterFail),
    }),
    workflowRestarts,
  }

  /// The Durable Object restarts while the failure post of a task is out. It is a copy of
  /// `workflowRestarts` that a step picks as often as any other kind of step.
  action anInstanceRestartsDuringAFailurePost: bool = all {
    jobIds(workflow).exists(id => failurePostOut(workflow, id)),
    workflowRestarts,
  }

  /// The restart alarm of an instance restart fires, at once or after other events and restarts.
  action theRestartAlarmFires: bool = all {
    workflow.restartAlarms.size() > 0,
    nondet lostJobs = workflow.restartAlarms.oneOf()
    move(decideLostModelTurns(workflow, lostJobs), RestartAlarmStep(lostJobs)),
  }

  /// The platform delivers a restart alarm that already fired again. Each model turn it names was
  /// decided or ended, and an author it restarted holds a new turn id, so it changes nothing.
  action theRestartAlarmFiresAgain: bool = all {
    workflow.restartAlarmFired,
    move(untold(workflow), RestartAlarmAgainStep),
  }

  /// The alarm of a restarted author fires, at once or after other events and restarts, and once
  /// more when the platform delivers it again.
  action lostModelTurnRunsAgain: bool = onJobWhere(
    id => workflow.runAgainAlarms.union(workflow.ranAgain).contains(id),
    id => move(untold(lostTurnRunsAgain(workflow, id)), RunAgainStep(id)),
  )

  /// The run-again alarm of an author that a stop reached fires. It is a copy of
  /// `lostModelTurnRunsAgain` that a step picks as often as any other kind of step.
  action theRunAgainAlarmOfAStoppedAuthorFires: bool = onJobWhere(
    id => workflow.runAgainAlarms.contains(id) and jobTask(workflow, id).stopped,
    id => move(untold(lostTurnRunsAgain(workflow, id)), RunAgainStep(id)),
  )

  /// The alarm the start step arms for the workflow end the store holds fires, at once or after
  /// other events and restarts. The end goes on as its loop would: it cancels the unfinished
  /// researchers and authors and then sets the status. An end whose loop waits on a destroy, its
  /// post or its unbind in this instance does not have the alarm.
  action theWorkflowEndResumes: bool = all {
    workflowEnding(workflow),
    workflow.endCall == NoEndCall,
    nondet endsAs = storedEndStatus(workflow).oneOf()
    all {
      not(endDestroyOut(workflow, endsAs)),
      move(continueWorkflowEnd(workflow, endsAs, NobodyWaits), EndResumeStep),
    },
  }

  /// The post that tells the people of a workflow end returns.
  action theEndPostReturns: bool = all {
    endPostWaiters(workflow).size() > 0,
    nondet waiter = endPostWaiters(workflow).oneOf()
    move(untold(endPostLanded(workflow, waiter)), EndPostReturnStep),
  }

  /// The unbind of the code host bindings of a workflow end returns, and the store drops the end.
  /// The event that waited on the end then tells the agent, and `complete_job` that waited on it
  /// answers that the job is done.
  action theCodeHostUnbindReturns: bool = all {
    unbindWaiters(workflow).size() > 0,
    nondet waiter = unbindWaiters(workflow).oneOf()
    moveAnswering(
      { flow: { ...workflow, storedEnd: NoStoredEnd, endCall: NoEndCall }, told: waiter == AnEventWaits },
      UnbindReturnStep,
      if (waiter == CompletionWaits) Completes else NotAnswered,
    ),
  }

  /// A call of a workflow end returns: its post or its unbind.
  action aWorkflowEndCallReturns: bool = any { theEndPostReturns, theCodeHostUnbindReturns }

  /// The deadline alarm of the lost model turn of the job fires while its restarted author waits
  /// for its run-again alarm. The author holds a new turn id, so the alarm changes nothing. Only
  /// the replay reads the job.
  action theDeadlineOfALostModelTurnFires: bool = onJobWhere(
    id => workflow.turnsToRunAgain.contains(id),
    id => move(untold(workflow), LostTurnDeadlineStep(id)),
  )

  /// An alarm that an instance restart armed fires: the restart alarm, the alarm that runs a lost
  /// model turn again, or the alarm that goes on with a workflow end. The deadline of a lost model
  /// turn fires before it runs again.
  action anAlarmOfARestartFires: bool = any {
    theRestartAlarmFiresAgain,
    lostModelTurnRunsAgain,
    theDeadlineOfALostModelTurnFires,
    theWorkflowEndResumes,
  }

  action step: bool = any {
    theAgentPlansOrStartsAJob,
    agentStartsJobOnAnIssueWithAClosedPull,
    theAgentCompletesAJobWithAnArtifact,
    aTaskEndsItsTurn,
    aRefinerRunEnds,
    aRefinerRunMeetsAModelTurn,
    theAgentSteersAnAuthor,
    taskStalls,
    theAgentEndsAJob,
    acceptanceCheckReturns,
    sandboxDestroyReturns,
    modelCallReturns,
    pageWriteReturns,
    aModelTurnFails,
    failurePostReturns,
    theTaskEndAlarmFires,
    theResearcherEndAlarmFires,
    workflowEnds,
    aWorkflowEndCallReturns,
    anOutsideEventLands,
    aPersonEndsAnIssueAfterAnAcceptance,
    aPersonPressesStopDuringAPageWrite,
    aPersonWritesDuringAStoppedPageWrite,
    workflowRestarts,
    anInstanceRestartsWhileATaskRecovers,
    anInstanceRestartsDuringAFailurePost,
    theRestartAlarmFires,
    anAlarmOfARestartFires,
    aRestartedTaskStalls,
    aTaskOutOfRestartsStalls,
    theSandboxOfAnEndingTaskCloses,
    agentStartsJobOnADonePage,
    theAgentPlansFewerSlotsThanJobsRun,
    theAgentCompletesAJobUnderReview,
    theRunAgainAlarmOfAStoppedAuthorFires,
    agentStartsJobAgainOnAnIssue,
    theHostReopensAClosedPull,
    theHostClosesAContinuedPull,
    agentContinuesTheOpenPullOfAFinishedJob,
    theAgentPlansTheWorkflow,
    theAgentStartsAJobItTakes,
    aRefinerRunFailsDuringAModelTurn,
    theAuthorOfAContinuingJobPushes,
    theResearcherHandsOverItsResearch,
    anAuthorAfterResearchStalls,
    theAgentCancelsTheOpenerOfAnOpenPull,
  }

  /// The agent sets the plan or starts a job. Most of these calls are refused once the plan is
  /// set and the slots are full, so they share one pick of a step.
  action theAgentPlansOrStartsAJob: bool = any { agentSetsPlan, aJobStarts }

  /// The agent starts a job on a request, on an issue, or on a pull to continue.
  action aJobStarts: bool = any { agentStartsJob, agentStartsJobOnAnIssue, agentContinuesAPull }

  /// The researcher hands over to the author, or the harness author writes its page or links its
  /// issues.
  action aTaskEndsItsTurn: bool = any { researcherHandsOver, authorWritesItsPage, authorLinksItsIssues }

  /// The refiner run of a job approves or fails.
  action aRefinerRunEnds: bool = any { refinerRunEnds, refinerRunFails }

  /// The agent pauses, resumes or prompts a task.
  action theAgentSteersAnAuthor: bool = any { agentPausesAuthor, agentResumesAuthor, agentPromptsAuthor }

  /// The agent cancels or completes a job.
  action theAgentEndsAJob: bool = any { agentCancelsJob, agentCompletesJob }

  /// The page model fails a model call, the document host fails a page write, or the deadline of
  /// its model turn passes first.
  action aModelTurnFails: bool = any { modelCallFails, pageWriteFails, modelTurnOutlivesItsDeadline }

  /// A message, an alarm, a stop, or a move on the host or the tracker reaches the workflow.
  action anOutsideEventLands: bool = any {
    personWrites,
    personSendsAVerbalCommand,
    idleAlarmFires,
    staleAlarmFires,
    aStaleModelTurnDeadlineFires,
    theHostMovesAPull,
    aPersonEndsAnIssue,
    aPersonPressesStop,
  }

  pure def unfinishedCount(flow: Workflow): int = unfinishedJobIds(flow).length()

  pure def promptsSentToTasks(flow: Workflow): int =
    flow.jobs.foldl(0, (total, job) => job.tasks.foldl(total, (sum, task) => sum + task.promptsSent))

  /// True when a task of the job matches.
  pure def anyTaskOf(job: Job, matches: Task => bool): bool =
    job.tasks.indices().exists(index => matches(job.tasks[index]))

  pure def hasUnfinishedTask(flow: Workflow): bool =
    jobIds(flow).exists(id =>
      anyTaskOf(flow.jobs[id], task => not(isFinished(task.status))) or
      refinerRunning(flow.jobs[id]))

  pure def startedIn(before: Workflow, after: Workflow): bool = after.jobs.length() > before.jobs.length()

  /// True when the unfinished researchers and authors fit the job slots.
  pure def leavesAtMostTheJobSlots(flow: Workflow): bool = unfinishedCount(flow) <= jobSlotsOf(flow)

  /// A job start leaves at most the plan's number of job slots of researchers and authors
  /// unfinished. A refiner run takes no slot.
  pure def startsOnlyIntoAFreeSlot(step: Transition): bool =
    startedIn(step.before, step.after) implies leavesAtMostTheJobSlots(step.after)

  /// True for an event from outside: a person's message, a verbal command, the cancel, a stop, or
  /// a move on the host or the tracker.
  pure def isEventStep(kind: StepKind): bool = match kind {
    | EventStep => true
    | MessageStep => true
    | VerbalCommandStep(_) => true
    | IssueEndStep(_) => true
    | StopStep => true
    | _ => false
  }

  /// True for a step that sends the job's task a prompt: the agent's prompt or an instruct.
  pure def isPromptStep(kind: StepKind): bool = match kind {
    | PromptStep => true
    | VerbalCommandStep(command) => command == Instruct
    | _ => false
  }

  /// A step that gives the workflow its definition is a plan that names a workflow definition of
  /// the deployment.
  pure def onlyAPlanStarts(step: Transition): bool =
    (step.before.definition == Unplanned and step.after.definition != Unplanned) implies
      DEFINITIONS.exists(definition => and {
        step.after.definition == Planned(definition),
        match step.kind {
          | PlanStep(plan) => plan.definition == definition
          | _ => false
        },
      })

  /// A plan that names a workflow definition the deployment does not hold changes nothing.
  pure def ignoresAnUndeclaredPlan(step: Transition): bool = match step.kind {
    | PlanStep(plan) => not(DEFINITIONS.contains(plan.definition)) implies step.after == step.before
    | _ => true
  }

  /// Once set, the subject does not change.
  pure def keepsTheSubject(step: Transition): bool =
    step.before.subject != NoSubject implies step.after.subject == step.before.subject

  /// A start on an issue outside the subject, or before the workflow has one, does not start a
  /// job.
  pure def startsNoJobOutsideTheSubject(step: Transition): bool = match step.kind {
    | IssueStartStep(start) =>
      not(issueInSubject(step.before.subject, start.issue)) implies step.after.jobs.length() == step.before.jobs.length()
    | _ => true
  }

  /// True when `start_job` on an issue lands while a job may start, so only the issue can refuse
  /// it.
  pure def issueStartMayStart(step: Transition): bool = match step.kind {
    | IssueStartStep(_) => startAllowed(step.before)
    | _ => false
  }

  /// A later plan cannot change the workflow definition a workflow started with.
  pure def keepsTheDefinition(step: Transition): bool =
    step.before.definition != Unplanned implies step.after.definition == step.before.definition

  /// A finished task never changes status again, and a finished refiner run does not run again.
  pure def keepsFinishedTasks(step: Transition): bool =
    step.before.jobs.indices().forall(id => and {
      step.before.jobs[id].tasks.indices().forall(index =>
        isFinished(step.before.jobs[id].tasks[index].status) implies
          step.after.jobs[id].tasks[index].status == step.before.jobs[id].tasks[index].status),
      step.after.jobs[id].refinerRuns.length() >= step.before.jobs[id].refinerRuns.length(),
      step.before.jobs[id].refinerRuns.indices().forall(index =>
        refinerRunHasFinished(step.before.jobs[id].refinerRuns[index]) implies
          refinerRunHasFinished(step.after.jobs[id].refinerRuns[index])),
    })

  /// On a finished workflow, no event changes the status, the tasks, or the prompts. An event on
  /// an ended workflow does not tell the agent.
  pure def leavesAFinishedWorkflow(step: Transition): bool =
    (isEventStep(step.kind) and hasEnded(step.before.status)) implies and {
      step.after.status == step.before.status,
      step.after.jobs.length() == step.before.jobs.length(),
      promptsSentToTasks(step.after) == promptsSentToTasks(step.before),
      not(step.toldTheAgent),
    }

  /// An alarm of an older sandbox generation, or of a model turn the author no longer holds,
  /// changes nothing. A stale alarm does not tell the agent.
  pure def ignoresAStaleAlarm(step: Transition): bool =
    isStaleAlarmStep(step.kind) implies (step.after == step.before and not(step.toldTheAgent))

  /// True for the step of an alarm that is about a generation or a turn that went: a stale alarm,
  /// or the deadline of a lost model turn whose author holds a new turn id.
  pure def isStaleAlarmStep(kind: StepKind): bool = match kind {
    | StaleAlarmStep => true
    | LostTurnDeadlineStep(_) => true
    | _ => false
  }

  /// The sleep message posts only while the workflow runs from a plan.
  pure def sleepsOnlyDuringAWorkflow(step: Transition): bool =
    step.kind == SleepStep implies (step.before.definition != Unplanned and step.before.status == Running)

  /// A workflow that is done, failed or cancelled keeps that status.
  pure def keepsAFinishedStatus(step: Transition): bool =
    hasEnded(step.before.status) implies step.after.status == step.before.status

  /// A paused author or researcher does not get a prompt, also in the step that pauses it.
  pure def sendsAPausedTaskNoPrompt(step: Transition): bool =
    step.before.jobs.indices().forall(id =>
      step.before.jobs[id].tasks.indices().forall(index => {
        val was = step.before.jobs[id].tasks[index]
        val now = step.after.jobs[id].tasks[index]
        now.paused implies now.promptsSent == was.promptsSent
      }))

  /// The workflow moves to waiting for input only in a step that leaves no researcher or author busy.
  pure def waitsOnlyWhileNoAuthorWorks(step: Transition): bool =
    (step.after.status == WaitingInput and step.before.status != WaitingInput) implies
      busyJobs(step.after).size() == 0

  /// The jobs whose model turn the step cut: every model turn in flight at a restart of the
  /// Durable Object, the one whose deadline passed, or the lost ones a restart alarm decides.
  pure def modelTurnsCutIn(step: Transition): Set[int] = match step.kind {
    | RestartStep => modelTurnsInFlight(step.before)
    | DeadlineStep(id) => Set(id)
    | RestartAlarmStep(jobs) => jobs
    | _ => Set()
  }

  /// A restart or the deadline does not lose a model turn. The author whose turn was cut asks the
  /// page model again, is back in review with the prompt of its turn taken, waits paused, or
  /// failed with its failure post out to the person. The start of a turn folds into the step, so an author that
  /// is starting has its model call out, or waits for its alarm to run the lost turn again. The
  /// prompt of a revise turn counts as sent while its turn is in flight, so it is taken unless it
  /// waits again after the cut.
  pure def resumesEveryCutModelTurn(step: Transition): bool =
    modelTurnsCutIn(step).forall(id => {
      val before = jobTask(step.before, id)
      val after = jobTask(step.after, id)
      val revised = step.before.jobs[id].artifact != NoArtifact
      or {
        modelTurnInFlight(step.after, id),
        after.status == InReview and not(revised and after.promptsQueued.length() > before.promptsQueued.length()),
        after.paused,
        after.status == TaskFailed and failurePostOut(step.after, id),
      }
    })

  /// True for a move of an artifact's status that the workflow may make: from drafted to ready,
  /// from ready to drafted, or from drafted or ready to accepted or removed.
  pure def isALegalArtifactMove(before: ArtifactStatus, after: ArtifactStatus): bool = or {
    after == before,
    before == Drafted and after == Ready,
    before == Ready and after == Drafted,
    (before == Drafted or before == Ready) and (after == Accepted or after == Removed),
  }

  /// Each artifact moves only by a legal move.
  pure def movesArtifactsLegally(step: Transition): bool =
    step.before.jobs.indices().forall(id =>
      step.before.jobs[id].artifact != NoArtifact implies
        isALegalArtifactMove(step.before.jobs[id].artifact, step.after.jobs[id].artifact))

  /// An accepted or removed artifact keeps its status.
  pure def keepsAnAcceptedArtifact(step: Transition): bool =
    step.before.jobs.indices().forall(id => {
      val was = step.before.jobs[id].artifact
      or { was != Accepted and was != Removed, step.after.jobs[id].artifact == was }
    })

  /// The workflow becomes done only on `finish_workflow` or on `complete_job` of the subject
  /// issue's job. The spec splits that `complete_job` at each call it waits on. The step that
  /// leaves none of them out is the one the code takes, and there the workflow is done, unless
  /// it ended or the store held a cancel or a failure before the step, which a restart keeps.
  /// Only those steps store a done workflow end, and the alarm that goes on with a stored done
  /// end after a restart may make the workflow done.
  pure def isDoneWithTheSubjectsJob(step: Transition): bool = {
    val becameDone = step.before.status != Done and step.after.status == Done
    val storedADoneEnd = step.before.storedEnd != EndStored(Done) and step.after.storedEnd == EndStored(Done)
    val endsDoneHere = step.kind == FinishStep or step.kind == SubjectCompletionStep
    val resumesADoneEnd = step.kind == EndResumeStep and step.before.storedEnd == EndStored(Done)
    val anotherEndStored = storedEndStatus(step.before).exists(endsAs => endsAs != Done)
    val stillGoesOn =
      callOutFor(step.after, SubjectJobCompletes(CompletionWaits)) or endDestroyOut(step.after, Done)
    val completesInThisStep = and {
      step.kind == SubjectCompletionStep,
      not(hasEnded(step.before.status)),
      not(anotherEndStored),
      not(stillGoesOn),
    }
    and {
      storedADoneEnd implies endsDoneHere,
      becameDone implies (endsDoneHere or resumesADoneEnd),
      completesInThisStep implies step.after.status == Done,
    }
  }

  /// A check that fails does not complete the job unless its artifact was already accepted.
  pure def leavesTheJobOpenOnAFailedCheck(step: Transition): bool = match step.kind {
    | FailedCheckStep(id) => or {
      step.before.jobs[id].artifact == Accepted,
      jobTask(step.after, id).status == TaskDone implies jobTask(step.before, id).status == TaskDone,
    }
    | _ => true
  }

  /// After a check fails, `complete_job` does not tell the agent to ask the person again.
  pure def doesNotAskAgainOnAFailedCheck(step: Transition): bool = match step.kind {
    | FailedCheckStep(_) => step.answered != AsksAgain
    | _ => true
  }

  /// The return of a model call that a stop ended before it answered does not write the page: the
  /// artifact of its job keeps its status, and the step does not send a page write for the job.
  pure def leavesThePageOnAStoppedCall(step: Transition): bool = match step.kind {
    | StoppedCallReturnStep(id) => and {
      step.after.jobs[id].artifact == step.before.jobs[id].artifact,
      pageWritesOut(step.after, id) <= pageWritesOut(step.before, id),
    }
    | _ => true
  }

  /// A workflow end that began goes on in every later step until the status it ends as is
  /// written. A step does not change the status it ends as. The store records the end posted only
  /// once that status is written, and drops the end only after its post.
  pure def keepsAnEndGoingUntilItsStatus(step: Transition): bool = match step.before.storedEnd {
    | NoStoredEnd => true
    | EndStored(endsAs) => or {
      step.after.storedEnd == step.before.storedEnd,
      step.after.status == endsAs and step.after.storedEnd == EndPosted(endsAs),
    }
    | EndPosted(endsAs) => or {
      step.after.storedEnd == step.before.storedEnd,
      step.after.status == endsAs and step.after.storedEnd == NoStoredEnd,
    }
  }

  /// True for a step that is a person's message, or a verbal command other than the cancel.
  pure def isPersonsMessage(kind: StepKind): bool = match kind {
    | MessageStep => true
    | VerbalCommandStep(_) => true
    | _ => false
  }

  /// A person's message on a workflow that has not ended starts the idle clock over and moves a
  /// waiting workflow to running.
  pure def wakesOnAPersonsMessage(step: Transition): bool =
    (isPersonsMessage(step.kind) and not(hasEnded(step.before.status))) implies and {
      step.after.idleArmed,
      step.before.status == WaitingInput implies step.after.status == Running,
    }

  /// A step moves at most one tracker issue. It moves one only when it is the plan that starts a
  /// workflow from a tracker origin, a job start on an issue, or the done end of a workflow from a
  /// tracker origin after its post, where the unbind goes out. The plan and the done end always
  /// move it, and a done end that a restart cut after its post moves it again. A failed or
  /// cancelled end does not.
  pure def movesIssuesOnlyAtAStartOrADoneEnd(step: Transition): bool = {
    val moves = step.after.issueMoves - step.before.issueMoves
    val plansATrackerWorkflow = and {
      TRACKER_ORIGIN,
      step.before.definition == Unplanned,
      step.after.definition != Unplanned,
    }
    val startsAJobOnAnIssue = match step.kind {
      | IssueStartStep(_) => true
      | _ => false
    }
    val endsDone = and {
      movesItsIssue(step.after.status),
      not(unbindOut(step.before)),
      unbindOut(step.after),
    }
    val endsOtherwise = and {
      not(hasEnded(step.before.status)),
      step.after.status == Failed or step.after.status == Cancelled,
    }
    and {
      moves >= 0,
      moves <= 1,
      moves == 1 implies (plansATrackerWorkflow or startsAJobOnAnIssue or endsDone),
      plansATrackerWorkflow implies moves == 1,
      endsDone implies moves == 1,
      endsOtherwise implies moves == 0,
    }
  }

  /// The ending posts of one kind the workflow made.
  pure def postsOf(flow: Workflow, post: EndingPost): int =
    flow.endingPosts.select(made => made == post).length()

  /// The failure posts of the job's researcher or author.
  pure def failurePostsOf(flow: Workflow, id: int): int = postsOf(flow, TaskFailurePost(id))

  /// True while the failure post of the job's task is out.
  pure def failurePostOut(flow: Workflow, id: int): bool =
    flow.calls.indices().exists(callId =>
      flow.calls[callId].job == id and flow.calls[callId].rest == AgentHearsTheFailure)

  /// The jobs that ran before the step, out of the constant cap.
  pure def jobsBefore(step: Transition): Set[int] =
    0.to(MAX_JOBS - 1).filter(id => id < step.before.jobs.length())

  /// True while the end of the job's task waits on the destroy of its author's sandbox.
  pure def teardownOut(flow: Workflow, id: int, teardown: Teardown): bool =
    flow.calls.indices().exists(callId => and {
      flow.calls[callId].job == id,
      match flow.calls[callId].rest {
        | TeardownGoesOn(goesOn) => goesOn.teardown == teardown
        | _ => false
      },
    })

  /// True when the end of the job's task as `status` finished in the step: the task ended at once,
  /// or the destroy of its sandbox returned. A restart that drops the destroy does not finish it.
  pure def finishesTheEnd(step: Transition, id: int, status: TaskStatus, teardown: Teardown): bool = and {
    step.kind != RestartStep,
    jobTask(step.after, id).status == status,
    not(teardownOut(step.after, id, teardown)),
    jobTask(step.before, id).status != status or teardownOut(step.before, id, teardown),
  }

  /// True when the failure of the job's researcher or author finished in the step: its failure
  /// post returned.
  pure def finishesAFailure(step: Transition, id: int): bool =
    failurePostsOf(step.after, id) > failurePostsOf(step.before, id)

  /// True when `complete_job` on the job finished in the step.
  pure def finishesACompletion(step: Transition, id: int): bool =
    jobTask(step.after, id).role == Author and finishesTheEnd(step, id, TaskDone, AfterComplete)

  /// `complete_job` ends the author done. A harness author waits on the destroy of its sandbox.
  /// Once the end finished, the refiner run of the job is not running and the humans have the
  /// artifact the review held.
  pure def endsTheReviewOfACompletedJob(step: Transition): bool =
    jobsBefore(step).forall(id => {
      val author = jobTask(step.after, id)
      val becameDone = and {
        author.role == Author,
        author.status == TaskDone,
        jobTask(step.before, id).status != TaskDone,
      }
      and {
        (becameDone and destroyIsACall(author)) implies teardownOut(step.after, id, AfterComplete),
        finishesACompletion(step, id) implies and {
          not(refinerRunning(step.after.jobs[id])),
          step.after.jobs[id].artifact != Drafted,
        },
      }
    })

  /// True while the destroy that the task end alarm of the job's done author sent is out.
  pure def resumedCompletionOut(flow: Workflow, id: int): bool =
    flow.calls.indices().exists(callId => and {
      flow.calls[callId].job == id,
      match flow.calls[callId].rest {
        | CompletionResumes(_) => true
        | _ => false
      },
    })

  /// True when the destroy that the task end alarm of the job's done author sent returned in the
  /// step.
  pure def resumedCompletionReturns(step: Transition, id: int): bool = and {
    step.kind != RestartStep,
    resumedCompletionOut(step.before, id),
    not(resumedCompletionOut(step.after, id)),
  }

  /// Whether one step kept each before-and-after rule.
  pure def rulesKeptBy(step: Transition): KeptRules = {
    jobStartsOnlyIntoAFreeSlot: startsOnlyIntoAFreeSlot(step),
    onlyAPlanStartsTheWorkflow: onlyAPlanStarts(step),
    anUndeclaredPlanChangesNothing: ignoresAnUndeclaredPlan(step),
    workflowKeepsItsDefinition: keepsTheDefinition(step),
    finishedTaskKeepsItsStatus: keepsFinishedTasks(step),
    nothingReopensAFinishedWorkflow: leavesAFinishedWorkflow(step),
    staleAlarmIsIgnored: ignoresAStaleAlarm(step),
    sleepMessageOnlyDuringAWorkflow: sleepsOnlyDuringAWorkflow(step),
    finishedWorkflowKeepsItsStatus: keepsAFinishedStatus(step),
    pausedAuthorGetsNoPrompt: sendsAPausedTaskNoPrompt(step),
    workflowWaitsOnlyWhileNoAuthorWorks: waitsOnlyWhileNoAuthorWorks(step),
    aRestartDoesNotLoseAModelTurn: resumesEveryCutModelTurn(step),
    artifactStatusMovesAreLegal: movesArtifactsLegally(step),
    anAcceptedArtifactNeverMovesBack: keepsAnAcceptedArtifact(step),
    aSingleIssueWorkflowIsDoneWithItsSubjectsJob: isDoneWithTheSubjectsJob(step),
    subjectNeverChanges: keepsTheSubject(step),
    aStartOutsideTheSubjectStartsNoJob: startsNoJobOutsideTheSubject(step),
    aFailedCheckNeverCompletesAJob: leavesTheJobOpenOnAFailedCheck(step),
    aFailedCheckNeverAsksThePersonAgain: doesNotAskAgainOnAFailedCheck(step),
    stoppedModelCallLeavesThePage: leavesThePageOnAStoppedCall(step),
    aJobStartProvisionsItsTask: provisionsEveryStartedTask(step),
    aWorkflowEndReachesAFinishedStatus: keepsAnEndGoingUntilItsStatus(step),
    aPersonsMessageWakesTheWorkflow: wakesOnAPersonsMessage(step),
    issuesMoveOnlyAtAStartOrADoneEnd: movesIssuesOnlyAtAStartOrADoneEnd(step),
    aCompletedJobEndsItsReview: endsTheReviewOfACompletedJob(step),
  }

  /// Whether one step reached each before-and-after witness.
  pure def witnessesReachedBy(step: Transition): ReachedWitnesses = {
    val cut = modelTurnsCutIn(step)
    {
      aPlanStartsTheWorkflow: step.before.definition == Unplanned and step.after.definition != Unplanned,
      aPlanLandsOnAStartedWorkflow: match step.kind {
        | PlanStep(_) => step.before.definition != Unplanned
        | _ => false
      },
      anUndeclaredPlanLands: match step.kind {
        | PlanStep(plan) => not(DEFINITIONS.contains(plan.definition))
        | _ => false
      },
      aPlanLeavesFewerSlotsThanJobs: match step.kind {
        | PlanStep(_) => match step.after.stagePlan {
          | StagesPlanned(jobSlots) => unfinishedCount(step.after) > jobSlots
          | NoStages => false
        }
        | _ => false
      },
      aJobStartsIntoTheLastSlot: and {
        startedIn(step.before, step.after),
        unfinishedCount(step.before) > 0,
        step.after.stagePlan == StagesPlanned(unfinishedCount(step.after)),
      },
      aJobStartsBesideAResearcher: startedIn(step.before, step.after) and
        jobIds(step.before).exists(id =>
          jobTask(step.before, id).role == Researcher and not(isFinished(jobTask(step.before, id).status))),
      aFinishedTaskIsInAStep: jobIds(step.before).exists(id =>
        anyTaskOf(step.before.jobs[id], task => isFinished(task.status))),
      anEventLandsOnAFinishedWorkflow: isEventStep(step.kind) and hasEnded(step.before.status),
      aStaleAlarmFires: step.kind == StaleAlarmStep,
      theSleepMessagePosts: step.kind == SleepStep,
      aMessageWakesTheWorkflow: and {
        isEventStep(step.kind),
        step.before.status == WaitingInput,
        step.after.status == Running,
      },
      aPausedAuthorResumes: jobIds(step.before).exists(id =>
        jobTask(step.before, id).paused and not(jobTask(step.after, id).paused)),
      aPersonPausesAResearcher: step.kind == VerbalCommandStep(Pause) and jobIds(step.before).exists(id => and {
        jobTask(step.before, id).role == Researcher,
        not(jobTask(step.before, id).paused),
        jobTask(step.after, id).paused,
      }),
      aPromptWaitsForAPausedTask: isPromptStep(step.kind) and jobIds(step.before).exists(id => and {
        jobTask(step.after, id).paused,
        jobTask(step.after, id).promptsQueued.length() > jobTask(step.before, id).promptsQueued.length(),
      }),
      aPromptWaitsForATurn: isPromptStep(step.kind) and jobIds(step.before).exists(id => and {
        not(jobTask(step.after, id).paused),
        jobTask(step.after, id).promptsQueued.length() > jobTask(step.before, id).promptsQueued.length(),
      }),
      aVerbalCommandFindsSeveralJobs: match step.kind {
        | VerbalCommandStep(_) => not(hasEnded(step.before.status)) and unfinishedCount(step.before) > 1
        | _ => false
      },
      anAuthorTakesAPromptAfterItsPolisher: jobIds(step.before).exists(id => and {
        polisherHoldsPrompts(step.before, id),
        not(polisherHoldsPrompts(step.after, id)),
        jobTask(step.after, id).promptsSent > jobTask(step.before, id).promptsSent,
      }),
      aWorkflowEndCancelsARefinerRun: and {
        not(hasEnded(step.before.status)),
        hasEnded(step.after.status),
        jobIds(step.before).exists(id =>
          refinerRunning(step.before.jobs[id]) and
          step.after.jobs[id].refinerRuns[step.before.jobs[id].refinerRuns.length() - 1] == RefinerCancelled),
      },
      aCallWasDropped: step.kind == RestartStep,
      aRestartCutsAModelTurn: step.kind == RestartStep and cut.size() > 0,
      aModelTurnOutlivesItsDeadline: match step.kind {
        | DeadlineStep(_) => true
        | _ => false
      },
      aReviseTurnIsCut: cut.exists(id => step.before.jobs[id].artifact != NoArtifact),
      aPausedAuthorLosesAModelTurn: cut.exists(id => jobTask(step.before, id).paused),
      anAuthorFailsOnALostModelTurn: cut.exists(id => jobTask(step.after, id).status == TaskFailed),
      aRestartCutsAPageWrite: step.kind == RestartStep and cut.exists(id => pageWriteOut(step.before, id)),
      aDeadlinePassesDuringAPageWrite: match step.kind {
        | DeadlineStep(id) => pageWriteOut(step.before, id)
        | _ => false
      },
      aSubjectsJobEndsTheWorkflow: and {
        step.kind == SubjectCompletionStep,
        step.before.status != Done,
        step.after.status == Done,
      },
      theAcceptanceCheckCompletesTheSubjectsJob: and {
        step.kind == SubjectCompletionStep,
        outCalls(step.after, AcceptanceCheck).size() < outCalls(step.before, AcceptanceCheck).size(),
      },
      aStartRecordsARemovedPull: jobIds(step.before).exists(id => and {
        step.before.jobs[id].artifact != Removed,
        step.after.jobs[id].artifact == Removed,
        step.before.jobs[pullOpenerOf(step.before, id)].pullOnHost == PullClosed,
      }),
      aStartOnAnIssueWhoseJobCompletedIsRefused: match step.kind {
        | IssueStartStep(start) => and {
          issueStartMayStart(step),
          issueInSubject(step.before.subject, start.issue),
          not(step.before.endedIssues.contains(start.issue)),
          not(inputInWork(step.before, FromIssue(start.issue))),
          issueJobCompleted(step.before, start.issue),
        }
        | _ => false
      },
      aSubIssueEndCancelsItsJob: match step.kind {
        | IssueEndStep(issue) => issue != SUBJECT_ISSUE and jobIds(step.before).exists(id => and {
          step.before.jobs[id].input == FromIssue(issue),
          not(isFinished(jobTask(step.before, id).status)),
          jobTask(step.after, id).status == TaskCancelled,
        })
        | _ => false
      },
      theSubjectIssueEndCancelsTheWorkflow: and {
        step.kind == IssueEndStep(SUBJECT_ISSUE),
        not(hasEnded(step.before.status)),
        not(workflowEnding(step.before)),
        step.after.status == Cancelled or workflowEnding(step.after),
      },
      anIssueEndFindsAnAcceptedArtifact: match step.kind {
        | IssueEndStep(issue) => {
          val owners = jobsOnIssue(step.before, issue)
          and {
            not(hasEnded(step.before.status)),
            owners.length() > 0,
            step.before.jobs[owners[owners.length() - 1]].artifact == Accepted,
          }
        }
        | _ => false
      },
      aCancelWordReachesTheSubjectsAuthor: step.kind == EventStep and jobIds(step.before).exists(id => and {
        step.before.jobs[id].input == FromIssue(SUBJECT_ISSUE),
        jobTask(step.after, id).promptsSent + jobTask(step.after, id).promptsQueued.length() >
          jobTask(step.before, id).promptsSent + jobTask(step.before, id).promptsQueued.length(),
      }),
      aStartBeforeTheSubjectIsRefused: issueStartMayStart(step) and step.before.subject == NoSubject,
      aStartOutsideTheSubjectIsRefused: match step.kind {
        | IssueStartStep(start) => and {
          issueStartMayStart(step),
          step.before.subject != NoSubject,
          not(issueInSubject(step.before.subject, start.issue)),
        }
        | _ => false
      },
      aPlanSetsTheSubject: match step.kind {
        | PlanStep(_) => step.before.subject == NoSubject and step.after.subject != NoSubject
        | _ => false
      },
      aPlanNamesAnotherSubject: match step.kind {
        | PlanStep(plan) => and {
          not(workflowEnding(step.before)),
          step.before.subject != NoSubject,
          plan.subject != NoSubject,
          plan.subject != step.before.subject,
        }
        | _ => false
      },
      anOutputSetsTheSubject: match step.kind {
        | OutputStep(_) => step.before.subject == NoSubject and step.after.subject != NoSubject
        | _ => false
      },
      anOutputNamesAnotherSubject: match step.kind {
        | OutputStep(link) => step.before.subject != NoSubject and link != step.before.subject
        | _ => false
      },
      anAcceptanceCheckFails: match step.kind {
        | FailedCheckStep(_) => true
        | _ => false
      },
      aCheckFailsAfterItsAuthorEnded: match step.kind {
        | FailedCheckStep(id) => isFinished(jobTask(step.before, id).status)
        | _ => false
      },
      aStopEndsAModelCall: step.kind == StopStep and stoppedModelCallsOut(step.after) > stoppedModelCallsOut(step.before),
      aStoppedModelCallReturns: match step.kind {
        | StoppedCallReturnStep(_) => true
        | _ => false
      },
      aJobStartsPastAFailedRouterWrite: startsAJobPastAFailedRouterWrite(step),
      aStaleAlarmFindsAnEndedModelTurn: step.kind == StaleAlarmStep and
        jobIds(step.before).exists(id => staleModelTurnDeadlineArmed(step.before, id)),
      aRestartCutsAProduceTurn: step.kind == RestartStep and
        cut.exists(id => step.before.jobs[id].artifact == NoArtifact),
      aDeadlinePassesDuringAProduceTurn: match step.kind {
        | DeadlineStep(id) => step.before.jobs[id].artifact == NoArtifact
        | _ => false
      },
      aRestartCutsARerunModelTurn: step.kind == RestartStep and
        cut.exists(id => jobTask(step.before, id).restarts > 0),
      aSessionMessageReachesAModelCallAuthorAtWork: match step.kind {
        | VerbalCommandStep(_) => and {
          not(hasEnded(step.before.status)),
          forwardedToTheSessionAuthor(step.before).select(id => runsAsModelCalls(jobTask(step.before, id))).length() > 0,
        }
        | _ => false
      },
      aStopLandsDuringAPageWrite: step.kind == StopStep and stoppedPageWritesOut(step.after) > stoppedPageWritesOut(step.before),
      anEventLandsBeforeTheRestartAlarm: isEventStep(step.kind) and step.before.restartAlarms.size() > 0,
      anEventLandsBeforeALostModelTurnRunsAgain: isEventStep(step.kind) and step.before.runAgainAlarms.size() > 0,
      aRestartLandsBeforeTheRestartAlarm: step.kind == RestartStep and step.before.restartAlarms.size() > 0,
      aRestartLandsBeforeALostModelTurnRunsAgain: step.kind == RestartStep and step.before.runAgainAlarms.size() > 0,
      theRestartAlarmFailsAnAuthor: match step.kind {
        | RestartAlarmStep(jobs) => jobs.exists(id => jobTask(step.after, id).status == TaskFailed)
        | _ => false
      },
      aRestartAlarmFiresAgain: step.kind == RestartAlarmAgainStep,
      aLostModelTurnRunsAgainOnceMore: match step.kind {
        | RunAgainStep(id) => not(step.before.runAgainAlarms.contains(id))
        | _ => false
      },
      aStopTakesATurnThatWaitsToRunAgain: step.kind == StopStep and
        step.before.turnsToRunAgain.exists(id => not(step.after.turnsToRunAgain.contains(id))),
      aRunAgainAlarmFindsAStoppedAuthor: match step.kind {
        | RunAgainStep(id) => step.before.runAgainAlarms.contains(id) and jobTask(step.before, id).stopped
        | _ => false
      },
      aLostModelTurnDeadlineFires: match step.kind {
        | LostTurnDeadlineStep(_) => true
        | _ => false
      },
      aRestartAlarmDecidesATurnThatWaitedToRunAgain: match step.kind {
        | RestartAlarmStep(jobs) => jobs.exists(id => step.before.turnsToRunAgain.contains(id))
        | _ => false
      },
      aRestartLandsDuringAWorkflowEnd: step.kind == RestartStep and workflowEnding(step.before),
      aWorkflowEndResumesAfterARestart: step.kind == EndResumeStep,
      aRestartCutsTheEndPost: and {
        step.kind == RestartStep,
        hasEnded(step.before.status),
        endPostAwaited(step.before),
      },
      aResumedEndFindsItsPostReturned: step.kind == EndResumeStep and endPostReturned(step.before),
      aMessageLandsOnAWaitingWorkflow: isPersonsMessage(step.kind) and step.before.status == WaitingInput,
      aTrackerWorkflowEndsWithoutDone: and {
        TRACKER_ORIGIN,
        not(hasEnded(step.before.status)),
        step.after.status == Failed or step.after.status == Cancelled,
      },
      aRestartCutsAPageCreate: step.kind == RestartStep and
        cut.exists(id => pageWriteOut(step.before, id) and step.before.jobs[id].artifact == NoArtifact),
      aHarnessAuthorPostsItsFailureAfterItsDestroy: jobsBefore(step).exists(id =>
        teardownOut(step.before, id, AfterFail) and failurePostOut(step.after, id)),
      aResearcherPostsItsFailure: jobsBefore(step).exists(id =>
        finishesAFailure(step, id) and jobTask(step.after, id).role == Researcher),
      aModelCallHostErrorPostsAFailure: match step.kind {
        | HostErrorStep(id) => failurePostOut(step.after, id)
        | _ => false
      },
      aRestartCutsTheDestroyOfACancelledAuthor: step.kind == RestartStep and
        jobsBefore(step).exists(id => teardownOut(step.before, id, AfterCancel)),
      aRestartCutsTheDestroyOfAFailedAuthor: step.kind == RestartStep and
        jobsBefore(step).exists(id => teardownOut(step.before, id, AfterFail)),
      aRestartCutsTheDestroyOfACompletedAuthor: step.kind == RestartStep and
        jobsBefore(step).exists(id => teardownOut(step.before, id, AfterComplete)),
      aRestartCutsAFailurePost: step.kind == RestartStep and
        jobsBefore(step).exists(id => failurePostOut(step.before, id)),
      aTaskEndAlarmResumesATeardown: match step.kind {
        | TaskEndAlarmStep(id) => not(teardownCallOut(step.before, id))
        | _ => false
      },
      aTaskEndAlarmFindsItsTeardownOut: match step.kind {
        | TaskEndAlarmStep(id) => teardownCallOut(step.before, id)
        | _ => false
      },
      aJobCompletesDuringItsReview: jobsBefore(step).exists(id =>
        finishesACompletion(step, id) and refinerRunning(step.before.jobs[id])),
      aHarnessAuthorCompletesAfterItsDestroy: jobsBefore(step).exists(id =>
        finishesACompletion(step, id) and teardownOut(step.before, id, AfterComplete)),
      aRestartCutsTheDestroyOfAResearcherThatHandedOver: step.kind == RestartStep and
        jobsBefore(step).exists(id => researcherDestroyOut(step.before, id)),
      aResearcherEndAlarmDestroysTheSandboxAgain: jobsBefore(step).exists(id => and {
        step.before.researcherEndAlarms.contains(id),
        not(researcherDestroyOut(step.before, id)),
        researcherDestroyOut(step.after, id),
      }),
      aTaskEndAlarmFinishesACompletion: jobsBefore(step).exists(id => resumedCompletionReturns(step, id)),
      aTaskEndAlarmEndsASingleIssueWorkflow: and {
        step.kind == SubjectCompletionStep,
        jobsBefore(step).exists(id => resumedCompletionReturns(step, id)),
      },
    }
  }

  /// A person's message on a workflow that has not ended starts the idle clock over and moves a
  /// waiting workflow to running.
  val aPersonsMessageWakesTheWorkflow: bool = lastStepKept.aPersonsMessageWakesTheWorkflow

  /// Tracker issues move only at the plan of a tracker workflow, a job start on an issue, or the
  /// done end of a tracker workflow. A failed or cancelled end does not move them.
  val issuesMoveOnlyAtAStartOrADoneEnd: bool = lastStepKept.issuesMoveOnlyAtAStartOrADoneEnd

  /// Each researcher or author that failed posts its failure at most once, after the destroy of
  /// its sandbox returned. A task that did not fail and a failed refiner run do not post one. A
  /// failure that has not posted keeps its task end alarm armed, so an instance restart does not
  /// lose the post.
  val eachFailedTaskPostsItsFailureOnce: bool =
    jobIds(workflow).forall(id => {
      val posts = failurePostsOf(workflow, id)
      val failed = jobTask(workflow, id).status == TaskFailed
      and {
        posts <= 1,
        posts == 1 implies (failed and not(teardownOut(workflow, id, AfterFail))),
        (failed and posts == 0) implies workflow.taskEndAlarms.contains(id),
      }
    })

  /// The teardown of each finished harness author destroys its sandbox, whether it ended done,
  /// cancelled or failed. Until it did, the task end alarm of the author stays armed, so an
  /// instance restart during the destroy does not leave the sandbox running.
  val aFinishedAuthorsSandboxIsDestroyed: bool =
    jobIds(workflow).forall(id => {
      val task = jobTask(workflow, id)
      (destroyIsACall(task) and isFinished(task.status)) implies
        (workflow.destroyedSandboxes.contains(id) or workflow.taskEndAlarms.contains(id))
    })

  /// A workflow that ended failed posted its failure once, and one that ended done posted its
  /// done message once, from the return of its end's post on, also across an instance restart.
  /// Any other workflow did not post either.
  val anEndedWorkflowPostsItsEndOnce: bool = {
    val posted = not(endPostAwaited(workflow))
    and {
      postsOf(workflow, WorkflowFailurePost) == (if (workflow.status == Failed and posted) 1 else 0),
      postsOf(workflow, DonePost) == (if (workflow.status == Done and posted) 1 else 0),
    }
  }

  /// `complete_job` ends the author done and destroys its sandbox. Once that finished, the refiner
  /// run of the job ended and the humans have the artifact. Until then, the task end alarm of the
  /// author stays armed, so an instance restart during the destroy does not leave the review held.
  val aCompletedJobEndsItsReview: bool = and {
    lastStepKept.aCompletedJobEndsItsReview,
    jobIds(workflow).forall(id => {
      val author = jobTask(workflow, id)
      (author.role == Author and author.status == TaskDone) implies or {
        workflow.taskEndAlarms.contains(id),
        not(refinerRunning(workflow.jobs[id])) and workflow.jobs[id].artifact != Drafted,
      }
    }),
  }

  /// The job of each researcher that handed over has one author, which started as the researcher
  /// ended done, before the destroy of the researcher's sandbox.
  val aDoneResearchersJobHasItsAuthor: bool =
    jobIds(workflow).forall(id => {
      val started = workflow.jobs[id].tasks
      val handedOver = started[0].role == Researcher and started[0].status == TaskDone
      handedOver implies (started.length() == 2 and started[1].role == Author)
    })

  /// A job start leaves at most the plan's number of job slots of jobs active.
  val jobStartsOnlyIntoAFreeSlot: bool = lastStepKept.jobStartsOnlyIntoAFreeSlot

  /// A workflow starts only from a plan that names a workflow definition of the deployment. Before
  /// that, a job does not start, the workflow is not running or waiting for input, and the
  /// workflow has not moved a tracker issue. A plan with an undeclared definition does not change
  /// the workflow.
  val workflowStartsOnlyFromAPlan: bool = and {
    lastStepKept.onlyAPlanStartsTheWorkflow,
    lastStepKept.anUndeclaredPlanChangesNothing,
    workflow.definition == Unplanned implies and {
      workflow.jobs.length() == 0,
      workflow.status != Running,
      workflow.status != WaitingInput,
      workflow.issueMoves == 0,
    },
  }

  /// A later plan cannot change the workflow definition a workflow started with.
  val workflowKeepsItsDefinition: bool = lastStepKept.workflowKeepsItsDefinition

  /// An artifact moves only from drafted to ready, from ready to drafted, or from drafted or ready
  /// to accepted or removed.
  val artifactStatusMovesAreLegal: bool = lastStepKept.artifactStatusMovesAreLegal

  /// An accepted or removed artifact keeps its status.
  val anAcceptedArtifactNeverMovesBack: bool = lastStepKept.anAcceptedArtifactNeverMovesBack

  /// When complete_job completes the subject issue's job at the last stage of a single-issue
  /// workflow, the workflow is done in that step. The workflow becomes done only in such a step or
  /// on finish_workflow.
  val aSingleIssueWorkflowIsDoneWithItsSubjectsJob: bool = lastStepKept.aSingleIssueWorkflowIsDoneWithItsSubjectsJob

  /// Every job on an issue works on the subject issue or an issue inside the subject. A start
  /// outside the subject, or before it is set, does not start a job.
  val aJobWorksOnlyOnIssuesOfItsSubject: bool = and {
    lastStepKept.aStartOutsideTheSubjectStartsNoJob,
    jobIds(workflow).forall(id => match workflow.jobs[id].input {
      | FromIssue(issue) => issueInSubject(workflow.subject, issue)
      | _ => true
    }),
  }

  /// Once set, the subject does not change.
  val subjectNeverChanges: bool = lastStepKept.subjectNeverChanges

  /// An issue has at most one job that is not over, and a job does not start on an issue whose job
  /// completed. Every job on an issue but the last one ended cancelled or failed.
  val oneJobAtATimePerIssueUntilOneCompletes: bool =
    jobIds(workflow).forall(earlier => jobIds(workflow).forall(later => and {
      earlier < later,
      workflow.jobs[earlier].input == workflow.jobs[later].input,
      match workflow.jobs[later].input { | FromIssue(_) => true | _ => false },
    } implies and {
      isFinished(jobTask(workflow, earlier).status),
      jobTask(workflow, earlier).status != TaskDone,
    }))

  /// An acceptance or selection check that fails does not complete the job unless the artifact was
  /// already accepted.
  val aFailedCheckNeverCompletesAJob: bool = lastStepKept.aFailedCheckNeverCompletesAJob

  /// After a check fails, the agent is not told to ask the person again.
  val aFailedCheckNeverAsksThePersonAgain: bool = lastStepKept.aFailedCheckNeverAsksThePersonAgain

  /// A model call that a stop ended before it answered does not write the page.
  val stoppedModelCallLeavesThePage: bool = lastStepKept.stoppedModelCallLeavesThePage

  /// A job start provisions the task it writes: a harness task gets its first prompt, and a
  /// model-call author sends its model call. A failed router write of the start does not stop it.
  val aJobStartProvisionsItsTask: bool = lastStepKept.aJobStartProvisionsItsTask

  /// A workflow whose end began reaches the finished status it ends as. Each step keeps the end
  /// until that status is written, also an instance restart. The end the store holds for a
  /// workflow that finished names that status, and only such an end records its post.
  val aWorkflowEndReachesAFinishedStatus: bool = and {
    lastStepKept.aWorkflowEndReachesAFinishedStatus,
    storedEndStatus(workflow).forall(endsAs => hasEnded(workflow.status) implies workflow.status == endsAs),
    endPostReturned(workflow) implies hasEnded(workflow.status),
  }

  /// A model-call author has at most one page write out at a time. A stop during the page write
  /// leaves the turn in flight until the write returns, so a prompt meanwhile waits for it.
  val aModelCallAuthorHasAtMostOnePageWriteOut: bool =
    jobIds(workflow).forall(id => pageWritesOut(workflow, id) <= 1)

  /// Only one live job works from each input. An unfinished job holds its input. A finished job
  /// holds it while its output exists, unless that output is the input itself.
  val oneLiveJobPerInputArtifact: bool =
    jobIds(workflow).forall(id => jobIds(workflow).forall(other => and {
      id != other,
      workflow.jobs[id].input == workflow.jobs[other].input,
      holdsItsInput(workflow, id),
    } implies not(holdsItsInput(workflow, other))))

  /// A finished task never changes status again, and a finished refiner run does not run again.
  val finishedTaskKeepsItsStatus: bool = lastStepKept.finishedTaskKeepsItsStatus

  /// An author or researcher in review has an artifact on its job.
  val inReviewTaskHasAnArtifact: bool =
    jobIds(workflow).forall(id =>
      anyTaskOf(workflow.jobs[id], task => task.status == InReview) implies
        workflow.jobs[id].artifact != NoArtifact)

  /// A workflow whose status is done, failed or cancelled has no unfinished task.
  val endedWorkflowHasNoUnfinishedTask: bool =
    hasEnded(workflow.status) implies not(hasUnfinishedTask(workflow))

  /// On a finished workflow, no event changes the status, the tasks, or the prompts. An event on
  /// an ended workflow does not tell the agent.
  val nothingReopensAFinishedWorkflow: bool = lastStepKept.nothingReopensAFinishedWorkflow

  /// An alarm of an older sandbox generation changes nothing. A stale alarm does not tell the
  /// agent.
  val staleAlarmIsIgnored: bool = lastStepKept.staleAlarmIsIgnored

  /// The sleep message posts only while the workflow runs from a plan.
  val sleepMessageOnlyDuringAWorkflow: bool = lastStepKept.sleepMessageOnlyDuringAWorkflow

  /// A workflow that is done, failed or cancelled keeps that status.
  val finishedWorkflowKeepsItsStatus: bool = lastStepKept.finishedWorkflowKeepsItsStatus

  /// A task restarts at most `MAX_RESTARTS` times, whatever the cause.
  val taskRestartsAtMostTwice: bool =
    jobIds(workflow).forall(id => not(anyTaskOf(workflow.jobs[id], task => task.restarts > MAX_RESTARTS)))

  /// A paused author or researcher does not get a prompt.
  val pausedAuthorGetsNoPrompt: bool = lastStepKept.pausedAuthorGetsNoPrompt

  /// The workflow moves to waiting for input only in a step that leaves no researcher or author busy.
  val workflowWaitsOnlyWhileNoAuthorWorks: bool = lastStepKept.workflowWaitsOnlyWhileNoAuthorWorks

  /// A restart or the deadline does not lose a model turn.
  val aRestartDoesNotLoseAModelTurn: bool = lastStepKept.aRestartDoesNotLoseAModelTurn

  /// An unpaused model-call author with a queued prompt has a model turn in flight or is starting.
  /// The start of a turn folds into the step that queues it, so an author that is starting has its
  /// model call out, or holds its lost model turn until its alarm runs it again.
  val aQueuedPromptReachesItsModelCallAuthor: bool =
    jobIds(workflow).forall(id => {
      val task = jobTask(workflow, id)
      val waiting = and {
        runsAsModelCalls(task),
        not(isFinished(task.status)),
        not(task.paused),
        task.promptsQueued.length() > 0,
      }
      waiting implies modelTurnInFlight(workflow, id)
    })

  /// A model-call author is working only while its model call or its page write is out, or after
  /// a stop ended its turn before its page existed. `Busy` covers starting, which folds into the
  /// step that sends the model call, or holds a lost model turn until its alarm runs it again. A
  /// paused task does not work, as `taskWorks` reads it, so a paused author whose produce turn was
  /// lost waits busy until its resume. An author that a stop ended before its page existed waits
  /// busy for its next prompt.
  val aModelCallAuthorWorksOnlyWhileItsCallIsOut: bool =
    jobIds(workflow).forall(id => {
      val task = jobTask(workflow, id)
      (runsAsModelCalls(task) and task.status == Busy and not(task.paused)) implies
        or {
          modelTurnInFlight(workflow, id),
          task.stopped and workflow.jobs[id].artifact == NoArtifact,
        }
    })

  /// A restarted author holds the new turn id of its lost model turn only while the alarm that runs
  /// that turn again is armed.
  val aTurnThatWaitsToRunAgainHasItsAlarm: bool =
    jobIds(workflow).forall(id =>
      (workflow.turnsToRunAgain.contains(id) and not(isFinished(jobTask(workflow, id).status))) implies
        workflow.runAgainAlarms.contains(id))

  /// A model-call author that a stop left without a turn does not start one until a prompt or a
  /// resume reaches it. The alarm that runs a lost model turn again does not start one either.
  val aStoppedModelCallAuthorStaysQuiet: bool =
    jobIds(workflow).forall(id => {
      val task = jobTask(workflow, id)
      (runsAsModelCalls(task) and task.stopped and not(isFinished(task.status))) implies
        not(modelTurnInFlight(workflow, id))
    })

  /// The prompts the workflow sent its tasks, a counter that model checking bounds.
  val promptsSent: int = promptsSentToTasks(workflow)

  /// The prompts that wait for a turn, a counter that model checking bounds. Each resume of an
  /// author at work queues one more.
  val promptsWaiting: int =
    jobIds(workflow).fold(0, (total, id) => total + jobTask(workflow, id).promptsQueued.length())

  /// The calls that are out, a counter that model checking bounds.
  val callsOut: int = workflow.calls.length()

  /// The jobs the workflow started, a counter that model checking bounds.
  val jobsStarted: int = workflow.jobs.length()

  /// Witness for `workflowStartsOnlyFromAPlan`: a plan starts the workflow.
  val aPlanStartsTheWorkflow: bool = lastStepReached.aPlanStartsTheWorkflow

  /// Witness for `workflowKeepsItsDefinition`: a plan lands on a started workflow.
  val aPlanLandsOnAStartedWorkflow: bool = lastStepReached.aPlanLandsOnAStartedWorkflow

  /// Witness for `workflowStartsOnlyFromAPlan`: a plan names a workflow definition the deployment
  /// does not hold.
  val anUndeclaredPlanLands: bool = lastStepReached.anUndeclaredPlanLands

  /// A plan without stages started the workflow, and the stages are not planned yet.
  val theWorkflowWaitsForItsStages: bool = workflow.definition != Unplanned and workflow.stagePlan == NoStages

  /// Witness for `jobStartsOnlyIntoAFreeSlot`: a later plan sets fewer job slots than the jobs
  /// that run.
  val aPlanLeavesFewerSlotsThanJobs: bool = lastStepReached.aPlanLeavesFewerSlotsThanJobs

  /// Witness for `jobStartsOnlyIntoAFreeSlot`: a job starts into the last slot.
  val aJobStartsIntoTheLastSlot: bool = lastStepReached.aJobStartsIntoTheLastSlot

  /// Witness for `jobStartsOnlyIntoAFreeSlot`: a job starts while a researcher holds a slot.
  val aJobStartsBesideAResearcher: bool = lastStepReached.aJobStartsBesideAResearcher

  /// Witness for `oneLiveJobPerInputArtifact`: two jobs share an input.
  val twoJobsShareAnInput: bool =
    jobIds(workflow).exists(id => jobIds(workflow).exists(other =>
      id != other and workflow.jobs[id].input == workflow.jobs[other].input))

  /// A job builds on the artifact of an earlier job.
  val aJobBuildsOnAnArtifact: bool =
    jobIds(workflow).exists(id => match workflow.jobs[id].input { | FromArtifactOf(_) => true | _ => false })

  /// Witness for `finishedTaskKeepsItsStatus`: a finished task is there before a step.
  val aFinishedTaskIsInAStep: bool = lastStepReached.aFinishedTaskIsInAStep

  /// Witness for `endedWorkflowHasNoUnfinishedTask`: a workflow ended with jobs.
  val aWorkflowEndedWithJobs: bool = hasEnded(workflow.status) and workflow.jobs.length() > 0

  /// Witness for `nothingReopensAFinishedWorkflow` and `finishedWorkflowKeepsItsStatus`: an event
  /// lands on a finished workflow.
  val anEventLandsOnAFinishedWorkflow: bool = lastStepReached.anEventLandsOnAFinishedWorkflow

  /// Witness for `staleAlarmIsIgnored`: a stale alarm fires.
  val aStaleAlarmFires: bool = lastStepReached.aStaleAlarmFires

  /// Witness for `staleAlarmIsIgnored`: a stale alarm fires while the deadline alarm of a model
  /// turn that ended is armed.
  val aStaleAlarmFindsAnEndedModelTurn: bool = lastStepReached.aStaleAlarmFindsAnEndedModelTurn

  /// Witness for `sleepMessageOnlyDuringAWorkflow` and `workflowWaitsOnlyWhileNoAuthorWorks`: the
  /// sleep message posts.
  val theSleepMessagePosts: bool = lastStepReached.theSleepMessagePosts

  /// A person's message wakes a sleeping workflow.
  val aMessageWakesTheWorkflow: bool = lastStepReached.aMessageWakesTheWorkflow

  /// An author restarted.
  val anAuthorRestarted: bool = jobIds(workflow).exists(id =>
    anyTaskOf(workflow.jobs[id], task => task.role == Author and task.restarts > 0))

  /// A researcher restarted.
  val aResearcherRestarted: bool = jobIds(workflow).exists(id =>
    anyTaskOf(workflow.jobs[id], task => task.role == Researcher and task.restarts > 0))

  /// A researcher handed over to the author of its job.
  val aResearcherHandedOver: bool = jobIds(workflow).exists(id => workflow.jobs[id].tasks.length() > 1)

  /// A restart closed the generation of a task and did not start the next one.
  val aRestartClosedAGeneration: bool = jobIds(workflow).exists(id => and {
    jobTask(workflow, id).generationClosed,
    REFINER != APolisher or workflow.jobs[id].refinerRuns.length() == 0,
  })

  /// A paused task restarted and waits for its resume to start the next generation.
  val aPausedAuthorWaitsToRestart: bool =
    jobIds(workflow).exists(id => jobTask(workflow, id).paused and jobTask(workflow, id).generationClosed)

  /// The store holds a workflow end whose status is not written yet.
  val theWorkflowIsEnding: bool = workflowEnding(workflow)

  /// Witness for `aWorkflowEndReachesAFinishedStatus`: an instance restart lands while the store
  /// holds a workflow end.
  val aRestartLandsDuringAWorkflowEnd: bool = lastStepReached.aRestartLandsDuringAWorkflowEnd

  /// Witness for `aWorkflowEndReachesAFinishedStatus`: the alarm goes on with a workflow end that
  /// an instance restart cut off.
  val aWorkflowEndResumesAfterARestart: bool = lastStepReached.aWorkflowEndResumesAfterARestart

  /// Witness for `anEndedWorkflowPostsItsEndOnce`: an instance restart lands after the status of a
  /// workflow end is written and before its post returned.
  val aRestartCutsTheEndPost: bool = lastStepReached.aRestartCutsTheEndPost

  /// Witness for `anEndedWorkflowPostsItsEndOnce`: the alarm goes on with a workflow end whose post
  /// returned before an instance restart cut its unbind.
  val aResumedEndFindsItsPostReturned: bool = lastStepReached.aResumedEndFindsItsPostReturned

  /// A prompt waits for the turn of a task to end.
  val aPromptWaits: bool = jobIds(workflow).exists(id => jobTask(workflow, id).promptsQueued.length() > 0)

  /// An author failed once its restarts were used up.
  val anAuthorFailed: bool = jobIds(workflow).exists(id =>
    anyTaskOf(workflow.jobs[id], task => task.role == Author and task.status == TaskFailed))

  /// A paused task resumes.
  val aPausedAuthorResumes: bool = lastStepReached.aPausedAuthorResumes

  /// Witness for `pausedAuthorGetsNoPrompt`: a person's verbal command pauses a researcher.
  val aPersonPausesAResearcher: bool = lastStepReached.aPersonPausesAResearcher

  /// Witness for `pausedAuthorGetsNoPrompt`: a prompt waits for a paused task.
  val aPromptWaitsForAPausedTask: bool = lastStepReached.aPromptWaitsForAPausedTask

  /// A prompt waits for the turn of an unpaused task to end.
  val aPromptWaitsForATurn: bool = lastStepReached.aPromptWaitsForATurn

  /// A verbal command finds several active jobs and goes to the agent.
  val aVerbalCommandFindsSeveralJobs: bool = lastStepReached.aVerbalCommandFindsSeveralJobs

  /// A polisher holds a prompt for its unpaused author.
  val aPolisherHoldsAPrompt: bool = jobIds(workflow).exists(id => and {
    polisherHoldsPrompts(workflow, id),
    not(jobTask(workflow, id).paused),
    jobTask(workflow, id).promptsQueued.length() > 0,
  })

  /// The polisher ends and its author takes a prompt that waited for it, in a new generation.
  val anAuthorTakesAPromptAfterItsPolisher: bool = lastStepReached.anAuthorTakesAPromptAfterItsPolisher

  /// A polisher runs while the container of its author is closed.
  val aPolisherClosedTheAuthorsContainer: bool = jobIds(workflow).exists(id =>
    polisherHoldsPrompts(workflow, id) and jobTask(workflow, id).generationClosed)

  /// Witness for `endedWorkflowHasNoUnfinishedTask`: the end of the workflow cancels a refiner run.
  val aWorkflowEndCancelsARefinerRun: bool = lastStepReached.aWorkflowEndCancelsARefinerRun

  /// A job completes.
  val aJobCompletes: bool = jobIds(workflow).exists(id =>
    anyTaskOf(workflow.jobs[id], task => task.role == Author and task.status == TaskDone))

  /// The acceptance check of a completion is out.
  val anAcceptanceCheckIsOut: bool = outCalls(workflow, AcceptanceCheck).size() > 0

  /// A restart of the Durable Object dropped a call.
  val aCallWasDropped: bool = lastStepReached.aCallWasDropped

  /// Witness for `aFailedCheckNeverCompletesAJob`: the acceptance check of a job fails.
  val anAcceptanceCheckFails: bool = lastStepReached.anAcceptanceCheckFails

  /// Witness for `aFailedCheckNeverCompletesAJob`: the acceptance check of a job fails after its
  /// author ended.
  val aCheckFailsAfterItsAuthorEnded: bool = lastStepReached.aCheckFailsAfterItsAuthorEnded

  /// Witness for `aFailedCheckNeverAsksThePersonAgain`: `complete_job` tells the agent to ask the
  /// person again.
  val theAgentIsToldToAskAgain: bool = lastStepAnswered == AsksAgain

  /// Witness for `aRestartDoesNotLoseAModelTurn`: a restart of the Durable Object cuts a model turn.
  val aRestartCutsAModelTurn: bool = lastStepReached.aRestartCutsAModelTurn

  /// Witness for `aRestartDoesNotLoseAModelTurn`: the deadline of a model turn in flight passes.
  val aModelTurnOutlivesItsDeadline: bool = lastStepReached.aModelTurnOutlivesItsDeadline

  /// Witness for `aRestartDoesNotLoseAModelTurn`: a revise turn is cut.
  val aReviseTurnIsCut: bool = lastStepReached.aReviseTurnIsCut

  /// Witness for `aRestartDoesNotLoseAModelTurn`: a paused author loses its model turn.
  val aPausedAuthorLosesAModelTurn: bool = lastStepReached.aPausedAuthorLosesAModelTurn

  /// Witness for `aRestartDoesNotLoseAModelTurn`: an author with no restarts left loses its model turn.
  val anAuthorFailsOnALostModelTurn: bool = lastStepReached.anAuthorFailsOnALostModelTurn

  /// Witness for `aRestartDoesNotLoseAModelTurn`: a restart of the Durable Object cuts a model turn
  /// while its page write is out.
  val aRestartCutsAPageWrite: bool = lastStepReached.aRestartCutsAPageWrite

  /// Witness for `aRestartDoesNotLoseAModelTurn`: the deadline of a model turn passes while its
  /// page write is out.
  val aDeadlinePassesDuringAPageWrite: bool = lastStepReached.aDeadlinePassesDuringAPageWrite

  /// Witness for `aRestartDoesNotLoseAModelTurn`: a restart of the Durable Object cuts the turn
  /// that produces a page.
  val aRestartCutsAProduceTurn: bool = lastStepReached.aRestartCutsAProduceTurn

  /// Witness for `aRestartDoesNotLoseAModelTurn`: the deadline of the turn that produces a page
  /// passes.
  val aDeadlinePassesDuringAProduceTurn: bool = lastStepReached.aDeadlinePassesDuringAProduceTurn

  /// Witness for `aRestartDoesNotLoseAModelTurn`: a restart of the Durable Object cuts a model turn
  /// that runs again after a deadline or an earlier restart lost one.
  val aRestartCutsARerunModelTurn: bool = lastStepReached.aRestartCutsARerunModelTurn

  /// Witness for `aQueuedPromptReachesItsModelCallAuthor`: a person's message in the session of the
  /// subject issue goes to its model-call author while that author runs.
  val aSessionMessageReachesAModelCallAuthorAtWork: bool =
    lastStepReached.aSessionMessageReachesAModelCallAuthorAtWork

  /// Witness for `aModelCallAuthorWorksOnlyWhileItsCallIsOut`: the page write of a model turn is out.
  val aPageWriteIsOut: bool = outCalls(workflow, PageWrite).size() > 0

  /// The page write of a model turn is out while its author is finished.
  val aPageWriteOutlivesItsAuthor: bool = workflow.calls.indices().exists(callId => and {
    workflow.calls[callId].kind == PageWrite,
    isFinished(jobTask(workflow, workflow.calls[callId].job).status),
  })

  /// Witness for `aQueuedPromptReachesItsModelCallAuthor`: a prompt waits for an unpaused
  /// model-call author.
  val aPromptWaitsForAModelCallAuthor: bool = jobIds(workflow).exists(id => and {
    runsAsModelCalls(jobTask(workflow, id)),
    not(isFinished(jobTask(workflow, id).status)),
    not(jobTask(workflow, id).paused),
    jobTask(workflow, id).promptsQueued.length() > 0,
  })

  /// Witness for `aModelCallAuthorWorksOnlyWhileItsCallIsOut`: a paused model-call author waits
  /// busy without a model turn in flight.
  val aPausedModelCallAuthorWaitsBusy: bool = jobIds(workflow).exists(id => and {
    runsAsModelCalls(jobTask(workflow, id)),
    jobTask(workflow, id).status == Busy,
    jobTask(workflow, id).paused,
    not(modelTurnInFlight(workflow, id)),
  })

  /// Witness for `stoppedModelCallLeavesThePage`: a stop ends a model turn whose model call is out.
  val aStopEndsAModelCall: bool = lastStepReached.aStopEndsAModelCall

  /// Witness for `stoppedModelCallLeavesThePage`: the model call of a turn that a stop ended
  /// returns.
  val aStoppedModelCallReturns: bool = lastStepReached.aStoppedModelCallReturns

  /// Witness for `aJobStartProvisionsItsTask`: a job starts past a failed router write of the
  /// start.
  val aJobStartsPastAFailedRouterWrite: bool = lastStepReached.aJobStartsPastAFailedRouterWrite

  /// Witness for `aModelCallAuthorHasAtMostOnePageWriteOut`: a stop lands while the page write of
  /// the author's model turn is out.
  val aStopLandsDuringAPageWrite: bool = lastStepReached.aStopLandsDuringAPageWrite

  /// Witness for `aQueuedPromptReachesItsModelCallAuthor`: an event lands after an instance
  /// restart cut a model turn and before its restart alarm fires.
  val anEventLandsBeforeTheRestartAlarm: bool = lastStepReached.anEventLandsBeforeTheRestartAlarm

  /// Witness for `aQueuedPromptReachesItsModelCallAuthor`: an event lands after the restart alarm
  /// restarted an author and before its lost model turn runs again.
  val anEventLandsBeforeALostModelTurnRunsAgain: bool = lastStepReached.anEventLandsBeforeALostModelTurnRunsAgain

  /// Witness for `aRestartDoesNotLoseAModelTurn`: the Durable Object restarts again before the
  /// restart alarm of the last restart fires.
  val aRestartLandsBeforeTheRestartAlarm: bool = lastStepReached.aRestartLandsBeforeTheRestartAlarm

  /// Witness for `aRestartDoesNotLoseAModelTurn` and `aTurnThatWaitsToRunAgainHasItsAlarm`: the
  /// Durable Object restarts again before a restarted author runs its lost model turn again.
  val aRestartLandsBeforeALostModelTurnRunsAgain: bool = lastStepReached.aRestartLandsBeforeALostModelTurnRunsAgain

  /// Witness for `taskRestartsAtMostTwice`: the restart alarm fails an author with no restarts left.
  val theRestartAlarmFailsAnAuthor: bool = lastStepReached.theRestartAlarmFailsAnAuthor

  /// Witness for `aRestartDoesNotLoseAModelTurn`: the platform delivers a restart alarm again.
  val aRestartAlarmFiresAgain: bool = lastStepReached.aRestartAlarmFiresAgain

  /// Witness for `aModelCallAuthorHasAtMostOnePageWriteOut`: the platform delivers the alarm that
  /// runs a lost model turn again once more.
  val aLostModelTurnRunsAgainOnceMore: bool = lastStepReached.aLostModelTurnRunsAgainOnceMore

  /// Witness for `aStoppedModelCallAuthorStaysQuiet` and `aTurnThatWaitsToRunAgainHasItsAlarm`: a
  /// stop takes the lost model turn that an author holds until its run-again alarm.
  val aStopTakesATurnThatWaitsToRunAgain: bool = lastStepReached.aStopTakesATurnThatWaitsToRunAgain

  /// Witness for `aStoppedModelCallAuthorStaysQuiet`: the run-again alarm of a stopped author fires.
  val aRunAgainAlarmFindsAStoppedAuthor: bool = lastStepReached.aRunAgainAlarmFindsAStoppedAuthor

  /// Witness for `staleAlarmIsIgnored`: the deadline of a lost model turn fires before the turn
  /// runs again.
  val aLostModelTurnDeadlineFires: bool = lastStepReached.aLostModelTurnDeadlineFires

  /// Witness for `taskRestartsAtMostTwice`: a restart alarm decides a turn that waited for its
  /// run-again alarm when a later instance restart cut it, which counts another restart.
  val aRestartAlarmDecidesATurnThatWaitedToRunAgain: bool =
    lastStepReached.aRestartAlarmDecidesATurnThatWaitedToRunAgain

  /// Witness for `aModelCallAuthorHasAtMostOnePageWriteOut`: a prompt waits for a model turn whose
  /// page write a stop reached.
  val aPromptWaitsForAStoppedPageWrite: bool = workflow.calls.indices().exists(callId => and {
    isStoppedPageWrite(workflow.calls[callId]),
    jobTask(workflow, workflow.calls[callId].job).promptsQueued.length() > 0,
  })

  /// Witness for `aModelCallAuthorWorksOnlyWhileItsCallIsOut`: an unpaused model-call author that a
  /// stop ended before its page existed waits busy for its next prompt.
  val aStoppedAuthorWaitsForItsPage: bool = jobIds(workflow).exists(id => and {
    runsAsModelCalls(jobTask(workflow, id)),
    jobTask(workflow, id).status == Busy,
    not(jobTask(workflow, id).paused),
    not(modelTurnInFlight(workflow, id)),
  })

  /// A refiner run reads the page of a model-call author.
  val aModelCallPageIsReviewed: bool = jobIds(workflow).exists(id =>
    runsAsModelCalls(jobTask(workflow, id)) and workflow.jobs[id].refinerRuns.length() > 0)

  /// A refiner run reads the page while a model turn of its author is in flight.
  val aModelTurnRunsUnderReview: bool =
    jobIds(workflow).exists(id => refinerRunning(workflow.jobs[id]) and modelTurnInFlight(workflow, id))

  /// A revise turn of a model-call author is in flight.
  val aReviseTurnIsInFlight: bool =
    modelTurnsInFlight(workflow).exists(id => workflow.jobs[id].artifact != NoArtifact)

  /// The reviewer of a page approved it.
  val aRefinerRunIsDone: bool = jobIds(workflow).exists(id => hasRefinerRun(workflow.jobs[id], RefinerDone))

  /// The end of a review cancelled the reviewer of a page.
  val aRefinerRunIsCancelled: bool =
    jobIds(workflow).exists(id => hasRefinerRun(workflow.jobs[id], RefinerCancelled))

  /// The reviewer of a page failed.
  val aRefinerRunFailed: bool = jobIds(workflow).exists(id => hasRefinerRun(workflow.jobs[id], RefinerFailed))

  /// The reviewer of a page failed while its author works, and the humans have the page.
  val aRefinerRunFailsWhileItsAuthorWorks: bool = jobIds(workflow).exists(id => and {
    workflow.jobs[id].refinerRuns.length() > 0,
    workflow.jobs[id].refinerRuns[workflow.jobs[id].refinerRuns.length() - 1] == RefinerFailed,
    workflow.jobs[id].artifact == Ready,
    jobTask(workflow, id).turnRunning or modelTurnInFlight(workflow, id),
    not(isFinished(jobTask(workflow, id).status)),
  })

  /// Witness for `inReviewTaskHasAnArtifact`: an author waits in review.
  val anAuthorIsInReview: bool = jobIds(workflow).exists(id => jobTask(workflow, id).status == InReview)

  /// Witness for `artifactStatusMovesAreLegal`: the humans have a page.
  val theHumansHaveAPage: bool = jobIds(workflow).exists(id => workflow.jobs[id].artifact == Ready)

  /// Witness for `anEndedWorkflowPostsItsEndOnce`: the workflow finished done.
  val theWorkflowIsDone: bool = workflow.status == Done

  /// Witness for `anEndedWorkflowPostsItsEndOnce`: the workflow failed.
  val theWorkflowFailed: bool = workflow.status == Failed

  /// Witness for `aSingleIssueWorkflowIsDoneWithItsSubjectsJob`: `complete_job` on the subject
  /// issue's job ends the workflow done.
  val aSubjectsJobEndsTheWorkflow: bool = lastStepReached.aSubjectsJobEndsTheWorkflow

  /// Witness for `aSingleIssueWorkflowIsDoneWithItsSubjectsJob`: the host says it merged the pull
  /// of the subject issue's job, and the job completes.
  val theAcceptanceCheckCompletesTheSubjectsJob: bool = lastStepReached.theAcceptanceCheckCompletesTheSubjectsJob

  /// Witness for `anAcceptedArtifactNeverMovesBack`: the host accepted an artifact.
  val anArtifactIsAccepted: bool = jobIds(workflow).exists(id => workflow.jobs[id].artifact == Accepted)

  /// Witness for `anAcceptedArtifactNeverMovesBack`: the host removed an artifact.
  val anArtifactIsRemoved: bool = jobIds(workflow).exists(id => workflow.jobs[id].artifact == Removed)

  /// Witness for `anAcceptedArtifactNeverMovesBack`: the host reopened a pull whose artifact is
  /// removed.
  val aRemovedPullIsOpenAgain: bool = jobIds(workflow).exists(id => and {
    workflow.jobs[id].artifact == Removed,
    workflow.jobs[pullOpenerOf(workflow, id)].pullOnHost == PullOpen,
  })

  /// Witness for `artifactStatusMovesAreLegal`: a start records an earlier pull the host closed as
  /// removed.
  val aStartRecordsARemovedPull: bool = lastStepReached.aStartRecordsARemovedPull

  /// Witness for `oneJobAtATimePerIssueUntilOneCompletes`: `start_job` names an issue in the
  /// subject whose job completed, and the start is refused.
  val aStartOnAnIssueWhoseJobCompletedIsRefused: bool = lastStepReached.aStartOnAnIssueWhoseJobCompletedIsRefused

  /// Witness for `oneJobAtATimePerIssueUntilOneCompletes`: a job retries an issue whose earlier job
  /// was cancelled or failed.
  val aJobRetriesAnIssue: bool = ISSUES.exists(issue => jobsOnIssue(workflow, issue).length() > 1)

  /// A person ends a sub-issue on the tracker, and its job is cancelled.
  val aSubIssueEndCancelsItsJob: bool = lastStepReached.aSubIssueEndCancelsItsJob

  /// A person ends the subject issue on the tracker, and the workflow is cancelled.
  val theSubjectIssueEndCancelsTheWorkflow: bool = lastStepReached.theSubjectIssueEndCancelsTheWorkflow

  /// A person ends an issue whose artifact the host accepted, and the cancel is left alone.
  val anIssueEndFindsAnAcceptedArtifact: bool = lastStepReached.anIssueEndFindsAnAcceptedArtifact

  /// A person writes the cancel word in the session of the subject issue, and its author gets it.
  val aCancelWordReachesTheSubjectsAuthor: bool = lastStepReached.aCancelWordReachesTheSubjectsAuthor

  /// Witness for `workflowStartsOnlyFromAPlan`: the workflow moved a tracker issue.
  val theWorkflowMovedAnIssue: bool = workflow.issueMoves > 0

  /// Witness for `aPersonsMessageWakesTheWorkflow`: a person's message lands on a workflow that
  /// waits for input.
  val aMessageLandsOnAWaitingWorkflow: bool = lastStepReached.aMessageLandsOnAWaitingWorkflow

  /// Witness for `issuesMoveOnlyAtAStartOrADoneEnd`: a workflow from a tracker origin ends failed
  /// or cancelled.
  val aTrackerWorkflowEndsWithoutDone: bool = lastStepReached.aTrackerWorkflowEndsWithoutDone

  /// Witness for `issuesMoveOnlyAtAStartOrADoneEnd`: a workflow from a tracker origin ends done.
  val aTrackerWorkflowEndsDone: bool = TRACKER_ORIGIN and workflow.status == Done

  /// Known limit of row T33: a restart of the Durable Object cuts the produce turn of a model-call
  /// author while the page create is out. The turn runs again and creates a second page.
  val aRestartCutsAPageCreate: bool = lastStepReached.aRestartCutsAPageCreate

  /// Witness for `eachFailedTaskPostsItsFailureOnce`: a harness author sends its failure post once
  /// the destroy of its sandbox returned.
  val aHarnessAuthorPostsItsFailureAfterItsDestroy: bool = lastStepReached.aHarnessAuthorPostsItsFailureAfterItsDestroy

  /// Witness for `eachFailedTaskPostsItsFailureOnce`: a researcher fails past its restarts and posts.
  val aResearcherPostsItsFailure: bool = lastStepReached.aResearcherPostsItsFailure

  /// Witness for `eachFailedTaskPostsItsFailureOnce`: the page model fails a model call, or the
  /// document host fails a page write, and its author sends its failure post.
  val aModelCallHostErrorPostsAFailure: bool = lastStepReached.aModelCallHostErrorPostsAFailure

  /// Witness for `aFinishedAuthorsSandboxIsDestroyed`: a restart of the Durable Object cuts the
  /// destroy of a cancelled harness author's sandbox.
  val aRestartCutsTheDestroyOfACancelledAuthor: bool = lastStepReached.aRestartCutsTheDestroyOfACancelledAuthor

  /// Witness for `eachFailedTaskPostsItsFailureOnce`: a restart of the Durable Object cuts the
  /// destroy of a failed harness author's sandbox before its failure posts.
  val aRestartCutsTheDestroyOfAFailedAuthor: bool = lastStepReached.aRestartCutsTheDestroyOfAFailedAuthor

  /// Witness for `aFinishedAuthorsSandboxIsDestroyed`: a restart of the Durable Object cuts the
  /// destroy of a completed harness author's sandbox.
  val aRestartCutsTheDestroyOfACompletedAuthor: bool = lastStepReached.aRestartCutsTheDestroyOfACompletedAuthor

  /// Witness for `eachFailedTaskPostsItsFailureOnce`: a restart of the Durable Object cuts the
  /// failure post of a researcher or author.
  val aRestartCutsAFailurePost: bool = lastStepReached.aRestartCutsAFailurePost

  /// Witness for `aFinishedAuthorsSandboxIsDestroyed` and
  /// `eachFailedTaskPostsItsFailureOnce`: the task end alarm goes on with a teardown that a
  /// restart cut off.
  val aTaskEndAlarmResumesATeardown: bool = lastStepReached.aTaskEndAlarmResumesATeardown

  /// Witness for `eachFailedTaskPostsItsFailureOnce`: the task end alarm fires while its teardown
  /// still runs in this instance, and changes nothing.
  val aTaskEndAlarmFindsItsTeardownOut: bool = lastStepReached.aTaskEndAlarmFindsItsTeardownOut

  /// Witness for `aCompletedJobEndsItsReview`: `complete_job` ends a job while its refiner run runs.
  val aJobCompletesDuringItsReview: bool = lastStepReached.aJobCompletesDuringItsReview

  /// Witness for `aCompletedJobEndsItsReview`: the end of a completed harness author finishes once
  /// the destroy of its sandbox returns.
  val aHarnessAuthorCompletesAfterItsDestroy: bool = lastStepReached.aHarnessAuthorCompletesAfterItsDestroy

  /// Witness for `aCompletedJobEndsItsReview`: the destroy that the task end alarm of a done author
  /// sent returns, and the end of its review goes on from there.
  val aTaskEndAlarmFinishesACompletion: bool = lastStepReached.aTaskEndAlarmFinishesACompletion

  /// Witness for `aSingleIssueWorkflowIsDoneWithItsSubjectsJob`: the destroy that the task end
  /// alarm of the subject job's done author sent returns, and the completion goes on toward the
  /// workflow end.
  val aTaskEndAlarmEndsASingleIssueWorkflow: bool = lastStepReached.aTaskEndAlarmEndsASingleIssueWorkflow

  /// Witness for `aDoneResearchersJobHasItsAuthor`: an instance restart cuts the destroy of the
  /// sandbox of a researcher that handed over.
  val aRestartCutsTheDestroyOfAResearcherThatHandedOver: bool =
    lastStepReached.aRestartCutsTheDestroyOfAResearcherThatHandedOver

  /// Witness for `aDoneResearchersJobHasItsAuthor`: the task end alarm of a researcher that handed
  /// over destroys its sandbox again.
  val aResearcherEndAlarmDestroysTheSandboxAgain: bool = lastStepReached.aResearcherEndAlarmDestroysTheSandboxAgain

  /// Witness for `aModelCallAuthorWorksOnlyWhileItsCallIsOut`: a stop left a model-call author at
  /// work without a turn and without a page.
  val aStopLeavesAnAuthorWithoutAPage: bool = jobIds(workflow).exists(id => and {
    runsAsModelCalls(jobTask(workflow, id)),
    jobTask(workflow, id).status == Busy,
    jobTask(workflow, id).stopped,
    workflow.jobs[id].artifact == NoArtifact,
  })

  /// Witness for `aJobWorksOnlyOnIssuesOfItsSubject`: `start_job` names an issue before the
  /// workflow has a subject.
  val aStartBeforeTheSubjectIsRefused: bool = lastStepReached.aStartBeforeTheSubjectIsRefused

  /// Witness for `aJobWorksOnlyOnIssuesOfItsSubject`: `start_job` names an issue outside the
  /// subject.
  val aStartOutsideTheSubjectIsRefused: bool = lastStepReached.aStartOutsideTheSubjectIsRefused

  /// Witness for `aJobWorksOnlyOnIssuesOfItsSubject`: a job works on the sub-issue of the subject
  /// issue.
  val aJobWorksOnASubIssue: bool = and {
    workflow.subject == SubjectIssue(SUBJECT_ISSUE),
    jobIds(workflow).exists(id => workflow.jobs[id].input == FromIssue(SUB_ISSUE)),
  }

  /// Witness for `aJobWorksOnlyOnIssuesOfItsSubject`: a job works on an issue of the subject
  /// project.
  val aJobWorksOnAnIssueOfTheProject: bool = and {
    workflow.subject == SubjectProject,
    jobIds(workflow).exists(id => match workflow.jobs[id].input {
      | FromIssue(_) => true
      | _ => false
    }),
  }

  /// Witness for `subjectNeverChanges`: a plan sets the subject.
  val aPlanSetsTheSubject: bool = lastStepReached.aPlanSetsTheSubject

  /// Witness for `subjectNeverChanges`: a plan names another subject than the workflow has.
  val aPlanNamesAnotherSubject: bool = lastStepReached.aPlanNamesAnotherSubject

  /// Witness for `subjectNeverChanges`: the output of a breakdown author sets the subject.
  val anOutputSetsTheSubject: bool = lastStepReached.anOutputSetsTheSubject

  /// Witness for `subjectNeverChanges`: the output of a breakdown author names another subject
  /// than the workflow has.
  val anOutputNamesAnotherSubject: bool = lastStepReached.anOutputNamesAnotherSubject

  /// Witness for `oneLiveJobPerInputArtifact`: a breakdown job on the subject issue finished with
  /// an output that names it, so it does not hold the issue.
  val anOutputIsItsInput: bool = jobIds(workflow).exists(id =>
    outputIsItsInput(workflow, id) and isFinished(jobTask(workflow, id).status))
}
