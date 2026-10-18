/// The lifecycle of one workflow and its jobs, from the request to the end of the workflow.
/// Each action is one step of the orchestrator that runs to its end before the next event lands.
/// Four calls split a step: the destroy of a harness author's sandbox, the acceptance check of
/// `complete_job`, and the model call and the page write of a model-call author. One action sends
/// the call and a later action returns it. A restart of the Durable Object drops every call that is
/// out, with the rest of its step. The world answers every other await at once, so the model folds
/// those into the step. The start of a task folds into the step that queues it: a harness gets its
/// first prompt, and a model-call author sends its model call. A refiner run is modelled only as
/// running, done, cancelled or failed. The review loop spec holds the rules of the run itself.
/// A setup works pages for a chat request, or pulls for a tracker issue. The host and the tracker
/// of a setup with pulls change outside the workflow, and the workflow hears of it as events.
module workflowLifecycleTypes {
  type WorkflowStatus = New | Running | WaitingInput | Done | Failed | Cancelled

  /// The workflow definition the plan started the workflow from, by its place in the deployment.
  type PlanDefinition = Unplanned | Planned(int)

  /// `Busy` covers queued, provisioning and working. `InReview` is an author whose page is out.
  type TaskStatus = Busy | InReview | TaskDone | TaskCancelled | TaskFailed

  /// The role of a job task: the researcher that runs before the author, or the author.
  type Role = Researcher | Author

  /// A researcher or author task. `turnRunning` holds while a prompt is in flight in its harness,
  /// also after the task finished. `promptsSent` counts the prompts the workflow sent the task:
  /// those its harness got, and for a model-call author those a model turn started on.
  /// `promptsQueued` counts the prompts that wait for a turn. `generationClosed` holds while the
  /// container of the task's generation is closed and the task waits for a prompt to start the
  /// next one. A restart of a paused task closes it, and so does a polisher as it starts.
  /// `startOrder` is the place of the task among the researchers and authors of the workflow, in
  /// the order they started.
  type Task = {
    role: Role,
    startOrder: int,
    status: TaskStatus,
    restarts: int,
    paused: bool,
    turnRunning: bool,
    promptsSent: int,
    promptsQueued: int,
    generationClosed: bool,
  }

  /// `Accepted` and `Removed` record that the host merged or closed the artifact. Only a pull gets
  /// there here.
  type ArtifactStatus = NoArtifact | Drafted | Ready | Accepted | Removed

  /// What the jobs of a setup work on: pages for a request in a chat thread, or pulls for tracker
  /// issues under the issue the workflow started from, with one stage that ends a single-issue
  /// workflow. A pull setup has the host move pulls on the subject issue, a person end the subject
  /// issue or a sub-issue, or jobs on both issues without moves from outside.
  type Work =
    | PagesForAChatRequest
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

  type CallKind = SandboxDestroy | AcceptanceCheck | ModelCall | PageWrite

  /// The end of a task that went on after its teardown.
  type Teardown = AfterCancel | AfterFail | AfterComplete

  /// Who ended the task: a tool call or an event, the end of the workflow with the status it ends
  /// as, or `complete_job` on the job of the subject issue, which ends the workflow done once the
  /// teardown went on.
  type Caller = ToolOrEvent | WorkflowEnd(WorkflowStatus) | SubjectJobCompletes

  /// The rest of the step that runs when the call returns. `RestartAfterWake` is a restart whose
  /// author a resume woke in a new generation while its old container went. It stops there.
  /// `PageWriteStarts` is the model turn that writes the answer of its model call to the page.
  /// `ModelTurnGoesOn` is the model turn that goes on once its page write landed.
  type Rest =
    | TeardownGoesOn({ teardown: Teardown, caller: Caller })
    | RestartGoesOn
    | RestartAfterWake
    | CompletionGoesOn
    | PageWriteStarts
    | ModelTurnGoesOn

  /// A call that is out. It leaves the list when it returns, or when a restart of the Durable
  /// Object drops it.
  type Call = { kind: CallKind, job: int, rest: Rest }

  /// The stages a plan set, with the number of job slots it gave the workflow. A plan without
  /// stages only starts the workflow.
  type StagePlan = NoStages | StagesPlanned(int)

  /// `failuresPosted` counts the posts that tell the person a researcher or author failed.
  /// `issueMoves` counts the moves of a tracker issue the workflow made. `endedIssues` holds the
  /// issues a person moved to a canceled or completed state on the tracker.
  type Workflow = {
    status: WorkflowStatus,
    definition: PlanDefinition,
    stagePlan: StagePlan,
    idleArmed: bool,
    jobs: List[Job],
    calls: List[Call],
    failuresPosted: int,
    issueMoves: int,
    endedIssues: Set[int],
  }

  /// A verbal command that acts on a job. The cancel ends the workflow, so it is an `Ending`.
  type VerbalCommand = Pause | Resume | Instruct

  /// What an observer knows about the last step besides the states around it. `DeadlineStep` is
  /// the deadline alarm of the model turn of a job. `PromptStep` is the agent's prompt to a task.
  /// `FinishStep` is `finish_workflow`. `SubjectCompletionStep` runs `complete_job` on the job of
  /// the subject issue up to its end or its next call, and so does the return of each call it
  /// waits on. `IssueEndStep` is a person moving the issue to a canceled or completed state.
  type StepKind =
    | OtherStep
    | PlanStep(int)
    | EventStep
    | VerbalCommandStep(VerbalCommand)
    | PromptStep
    | StaleAlarmStep
    | SleepStep
    | RestartStep
    | DeadlineStep(int)
    | FinishStep
    | SubjectCompletionStep
    | IssueEndStep(int)

  /// The timers whose alarms are about one sandbox generation.
  type GenerationTimer = HelloTimeout | NoProgress | KeepAlive | BridgeLost | QueueRetry | SettleIdleAuthor

  /// One step: the workflow before it, the workflow after it, and what an observer knows of it.
  type Transition = { before: Workflow, after: Workflow, kind: StepKind }

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
    aSubIssueEndCancelsItsJob: bool,
    theSubjectIssueEndCancelsTheWorkflow: bool,
    anIssueEndFindsAnAcceptedArtifact: bool,
    aCancelWordReachesTheSubjectsAuthor: bool,
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

  /// The numbers of job slots a plan can set.
  const SLOT_COUNTS: Set[int]

  /// How often a task restarts before it fails.
  pure val MAX_RESTARTS: int = 2

  /// The most jobs a trace starts.
  pure val MAX_JOBS: int = 3

  /// The request texts a job can work from.
  pure val REQUESTS: Set[int] = 0.to(1)

  /// True when the jobs open pulls for tracker issues.
  pure val WORKS_ON_PULLS: bool = WORK != PagesForAChatRequest

  /// The issue the workflow started from, which is its subject.
  pure val SUBJECT_ISSUE: int = 0

  /// A sub-issue of the subject issue.
  pure val SUB_ISSUE: int = 1

  /// The tracker issues a job can work from.
  pure val ISSUES: Set[int] = match WORK {
    | PullsForAnEndedSubIssue => Set(SUB_ISSUE)
    | PullsForTwoIssues => Set(SUBJECT_ISSUE, SUB_ISSUE)
    | _ => Set(SUBJECT_ISSUE)
  }

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
    idleArmed: true,
    jobs: List(),
    calls: List(),
    failuresPosted: 0,
    issueMoves: 0,
    endedIssues: Set(),
  }

  var workflow: Workflow
  var lastStepKept: KeptRules
  var lastStepReached: ReachedWitnesses

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

  /// True for the calls of a model turn: its model call and its page write.
  pure def isModelTurnCall(kind: CallKind): bool = kind == ModelCall or kind == PageWrite

  /// True while the model turn of the job's unfinished model-call author is in flight: its model
  /// call or its page write is out.
  pure def modelTurnInFlight(flow: Workflow, id: int): bool = and {
    not(isFinished(jobTask(flow, id).status)),
    flow.calls.indices().exists(callId =>
      isModelTurnCall(flow.calls[callId].kind) and flow.calls[callId].job == id),
  }

  /// True while the page write of the job's model turn is out.
  pure def pageWriteOut(flow: Workflow, id: int): bool =
    flow.calls.indices().exists(callId => flow.calls[callId].kind == PageWrite and flow.calls[callId].job == id)

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
      promptsQueued: 0,
      generationClosed: false,
    }
  }

  /// The model call a task sends as it starts, when it is a model-call author.
  pure def sendFirstModelCall(flow: Workflow, id: int): Workflow =
    if (runsAsModelCalls(jobTask(flow, id))) sendCall(flow, ModelCall, id, PageWriteStarts) else flow

  /// The status a task takes from `finishTask`. The status is written before the sandbox goes.
  /// A prompt in flight stays in flight on the finished task. The model turn of a model-call
  /// author ends with it.
  pure def finishTask(flow: Workflow, id: int, status: TaskStatus): Workflow =
    withTask(flow, id, {
      ...jobTask(flow, id),
      status: status,
      promptsQueued: 0,
      generationClosed: false,
    })

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

  /// A job holds its input while its task is unfinished, and after that while its output exists
  /// and the host has not removed it. A job that continues a pull does not hold it once finished.
  pure def holdsItsInput(job: Job): bool = or {
    not(isFinished(job.tasks[job.tasks.length() - 1].status)),
    job.artifact != NoArtifact and job.artifact != Removed and not(continuesAPull(job)),
  }

  pure def inputHeld(flow: Workflow, input: Input): bool =
    jobIds(flow).exists(id => flow.jobs[id].input == input and holdsItsInput(flow.jobs[id]))

  /// True while the loop of a workflow end waits on the destroy of an author's sandbox. Only this
  /// instance knows it, so a restart of the Durable Object forgets it with the calls it drops.
  pure def workflowEnding(flow: Workflow): bool =
    flow.calls.indices().exists(callId => match flow.calls[callId].rest {
      | TeardownGoesOn(teardown) => match teardown.caller {
        | WorkflowEnd(_) => true
        | _ => false
      }
      | _ => false
    })

  /// True when a call that is out goes on for this caller once it returns.
  pure def callOutFor(flow: Workflow, caller: Caller): bool =
    flow.calls.indices().exists(callId => match flow.calls[callId].rest {
      | TeardownGoesOn(teardown) => teardown.caller == caller
      | _ => false
    })

  /// The job slots of the workflow: those the plan set with the stages. Before that, a page
  /// stage has none, and a pull stage has those the workflow opened with.
  pure def jobSlotsOf(flow: Workflow): int = match flow.stagePlan {
    | NoStages => if (WORKS_ON_PULLS) UNPLANNED_SLOTS else 0
    | StagesPlanned(jobSlots) => jobSlots
  }

  /// True when a job slot is free. A refiner run takes no slot.
  pure def hasAFreeJobSlot(flow: Workflow): bool = unfinishedJobIds(flow).length() < jobSlotsOf(flow)

  pure def canStartJob(flow: Workflow, input: Input): bool = and {
    not(hasEnded(flow.status)),
    not(workflowEnding(flow)),
    hasAFreeJobSlot(flow),
    not(inputHeld(flow, input)),
  }

  /// `startJob`: the job starts with its researcher when the stage runs one, else with its author.
  pure def startedJob(flow: Workflow, input: Input): Workflow = {
    val task = newTask(flow, if (RESEARCH) Researcher else Author)
    val job = { input: input, tasks: List(task), artifact: NoArtifact, refinerRuns: List(), pullOnHost: NoPull }
    sendFirstModelCall({ ...flow, jobs: flow.jobs.append(job), status: Running }, flow.jobs.length())
  }

  /// `startAuthorAfterResearch`: the researcher finishes done once its turn ended with the research
  /// payload, and the author of its job starts.
  pure def researchHandedOver(flow: Workflow, id: int): Workflow = {
    val done = finishTask(
      withTask(flow, id, { ...jobTask(flow, id), turnRunning: false }),
      id,
      TaskDone,
    )
    val job = done.jobs[id]
    sendFirstModelCall(withJob(done, id, { ...job, tasks: job.tasks.append(newTask(done, Author)) }), id)
  }

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

  /// The loop of a workflow end cancels the unfinished refiner runs and sets the status last. A
  /// cancelled polisher hands the page it holds to the humans blocked. A workflow from a tracker
  /// issue that ends done moves that issue to completed.
  pure def finishWorkflowEnd(flow: Workflow, endsAs: WorkflowStatus): Workflow = {
    val stopped = range(0, MAX_JOBS).select(id => id < flow.jobs.length()).foldl(flow, (ending, id) =>
      if (not(refinerRunning(ending.jobs[id]))) ending
      else {
        val cancelled = withJob(ending, id, endLastRefinerRun(ending.jobs[id], RefinerCancelled))
        if (REFINER == APolisher) handOverPage(cancelled, id) else cancelled
      })
    val movesTheIssue = endsAs == Done and WORKS_ON_PULLS
    {
      ...stopped,
      status: endsAs,
      issueMoves: if (movesTheIssue) stopped.issueMoves + 1 else stopped.issueMoves,
    }
  }

  /// The jobs whose task is unfinished, in the order their tasks started.
  pure def unfinishedJobsInStartOrder(flow: Workflow): List[int] =
    range(0, 2 * MAX_JOBS).foldl(List(), (order, place) =>
      order.concat(unfinishedJobIds(flow).select(id => jobTask(flow, id).startOrder == place)))

  /// The loop of a workflow end reads the unfinished researchers and authors again before each
  /// cancel and cancels the one that started first. A task without a sandbox destroy to wait on
  /// ends at once. The loop waits on the destroy of a harness author's sandbox.
  pure def continueWorkflowEnd(flow: Workflow, endsAs: WorkflowStatus): Workflow = {
    val left = unfinishedJobsInStartOrder(flow)
    val awaited = range(0, MAX_JOBS).select(index =>
      index < left.length() and destroyIsACall(jobTask(flow, left[index])))
    val firstAwaited = if (awaited.length() > 0) awaited.head() else left.length()
    val endedAtOnce = range(0, MAX_JOBS).select(index => index < firstAwaited).foldl(flow, (ending, index) =>
      endReview(finishTask(ending, left[index], TaskCancelled), left[index]))
    if (firstAwaited == left.length()) finishWorkflowEnd(endedAtOnce, endsAs)
    else {
      val id = left[firstAwaited]
      sendCall(
        finishTask(endedAtOnce, id, TaskCancelled),
        SandboxDestroy,
        id,
        TeardownGoesOn({ teardown: AfterCancel, caller: WorkflowEnd(endsAs) }),
      )
    }
  }


  /// The end of a task goes on once its sandbox is gone: the review of its job ends, and a failed
  /// task posts its failure to the person. `complete_job` on the job of the subject issue then
  /// ends the workflow done once a plan set the stages, unless the workflow ended or another end
  /// runs.
  pure def teardownGoesOn(flow: Workflow, id: int, teardown: Teardown, caller: Caller): Workflow = {
    val reviewed = endReview(flow, id)
    val told =
      if (teardown == AfterFail) { ...reviewed, failuresPosted: reviewed.failuresPosted + 1 }
      else reviewed
    match caller {
      | ToolOrEvent => told
      | WorkflowEnd(endsAs) => continueWorkflowEnd(told, endsAs)
      | SubjectJobCompletes =>
        if (hasEnded(told.status) or workflowEnding(told) or told.stagePlan == NoStages) told
        else continueWorkflowEnd(told, Done)
    }
  }

  /// `failTask`, `cancelTask` or `completeJob` ends a task. A harness author's end waits on the
  /// destroy of its sandbox. Any other end goes on at once.
  pure def endTask(flow: Workflow, id: int, status: TaskStatus, teardown: Teardown, caller: Caller): Workflow = {
    val ended = finishTask(flow, id, status)
    if (destroyIsACall(jobTask(flow, id)))
      sendCall(ended, SandboxDestroy, id, TeardownGoesOn({ teardown: teardown, caller: caller }))
    else teardownGoesOn(ended, id, teardown, caller)
  }

  /// True when the first prompt of a new generation of the task takes its oldest queued prompt.
  /// An author resumes with it. A researcher starts over on its research prompt and leaves the
  /// queue as it is.
  pure def wakesWithAQueuedPrompt(task: Task): bool = task.role == Author

  /// The restart reads the task again once its old container went. The restart counted before
  /// the destroy. A finished task stays finished. A paused task waits for its resume to start the
  /// next generation. Otherwise the sandbox comes up and the harness gets its first prompt.
  pure def restartGoesOn(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    if (isFinished(task.status)) flow
    else if (task.paused) withTask(flow, id, { ...task, generationClosed: true })
    else
      withTask(flow, id, {
        ...task,
        status: Busy,
        turnRunning: true,
        promptsSent: task.promptsSent + 1,
        promptsQueued:
          if (wakesWithAQueuedPrompt(task) and task.promptsQueued > 0) task.promptsQueued - 1
          else task.promptsQueued,
      })
  }

  /// True when `complete_job` on the job ends the workflow: the job works on the subject issue at
  /// the last planned stage of a single-issue workflow. A plan with stages plans the one pull
  /// stage.
  pure def completesTheWorkflow(flow: Workflow, id: int): bool =
    flow.jobs[id].input == FromIssue(SUBJECT_ISSUE) and flow.stagePlan != NoStages

  /// `completeJob` ends the author done with the row it read before the check.
  pure def completeAuthor(flow: Workflow, id: int): Workflow = {
    val caller = if (flow.jobs[id].input == FromIssue(SUBJECT_ISSUE)) SubjectJobCompletes else ToolOrEvent
    endTask(flow, id, TaskDone, AfterComplete, caller)
  }

  /// `drainModelAuthor` on a model-call author that is not at work. An unpaused author in review
  /// starts a revise turn on its next prompt. An author without its page waits for its provision
  /// alarm to produce it.
  pure def takeNextModelTurn(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    if (task.paused or task.status != InReview or task.promptsQueued == 0) flow
    else
      sendCall(
        withTask(flow, id, {
          ...task,
          status: Busy,
          promptsSent: task.promptsSent + 1,
          promptsQueued: task.promptsQueued - 1,
        }),
        ModelCall,
        id,
        PageWriteStarts,
      )
  }

  /// True for a model-call author queued to produce its page.
  pure def waitsToProduce(flow: Workflow, id: int): bool = and {
    runsAsModelCalls(jobTask(flow, id)),
    jobTask(flow, id).status == Busy,
    not(jobTask(flow, id).paused),
    flow.jobs[id].artifact == NoArtifact,
    not(modelTurnInFlight(flow, id)),
  }

  /// The provision alarm of each model-call author queued to produce its page sends its model
  /// call, in the order the authors started.
  pure def startQueuedModelAuthors(flow: Workflow): Workflow =
    unfinishedJobsInStartOrder(flow).foldl(flow, (starting, id) =>
      if (waitsToProduce(starting, id)) sendCall(starting, ModelCall, id, PageWriteStarts)
      else starting)

  /// `resumeLostModelTurn`: past its restarts the author fails. Otherwise the restart counts, the
  /// prompt of a lost revise turn waits again, and the author takes its next turn.
  pure def resumeLostModelTurn(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val pageOut = flow.jobs[id].artifact != NoArtifact
    if (task.restarts >= MAX_RESTARTS) endTask(flow, id, TaskFailed, AfterFail, ToolOrEvent)
    else
      takeNextModelTurn(
        withTask(flow, id, {
          ...task,
          restarts: task.restarts + 1,
          status: if (pageOut) InReview else Busy,
          promptsQueued: if (pageOut) task.promptsQueued + 1 else task.promptsQueued,
        }),
        id,
      )
  }

  /// The humans get the page of the job, and the idle clock starts over.
  pure def handOverPage(flow: Workflow, id: int): Workflow =
    { ...withJob(flow, id, { ...flow.jobs[id], artifact: Ready }), idleArmed: true }

  /// The model call returns. A finished author drops the answer. Otherwise the model turn writes
  /// it to the page: a produce turn creates the page, and a revise turn rewrites it.
  pure def modelCallAnswered(flow: Workflow, id: int): Workflow =
    if (isFinished(jobTask(flow, id).status)) flow else sendCall(flow, PageWrite, id, ModelTurnGoesOn)

  /// True when the author of the job does not work and no prompt waits for it: no harness turn
  /// runs, and no model turn is in flight.
  pure def authorQuiet(flow: Workflow, id: int): bool = and {
    not(jobTask(flow, id).turnRunning),
    not(modelTurnInFlight(flow, id)),
    jobTask(flow, id).promptsQueued == 0,
  }

  /// The settle after a turn of a model-call author on a draft: a reviewer starts on it once the
  /// author is quiet and no refiner run is on it.
  pure def reviewModelPage(flow: Workflow, id: int): Workflow =
    if (REFINER == NoRefiner or refinerRunning(flow.jobs[id]) or not(authorQuiet(flow, id))) flow
    else withJob(flow, id, startRefinerRun(flow.jobs[id]))

  /// The page write of a model turn returns, and the turn goes on. An author that finished
  /// meanwhile leaves its job as it was. A produce turn hands the page over. A revise turn makes
  /// the page a draft again until the author takes no further prompt. A stage with a reviewer
  /// keeps the page a draft, and its reviewer starts once the author is quiet.
  pure def modelTurnEnds(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val inReview = withTask(flow, id, { ...task, status: InReview })
    val drafted = withJob(inReview, id, { ...inReview.jobs[id], artifact: Drafted })
    if (isFinished(task.status)) flow
    else if (REFINER != NoRefiner) takeNextModelTurn(reviewModelPage(drafted, id), id)
    else if (flow.jobs[id].artifact == NoArtifact) takeNextModelTurn(handOverPage(inReview, id), id)
    else {
      val drained = takeNextModelTurn(drafted, id)
      if (modelTurnInFlight(drained, id)) drained else handOverPage(drained, id)
    }
  }

  pure def returnCall(flow: Workflow, callId: int): Workflow = {
    val call = flow.calls[callId]
    val returned = withoutCall(flow, callId)
    match call.rest {
      | TeardownGoesOn(teardown) => teardownGoesOn(returned, call.job, teardown.teardown, teardown.caller)
      | RestartGoesOn => restartGoesOn(returned, call.job)
      | RestartAfterWake => returned
      | CompletionGoesOn => returned
      | PageWriteStarts => modelCallAnswered(returned, call.job)
      | ModelTurnGoesOn => modelTurnEnds(returned, call.job)
    }
  }

  /// A restart of the Durable Object drops every call that is out. A task whose restart it
  /// dropped waits queued with its restart counted, so the start step provisions it as the
  /// restart would have. A paused one keeps its generation closed until its resume.
  pure def dropCalls(flow: Workflow): Workflow = {
    val stranded = flow.calls.indices().filter(callId =>
      flow.calls[callId].rest == RestartGoesOn and
      not(isFinished(jobTask(flow, flow.calls[callId].job).status))).map(callId => flow.calls[callId].job)
    val dropped = { ...flow, calls: List() }
    range(0, MAX_JOBS).select(id => stranded.contains(id)).foldl(dropped, (restarting, id) =>
      restartGoesOn(restarting, id))
  }

  /// A restart of the Durable Object drops every call that is out. The start step runs each model
  /// turn it cut again, in the order its authors started, then the provision alarms that queues
  /// fire.
  pure def restartWorkflow(flow: Workflow): Workflow = {
    val cut = modelTurnsInFlight(flow)
    val resumed = unfinishedJobsInStartOrder(flow).select(id => cut.contains(id)).foldl(dropCalls(flow), (resuming, id) =>
      resumeLostModelTurn(resuming, id))
    startQueuedModelAuthors(resumed)
  }

  /// `resumeTask` on a harness task queues the resume prompt and sends the head of the queue.
  /// The prompt waits while the bridge still runs the turn the pause cancelled. Without a bridge
  /// it starts the next generation for it, also while a restart is closing the old container. A
  /// restart that an earlier resume overtook left that resume's generation running, so the
  /// prompt waits for its turn. A researcher's turn runs until it hands over, so its resume
  /// prompt waits.
  pure def resumeHarnessTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val closing = flow.calls.indices().exists(callId =>
      flow.calls[callId].job == id and flow.calls[callId].kind == SandboxDestroy and
        flow.calls[callId].rest == RestartGoesOn)
    val waits = task.turnRunning and not(task.generationClosed) and not(closing)
    val calls = flow.calls.foldl(List(), (calls, call) => calls.append(
      if (call.job == id and call.rest == RestartGoesOn)
        { ...call, rest: RestartAfterWake }
      else call))
    withTask({ ...flow, calls: calls }, id, {
      ...task,
      paused: false,
      turnRunning: true,
      promptsSent: if (waits) task.promptsSent else task.promptsSent + 1,
      promptsQueued: if (waits) task.promptsQueued + 1 else task.promptsQueued,
      generationClosed: false,
      status: if (task.status == InReview) Busy else task.status,
    })
  }

  /// True while a polisher runs on the page of the job's author and holds the author's prompts.
  pure def polisherHoldsPrompts(flow: Workflow, id: int): bool = and {
    REFINER == APolisher,
    jobTask(flow, id).role == Author,
    refinerRunning(flow.jobs[id]),
  }

  /// `promptTask` queues a prompt for the job's task. A paused task keeps it, and so does an
  /// author whose page a polisher holds. An unpaused harness task gets it at once when no turn
  /// runs, in a new generation when its container is closed. A model-call author that is not at
  /// work takes its next turn, or produces its page first.
  pure def promptTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val queued = withTask(flow, id, { ...task, promptsQueued: task.promptsQueued + 1 })
    if (isFinished(task.status)) flow
    else if (task.paused or polisherHoldsPrompts(flow, id)) queued
    else if (runsAsModelCalls(task)) {
      if (modelTurnInFlight(flow, id)) queued else startQueuedModelAuthors(takeNextModelTurn(queued, id))
    }
    else if (task.turnRunning) queued
    else
      withTask(flow, id, {
        ...task,
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
    if (REFINER != APolisher or isFinished(task.status) or task.paused or task.promptsQueued == 0) flow
    else
      withTask(flow, id, {
        ...task,
        status: Busy,
        turnRunning: true,
        promptsSent: task.promptsSent + 1,
        promptsQueued: task.promptsQueued - 1,
        generationClosed: false,
      })
  }

  /// `pauseTask`: an unfinished task that is not paused holds its prompts from now on.
  pure def pauseTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    if (isFinished(task.status) or task.paused) flow else withTask(flow, id, { ...task, paused: true })
  }

  /// `resumeTask`: a paused task goes on with the resume prompt. A model-call author takes it as
  /// any prompt, and an author whose page a polisher holds queues it.
  pure def resumeTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val unpaused = withTask(flow, id, { ...task, paused: false })
    if (isFinished(task.status) or not(task.paused)) flow
    else if (runsAsModelCalls(task) or polisherHoldsPrompts(flow, id)) promptTask(unpaused, id)
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
      | Resume => resumeTask(flow, active[0])
      | Instruct => promptTask(flow, active[0])
    }
  }

  /// The turn that wrote the page ends. A queued prompt goes out at once, and the refiners wait
  /// for the author to be quiet. Without refiners the humans get the page at once. A polisher
  /// closes the author's container as it starts.
  pure def pageWritten(flow: Workflow, id: int): Workflow = {
    val job = flow.jobs[id]
    val author = jobTask(flow, id)
    val queued = author.promptsQueued > 0
    val wrote =
      if (queued)
        withTask(flow, id, {
          ...author,
          promptsSent: author.promptsSent + 1,
          promptsQueued: author.promptsQueued - 1,
        })
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

  /// True when an unfinished job works from the input.
  pure def inputInWork(flow: Workflow, input: Input): bool =
    jobIds(flow).exists(id => flow.jobs[id].input == input and not(isFinished(jobTask(flow, id).status)))

  /// `validateEarlierOutputRemoved` on the finished jobs on the issue, in the order they started.
  /// A pull the host closed unmerged is recorded removed. The first artifact the host still holds
  /// refuses the start, and the removals recorded before it stay.
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
        if (artifact == NoArtifact or artifact == Removed) checked
        else if (artifact != Accepted and checked.flow.jobs[id].pullOnHost == PullClosed)
          { ...checked, flow: advanceArtifact(checked.flow, id, Removed) }
        else { ...checked, clear: false }
      }
    })

  /// The host moves the opener's pull. A merge records the artifact that stands for it accepted.
  /// A close without a merge records it removed and cancels its job. A reopen records nothing,
  /// and neither does an ended workflow.
  pure def pullMoved(flow: Workflow, opener: int, hostMove: HostMove): Workflow = {
    val holder = pullHolder(flow, opener)
    match hostMove {
      | Merged => {
        val merged = withPullOnHost(flow, opener, PullMerged)
        if (hasEnded(flow.status)) merged else advanceArtifact(merged, holder, Accepted)
      }
      | ClosedUnmerged => {
        val closed = withPullOnHost(flow, opener, PullClosed)
        val removed = advanceArtifact(closed, holder, Removed)
        if (hasEnded(flow.status)) closed
        else if (isFinished(jobTask(removed, holder).status)) removed
        else endTask(removed, holder, TaskCancelled, AfterCancel, ToolOrEvent)
      }
      | Reopened => withPullOnHost(flow, opener, PullOpen)
    }
  }

  /// The cancel of the workflow, unless another end runs.
  pure def cancelUnlessEnding(flow: Workflow): Workflow =
    if (workflowEnding(flow)) flow else continueWorkflowEnd(flow, Cancelled)

  /// The jobs on the issue, in the order they started.
  pure def jobsOnIssue(flow: Workflow, issue: int): List[int] =
    range(0, MAX_JOBS).select(id => id < flow.jobs.length() and flow.jobs[id].input == FromIssue(issue))

  /// A person moves the issue to a canceled or completed state, and the tracker shows it ended.
  /// The newest job on the issue owns the cancel. An accepted artifact of the owner keeps the
  /// workflow as it is. The owner on a sub-issue is cancelled alone, unless it is over. Any other
  /// cancel ends the workflow.
  pure def issueEnded(flow: Workflow, issue: int): Workflow = {
    val ended = { ...flow, endedIssues: flow.endedIssues.union(Set(issue)) }
    val owners = jobsOnIssue(flow, issue)
    if (hasEnded(flow.status)) ended
    else if (owners.length() == 0) cancelUnlessEnding(ended)
    else {
      val owner = owners[owners.length() - 1]
      if (flow.jobs[owner].artifact == Accepted) ended
      else if (issue == SUBJECT_ISSUE) cancelUnlessEnding(ended)
      else if (isFinished(jobTask(flow, owner).status)) ended
      else endTask(ended, owner, TaskCancelled, AfterCancel, ToolOrEvent)
    }
  }

  /// `runningAuthorInSession` on the session of the subject issue: the unfinished author of a job
  /// on the subject issue, else the author of the last one, while it runs. A person's text there
  /// goes to it as a prompt.
  pure def runningSessionAuthor(flow: Workflow): List[int] = {
    val onSubject = jobsOnIssue(flow, SUBJECT_ISSUE)
    val unfinished = onSubject.select(id => not(isFinished(jobTask(flow, id).status)))
    val author =
      if (unfinished.length() > 0) List(unfinished[0])
      else if (onSubject.length() > 0) List(onSubject[onSubject.length() - 1])
      else List()
    author.select(id => jobTask(flow, id).status == Busy)
  }

  action move(after: Workflow, kind: StepKind): bool = {
    val step = { before: workflow, after: after, kind: kind }
    all {
      workflow' = after,
      lastStepKept' = rulesKeptBy(step),
      lastStepReached' = witnessesReachedBy(step),
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
    val step = { before: INITIAL_WORKFLOW, after: INITIAL_WORKFLOW, kind: OtherStep }
    all {
      workflow' = INITIAL_WORKFLOW,
      lastStepKept' = rulesKeptBy(step),
      lastStepReached' = witnessesReachedBy(step),
    }
  }

  /// The agent calls `set_plan` with a workflow definition while the workflow has not ended. The
  /// call that starts the workflow may leave out the stages. A plan with stages sets the number of
  /// job slots, also below the jobs that run. A plan is refused while the workflow ends, when it
  /// names a workflow definition the deployment does not hold or another one than the workflow
  /// started from, and when it leaves out the stages on a started workflow. The plan that starts a
  /// workflow from a tracker issue moves that issue to started.
  action agentSetsPlan: bool = all {
    not(hasEnded(workflow.status)),
    nondet definition = NAMED_DEFINITIONS.oneOf()
    nondet withStages = Set(true, false).oneOf()
    nondet jobSlots = SLOT_COUNTS.oneOf()
    val undeclared = not(DEFINITIONS.contains(definition))
    val otherDefinition = workflow.definition != Unplanned and workflow.definition != Planned(definition)
    val stagesLeftOut = not(withStages) and workflow.definition != Unplanned
    val refused = workflowEnding(workflow) or undeclared or otherDefinition or stagesLeftOut
    val movesTheIssue = workflow.definition == Unplanned and WORKS_ON_PULLS
    val planned = {
      ...workflow,
      definition: Planned(definition),
      status: Running,
      stagePlan: if (withStages) StagesPlanned(jobSlots) else workflow.stagePlan,
      issueMoves: if (movesTheIssue) workflow.issueMoves + 1 else workflow.issueMoves,
    }
    move(if (refused) workflow else planned, PlanStep(definition))
  }

  /// The agent calls `start_job` for the page stage in a turn a request woke. It may be refused.
  action agentStartsJob: bool = all {
    WORK == PagesForAChatRequest,
    workflow.jobs.length() < MAX_JOBS,
    nondet request = REQUESTS.oneOf()
    val input = inputFor(workflow, request)
    move(if (canStartJob(workflow, input)) startedJob(workflow, input) else workflow, OtherStep),
  }

  /// True while a job can start: a plan started the workflow, it has not ended, no end runs, and
  /// a slot is free.
  pure def startAllowed(flow: Workflow): bool = and {
    flow.definition != Unplanned,
    not(hasEnded(flow.status)),
    not(workflowEnding(flow)),
    hasAFreeJobSlot(flow),
  }

  /// The agent calls `start_job` for the pull stage on the subject issue or its sub-issue, also
  /// one an earlier job took. The tracker refuses an issue a person ended. An earlier artifact the
  /// host still holds refuses it, and so does an unfinished job on the issue. The start claims the
  /// issue, which moves it to started.
  action agentStartsJobOnAnIssue: bool = all {
    WORKS_ON_PULLS,
    workflow.jobs.length() < MAX_JOBS,
    nondet issue = ISSUES.oneOf()
    val input = FromIssue(issue)
    val earlier = recordEarlierPullsRemoved(workflow, issue)
    val started = startedJob(earlier.flow, input)
    move(
      if (not(startAllowed(workflow)) or workflow.endedIssues.contains(issue)) workflow
      else if (not(earlier.clear) or inputInWork(workflow, input)) earlier.flow
      else { ...started, issueMoves: started.issueMoves + 1 },
      OtherStep,
    ),
  }

  /// The agent calls `start_job` for the pull stage on the pull an earlier job opened, to continue
  /// it on its branch. An unfinished job on the pull refuses it, and so does a pull that is not
  /// open on the host.
  action agentContinuesAPull: bool = onJobWhere(
    id => WORKS_ON_PULLS and workflow.jobs[id].pullOnHost != NoPull,
    id => all {
      workflow.jobs.length() < MAX_JOBS,
      val refused = or {
        not(startAllowed(workflow)),
        pullChain(workflow, id).select(other => not(isFinished(jobTask(workflow, other).status))).length() > 0,
        workflow.jobs[id].pullOnHost != PullOpen,
      }
      move(if (refused) workflow else startedJob(workflow, FromArtifactOf(id)), OtherStep),
    },
  )

  /// The researcher's turn ends with its research payload written.
  action researcherHandsOver: bool = onJobWhere(
    id => taskWorks(workflow, id) and jobTask(workflow, id).role == Researcher,
    id => move(researchHandedOver(workflow, id), OtherStep),
  )

  /// The harness author writes its page, or pushes to its pull, and its turn ends. An author that
  /// does not continue a pull opens one on the host.
  action authorWritesItsPage: bool = onJobWhere(
    id => and {
      taskWorks(workflow, id),
      jobTask(workflow, id).role == Author,
      workflow.jobs[id].artifact == NoArtifact,
    },
    id => {
      val written = pageWritten(workflow, id)
      val opensAPull = WORKS_ON_PULLS and not(continuesAPull(workflow.jobs[id]))
      move(if (opensAPull) withPullOnHost(written, id, PullOpen) else written, OtherStep)
    },
  )

  /// The reviewer of the page approves it, and its turn ends.
  action refinerRunEnds: bool = onJobWhere(
    id => refinerRunning(workflow.jobs[id]),
    id => move(refinerRunFinished(workflow, id), OtherStep),
  )

  /// The sandbox of the refiner run dies.
  action refinerRunFails: bool = onJobWhere(
    id => refinerRunning(workflow.jobs[id]),
    id => move(refinerRunFailed(workflow, id), OtherStep),
  )

  /// The agent calls `pause_task` on the job's task. A researcher is refused, and a finished or
  /// paused author is left alone.
  action agentPausesAuthor: bool = onJob(id => move(
    if (jobTask(workflow, id).role == Author) pauseTask(workflow, id) else workflow,
    OtherStep,
  ))

  /// The agent calls `resume_task` on the job's task. A researcher is refused. A paused author
  /// gets a prompt to go on.
  action agentResumesAuthor: bool = onJob(id => move(
    if (jobTask(workflow, id).role == Author) resumeTask(workflow, id) else workflow,
    OtherStep,
  ))

  /// The agent calls `prompt_task` on the job's task. A researcher and a finished author are
  /// refused.
  action agentPromptsAuthor: bool = onJob(id => move(
    if (jobTask(workflow, id).role == Author) promptTask(workflow, id) else workflow,
    PromptStep,
  ))

  /// The no progress alarm finds the harness turn of the job's task stalled after a nudge. The
  /// task restarts in a fresh sandbox once its container is destroyed, or fails once its restarts
  /// are used up.
  action taskStalls: bool = onJobWhere(id => taskStuck(workflow, id), id => {
    val task = jobTask(workflow, id)
    val queued = withTask(workflow, id, { ...task, promptsQueued: task.promptsQueued + 1 })
    move(
      if (task.restarts >= MAX_RESTARTS) endTask(workflow, id, TaskFailed, AfterFail, ToolOrEvent)
      else {
        val counted = withTask(queued, id, { ...jobTask(queued, id), restarts: task.restarts + 1 })
        if (destroyIsACall(task)) sendCall(counted, SandboxDestroy, id, RestartGoesOn)
        else restartGoesOn(counted, id)
      },
      OtherStep,
    )
  })

  /// The agent calls `cancel_job`. A finished job is left alone.
  action agentCancelsJob: bool = onJob(id => move(
    if (isFinished(jobTask(workflow, id).status)) workflow
    else endTask(workflow, id, TaskCancelled, AfterCancel, ToolOrEvent),
    OtherStep,
  ))

  /// The kind of a step that may complete the job: `SubjectCompletionStep` when it completes the
  /// job of the subject issue.
  pure def completionStepKind(flow: Workflow, id: int, completes: bool): StepKind =
    if (completes and completesTheWorkflow(flow, id)) SubjectCompletionStep else OtherStep

  /// The agent calls `complete_job` in a turn where the person accepted the artifact. It is
  /// refused while the researcher runs. A job without an artifact, or with one the host accepted,
  /// completes at once. Otherwise the acceptance is checked first.
  action agentCompletesJob: bool = onJob(id => {
    val artifact = workflow.jobs[id].artifact
    val refused = isFinished(jobTask(workflow, id).status) or jobTask(workflow, id).role == Researcher
    val atOnce = not(refused) and (artifact == NoArtifact or artifact == Accepted)
    move(
      if (refused) workflow
      else if (atOnce) completeAuthor(workflow, id)
      else sendCall(workflow, AcceptanceCheck, id, CompletionGoesOn),
      completionStepKind(workflow, id, atOnce),
    )
  })

  /// The acceptance check returns. For a page, the decisions model reads an acceptance in the
  /// person's message or does not. For a pull, the host says whether it merged the pull, which
  /// it may have done without an event the workflow heard. A merged pull records the artifact
  /// accepted. `complete_job` reads the author again after the check, so an author that finished
  /// meanwhile keeps its status.
  action acceptanceCheckReturns: bool = all {
    outCalls(workflow, AcceptanceCheck).size() > 0,
    nondet callId = outCalls(workflow, AcceptanceCheck).oneOf()
    nondet accepted = Set(true, false).oneOf()
    val returned = withoutCall(workflow, callId)
    val id = workflow.calls[callId].job
    val opener = pullOpenerOf(workflow, id)
    val host = workflow.jobs[opener].pullOnHost
    val merged = host == PullMerged or (host == PullOpen and accepted)
    val checked =
      if (WORK == PagesForAChatRequest or not(merged)) returned
      else advanceArtifact(withPullOnHost(returned, opener, PullMerged), id, Accepted)
    val passes = if (WORK == PagesForAChatRequest) accepted else merged
    val completes = passes and not(isFinished(jobTask(workflow, id).status))
    move(if (completes) completeAuthor(checked, id) else checked, completionStepKind(workflow, id, completes)),
  }

  /// True when the call goes on toward the end of the workflow that `complete_job` on the job of
  /// the subject issue starts.
  pure def completesTheSubjectsJob(call: Call): bool = match call.rest {
    | TeardownGoesOn(teardown) => teardown.caller == SubjectJobCompletes or teardown.caller == WorkflowEnd(Done)
    | _ => false
  }

  /// The sandbox provider returns from the destroy of an author's sandbox.
  action sandboxDestroyReturns: bool = all {
    outCalls(workflow, SandboxDestroy).size() > 0,
    nondet callId = outCalls(workflow, SandboxDestroy).oneOf()
    val completing = completesTheSubjectsJob(workflow.calls[callId]) and workflow.stagePlan != NoStages
    val stepKind = if (completing) SubjectCompletionStep else OtherStep
    move(returnCall(workflow, callId), stepKind),
  }

  /// The page model answers the model call of a model-call author.
  action modelCallReturns: bool = all {
    outCalls(workflow, ModelCall).size() > 0,
    nondet callId = outCalls(workflow, ModelCall).oneOf()
    move(returnCall(workflow, callId), OtherStep),
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
      isModelTurnCall(workflow.calls[callId].kind),
      not(isFinished(jobTask(workflow, workflow.calls[callId].job).status)),
    })
    all {
      inFlight.size() > 0,
      nondet callId = inFlight.oneOf()
      val id = workflow.calls[callId].job
      move(
        startQueuedModelAuthors(resumeLostModelTurn(withoutCall(workflow, callId), id)),
        DeadlineStep(id),
      ),
    }
  }

  /// A person writes a message in the chat thread. It wakes a sleeping workflow.
  action personWrites: bool =
    move(if (hasEnded(workflow.status)) workflow else messageWakes(workflow), EventStep)

  /// A person's message in the session of the subject issue goes to its author as a prompt while
  /// the author runs. Only a workflow from a tracker issue has that session.
  pure def forwardedToTheSessionAuthor(flow: Workflow): List[int] =
    if (WORKS_ON_PULLS) runningSessionAuthor(flow) else List()

  /// A person sends a verbal command where the request came from: pause, resume, or instruct with
  /// its text. The message wakes a sleeping workflow. In the session of the subject issue it goes
  /// to the author that runs there as a prompt. Otherwise the command acts on the task of the one
  /// active job, a researcher too.
  action personSendsAVerbalCommand: bool = {
    nondet command = Set(Pause, Resume, Instruct).oneOf()
    val woke = messageWakes(workflow)
    val forwarded = forwardedToTheSessionAuthor(woke)
    move(
      if (hasEnded(workflow.status)) workflow
      else if (forwarded.length() > 0) promptTask(woke, forwarded[0])
      else verbalCommandActs(woke, command),
      VerbalCommandStep(command),
    )
  }

  /// A person writes the cancel word in the session of the subject issue. The message wakes a
  /// sleeping workflow and goes to the author that runs there as a prompt. Otherwise it cancels
  /// the workflow, unless another end runs.
  pure def cancelWordInTheSession(flow: Workflow): Workflow = {
    val woke = messageWakes(flow)
    val forwarded = forwardedToTheSessionAuthor(woke)
    if (forwarded.length() > 0) promptTask(woke, forwarded[0]) else cancelUnlessEnding(woke)
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
          if (hasEnded(workflow.status)) workflow
          else if (WORKS_ON_PULLS) cancelWordInTheSession(workflow)
          else cancelUnlessEnding(workflow),
          EventStep,
        )
      | AgentFails => all {
        not(hasEnded(workflow.status)),
        move(if (refused) workflow else continueWorkflowEnd(workflow, Failed), OtherStep),
      }
      | AgentFinishes => all {
        not(hasEnded(workflow.status)),
        move(
          if (refused or unfinishedJobIds(workflow).length() > 0) workflow
          else finishWorkflowEnd(workflow, Done),
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
      val host = workflow.jobs[id].pullOnHost
      all {
        if (hostMove == Reopened) host == PullClosed else host == PullOpen,
        move(pullMoved(workflow, id, hostMove), EventStep),
      }
    },
  )

  /// A person moves the subject issue, or an issue a job took, to a canceled or completed state.
  /// The tracker tells the workflow, also once it ended. The spec has it once a job started.
  action aPersonEndsAnIssue: bool = all {
    A_PERSON_ENDS_ISSUES,
    workflow.jobs.length() > 0,
    nondet issue = Set(SUBJECT_ISSUE).union(ISSUES.filter(taken => jobsOnIssue(workflow, taken).length() > 0)).oneOf()
    move(issueEnded(workflow, issue), IssueEndStep(issue)),
  }

  /// The idle alarm fires. A running workflow whose tasks are not busy goes to sleep.
  action idleAlarmFires: bool = all {
    workflow.idleArmed,
    val disarmed = { ...workflow, idleArmed: false }
    if (sleeps(workflow)) move({ ...disarmed, status: WaitingInput }, SleepStep)
    else move(disarmed, OtherStep),
  }

  /// An alarm of a sandbox generation before the current one fires. The timer and the sandbox it
  /// is about change nothing here. Only the replay reads them.
  action staleAlarmFires: bool = all {
    workflow.jobs.length() > 0,
    nondet timer = GENERATION_TIMERS.oneOf()
    nondet sandbox = STALE_SANDBOXES.oneOf()
    move(workflow, StaleAlarmStep),
  }

  /// The Durable Object restarts while a call is out. Every call that is out is lost with its
  /// isolate. A page write that is out may have landed on the host first. That changes nothing
  /// here, since the store does not hear of it. Only the replay reads it.
  action workflowRestarts: bool = all {
    workflow.calls.length() > 0,
    nondet landed = Set(true, false).oneOf()
    move(restartWorkflow(workflow), RestartStep),
  }

  action step: bool = any {
    agentSetsPlan,
    aJobStarts,
    aTaskEndsItsTurn,
    aRefinerRunEnds,
    theAgentSteersAnAuthor,
    taskStalls,
    theAgentEndsAJob,
    acceptanceCheckReturns,
    sandboxDestroyReturns,
    aModelTurnEnds,
    workflowEnds,
    anOutsideEventLands,
    workflowRestarts,
  }

  /// The agent starts a job on a request, on an issue, or on a pull to continue.
  action aJobStarts: bool = any { agentStartsJob, agentStartsJobOnAnIssue, agentContinuesAPull }

  /// The researcher hands over to the author, or the harness author writes its page.
  action aTaskEndsItsTurn: bool = any { researcherHandsOver, authorWritesItsPage }

  /// The refiner run of a job approves or fails.
  action aRefinerRunEnds: bool = any { refinerRunEnds, refinerRunFails }

  /// The agent pauses, resumes or prompts a task.
  action theAgentSteersAnAuthor: bool = any { agentPausesAuthor, agentResumesAuthor, agentPromptsAuthor }

  /// The agent cancels or completes a job.
  action theAgentEndsAJob: bool = any { agentCancelsJob, agentCompletesJob }

  /// The page model answers a model call, the host returns from a page write, or the deadline of
  /// its model turn passes first.
  action aModelTurnEnds: bool = any { modelCallReturns, pageWriteReturns, modelTurnOutlivesItsDeadline }

  /// A message, an alarm, or a move on the host or the tracker reaches the workflow.
  action anOutsideEventLands: bool = any {
    personWrites,
    personSendsAVerbalCommand,
    idleAlarmFires,
    staleAlarmFires,
    theHostMovesAPull,
    aPersonEndsAnIssue,
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

  /// True for an event from outside: a person's message, a verbal command, the cancel, or a move
  /// on the host or the tracker.
  pure def isEventStep(kind: StepKind): bool = match kind {
    | EventStep => true
    | VerbalCommandStep(_) => true
    | IssueEndStep(_) => true
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
      DEFINITIONS.exists(definition =>
        step.after.definition == Planned(definition) and step.kind == PlanStep(definition))

  /// A plan that names a workflow definition the deployment does not hold changes nothing.
  pure def ignoresAnUndeclaredPlan(step: Transition): bool = match step.kind {
    | PlanStep(definition) => not(DEFINITIONS.contains(definition)) implies step.after == step.before
    | _ => true
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

  /// On a finished workflow, no event changes the status, the tasks, or the prompts.
  pure def leavesAFinishedWorkflow(step: Transition): bool =
    (isEventStep(step.kind) and hasEnded(step.before.status)) implies and {
      step.after.status == step.before.status,
      step.after.jobs.length() == step.before.jobs.length(),
      promptsSentToTasks(step.after) == promptsSentToTasks(step.before),
    }

  /// An alarm of an older sandbox generation changes nothing.
  pure def ignoresAStaleAlarm(step: Transition): bool =
    step.kind == StaleAlarmStep implies step.after == step.before

  /// The sleep message posts only while the workflow runs from a plan.
  pure def sleepsOnlyDuringAWorkflow(step: Transition): bool =
    step.kind == SleepStep implies (step.before.definition != Unplanned and step.before.status == Running)

  /// A workflow that is done, failed or cancelled keeps that status.
  pure def keepsAFinishedStatus(step: Transition): bool =
    hasEnded(step.before.status) implies step.after.status == step.before.status

  /// A paused author or researcher does not get a prompt.
  pure def sendsAPausedTaskNoPrompt(step: Transition): bool =
    step.before.jobs.indices().forall(id =>
      step.before.jobs[id].tasks.indices().forall(index => {
        val was = step.before.jobs[id].tasks[index]
        val now = step.after.jobs[id].tasks[index]
        (was.paused and now.paused) implies now.promptsSent == was.promptsSent
      }))

  /// The workflow moves to waiting for input only in a step that leaves no researcher or author busy.
  pure def waitsOnlyWhileNoAuthorWorks(step: Transition): bool =
    (step.after.status == WaitingInput and step.before.status != WaitingInput) implies
      busyJobs(step.after).size() == 0

  /// The jobs whose model turn the step cut: every model turn in flight at a restart of the
  /// Durable Object, or the one whose deadline passed.
  pure def modelTurnsCutIn(step: Transition): Set[int] = match step.kind {
    | RestartStep => modelTurnsInFlight(step.before)
    | DeadlineStep(id) => Set(id)
    | _ => Set()
  }

  /// A restart or the deadline does not lose a model turn. The author whose turn was cut asks the
  /// page model again, is back in review with the prompt of its turn taken, waits paused, or
  /// failed with a post to the person. The start of a turn folds into the step, so an author that
  /// is starting has its model call out. The prompt of a revise turn counts as sent while its turn
  /// is in flight, so it is taken unless it waits again after the cut.
  pure def resumesEveryCutModelTurn(step: Transition): bool =
    modelTurnsCutIn(step).forall(id => {
      val before = jobTask(step.before, id)
      val after = jobTask(step.after, id)
      val revised = step.before.jobs[id].artifact != NoArtifact
      or {
        modelTurnInFlight(step.after, id),
        after.status == InReview and not(revised and after.promptsQueued > before.promptsQueued),
        after.paused,
        after.status == TaskFailed and step.after.failuresPosted > step.before.failuresPosted,
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
  /// it ended or another end ran.
  pure def isDoneWithTheSubjectsJob(step: Transition): bool = {
    val becameDone = step.before.status != Done and step.after.status == Done
    val anotherEndRan =
      callOutFor(step.before, WorkflowEnd(Cancelled)) or callOutFor(step.before, WorkflowEnd(Failed))
    val stillGoesOn =
      callOutFor(step.after, SubjectJobCompletes) or callOutFor(step.after, WorkflowEnd(Done))
    val completesInThisStep = and {
      step.kind == SubjectCompletionStep,
      not(hasEnded(step.before.status)),
      not(anotherEndRan),
      not(stillGoesOn),
    }
    and {
      becameDone implies (step.kind == FinishStep or step.kind == SubjectCompletionStep),
      completesInThisStep implies step.after.status == Done,
    }
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
        | PlanStep(definition) => not(DEFINITIONS.contains(definition))
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
        jobTask(step.after, id).promptsQueued > jobTask(step.before, id).promptsQueued,
      }),
      aPromptWaitsForATurn: isPromptStep(step.kind) and jobIds(step.before).exists(id => and {
        not(jobTask(step.after, id).paused),
        jobTask(step.after, id).promptsQueued > jobTask(step.before, id).promptsQueued,
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
        jobTask(step.after, id).promptsSent + jobTask(step.after, id).promptsQueued >
          jobTask(step.before, id).promptsSent + jobTask(step.before, id).promptsQueued,
      }),
    }
  }

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

  /// Only one live job works from each input. An unfinished job holds its input. A finished job
  /// holds it while its output exists.
  val oneLiveJobPerInputArtifact: bool =
    jobIds(workflow).forall(id => jobIds(workflow).forall(other => and {
      id != other,
      workflow.jobs[id].input == workflow.jobs[other].input,
      holdsItsInput(workflow.jobs[id]),
    } implies not(holdsItsInput(workflow.jobs[other]))))

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

  /// On a finished workflow, no event changes the status, the tasks, or the prompts.
  val nothingReopensAFinishedWorkflow: bool = lastStepKept.nothingReopensAFinishedWorkflow

  /// An alarm of an older sandbox generation changes nothing and does not tell the agent. The spec
  /// does not model agent notes, so the replay checks that a stale alarm leaves them empty.
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
  /// model call out.
  val aQueuedPromptReachesItsModelCallAuthor: bool =
    jobIds(workflow).forall(id => {
      val task = jobTask(workflow, id)
      val waiting = and {
        runsAsModelCalls(task),
        not(isFinished(task.status)),
        not(task.paused),
        task.promptsQueued > 0,
      }
      waiting implies modelTurnInFlight(workflow, id)
    })

  /// A model-call author is working only while its model call or its page write is out. `Busy`
  /// covers starting, which folds into the step that sends the model call. A paused task does not
  /// work, as `taskWorks` reads it, so a paused author whose produce turn was lost waits busy until
  /// its resume.
  val aModelCallAuthorWorksOnlyWhileItsCallIsOut: bool =
    jobIds(workflow).forall(id => {
      val task = jobTask(workflow, id)
      (runsAsModelCalls(task) and task.status == Busy and not(task.paused)) implies modelTurnInFlight(workflow, id)
    })

  /// The prompts the workflow sent its tasks, a counter that model checking bounds.
  val promptsSent: int = promptsSentToTasks(workflow)

  /// The prompts that wait for a turn, a counter that model checking bounds. Each resume of an
  /// author at work queues one more.
  val promptsWaiting: int =
    jobIds(workflow).fold(0, (total, id) => total + jobTask(workflow, id).promptsQueued)

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

  /// Witness for `nothingReopensAFinishedWorkflow`: an event lands on a finished workflow.
  val anEventLandsOnAFinishedWorkflow: bool = lastStepReached.anEventLandsOnAFinishedWorkflow

  /// Witness for `staleAlarmIsIgnored`: a stale alarm fires.
  val aStaleAlarmFires: bool = lastStepReached.aStaleAlarmFires

  /// Witness for `sleepMessageOnlyDuringAWorkflow`: the sleep message posts.
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

  /// The workflow ends while its loop waits on the destroy of an author's sandbox.
  val theWorkflowIsEnding: bool = workflowEnding(workflow)

  /// A prompt waits for the turn of a task to end.
  val aPromptWaits: bool = jobIds(workflow).exists(id => jobTask(workflow, id).promptsQueued > 0)

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
    jobTask(workflow, id).promptsQueued > 0,
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
    jobTask(workflow, id).promptsQueued > 0,
  })

  /// Witness for `aModelCallAuthorWorksOnlyWhileItsCallIsOut`: a paused model-call author waits
  /// busy without a model turn in flight.
  val aPausedModelCallAuthorWaitsBusy: bool = jobIds(workflow).exists(id => and {
    runsAsModelCalls(jobTask(workflow, id)),
    jobTask(workflow, id).status == Busy,
    jobTask(workflow, id).paused,
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

  /// The humans have a page.
  val theHumansHaveAPage: bool = jobIds(workflow).exists(id => workflow.jobs[id].artifact == Ready)

  /// The workflow finished done.
  val theWorkflowIsDone: bool = workflow.status == Done

  /// The workflow failed.
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
}
