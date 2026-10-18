/// The lifecycle of one workflow and its jobs, from the request to the end of the workflow.
/// Each action is one step of the orchestrator that runs to its end before the next event lands.
/// Three calls split a step: the destroy of a harness author's sandbox, the acceptance check of
/// `complete_job`, and the model call of a model-call author. One action sends the call and a
/// later action returns it. A restart of the Durable Object drops every call that is out, with the
/// rest of its step. The world answers every other await at once, so the model folds those into
/// the step. The start of a task folds into the step that queues it: a harness gets its first
/// prompt, and a model-call author sends its model call. A refiner run is modelled only as running
/// or finished.
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
  /// `promptsQueued` counts the prompts that wait for a turn. `generationClosed` holds while a
  /// restart closed the container of a paused task's generation, and the task waits for its
  /// resume to start the next one.
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

  type ArtifactStatus = NoArtifact | Drafted | Ready

  type RefinerRunStatus = NoRefinerRun | RefinerRunning | RefinerRunFinished

  /// What a job works from: the text of a request, or the artifact of an earlier job.
  type Input = FromRequest(int) | FromArtifactOf(int)

  /// A job with its tasks in the order they started. The last one is the job's task now.
  type Job = { input: Input, tasks: List[Task], artifact: ArtifactStatus, refinerRun: RefinerRunStatus }

  type CallKind = SandboxDestroy | AcceptanceCheck | ModelCall

  /// The end of a task that went on after its teardown.
  type Teardown = AfterCancel | AfterFail | AfterComplete

  /// Who ended the task: a tool call or an event, or the end of the workflow with the status it
  /// ends as.
  type Caller = ToolOrEvent | WorkflowEnd(WorkflowStatus)

  /// The rest of the step that runs when the call returns. `RestartAfterWake` is a restart whose
  /// author a resume woke in a new generation while its old container went. It stops there.
  /// `ModelTurnGoesOn` is the model turn that applies the answer of its model call.
  type Rest =
    | TeardownGoesOn({ teardown: Teardown, caller: Caller })
    | RestartGoesOn
    | RestartAfterWake
    | CompletionGoesOn
    | ModelTurnGoesOn

  /// A call that is out. It leaves the list when it returns, or when a restart of the Durable
  /// Object drops it.
  type Call = { kind: CallKind, job: int, rest: Rest }

  /// The stages a plan set, with the number of job slots it gave the workflow. A plan without
  /// stages only starts the workflow.
  type StagePlan = NoStages | StagesPlanned(int)

  /// `failuresPosted` counts the posts that tell the person a researcher or author failed.
  type Workflow = {
    status: WorkflowStatus,
    definition: PlanDefinition,
    stagePlan: StagePlan,
    idleArmed: bool,
    jobs: List[Job],
    calls: List[Call],
    failuresPosted: int,
  }

  /// A verbal command that acts on a job. The cancel ends the workflow, so it is an `Ending`.
  type VerbalCommand = Pause | Resume | Instruct

  /// What an observer knows about the last step besides the states around it. `DeadlineStep` is
  /// the deadline alarm of the model turn of a job. `PromptStep` is the agent's prompt to a task.
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
    aCallWasDropped: bool,
    aRestartCutsAModelTurn: bool,
    aModelTurnOutlivesItsDeadline: bool,
    aReviseTurnIsCut: bool,
    aPausedAuthorLosesAModelTurn: bool,
    anAuthorFailsOnALostModelTurn: bool,
  }

  type Ending = PersonCancels | AgentFails | AgentFinishes
}

/// The lifecycle of a workflow whose jobs each write a page with an author, after a researcher
/// when the stage runs one.
module workflowLifecycle {
  import workflowLifecycleTypes.*

  /// True when the stage runs a reviewer on the page of each job.
  const REFINER: bool

  /// True when the author of each job runs as model calls, without a sandbox. Such a stage runs
  /// no refiners, so the humans get the page as its author leaves it.
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
  }

  var workflow: Workflow
  var lastStepKept: KeptRules
  var lastStepReached: ReachedWitnesses

  pure def isFinished(status: TaskStatus): bool =
    status == TaskDone or status == TaskCancelled or status == TaskFailed

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

  /// True while the model turn of the job's unfinished model-call author is in flight.
  pure def modelTurnInFlight(flow: Workflow, id: int): bool = and {
    not(isFinished(jobTask(flow, id).status)),
    flow.calls.indices().exists(callId =>
      flow.calls[callId].kind == ModelCall and flow.calls[callId].job == id),
  }

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
    if (runsAsModelCalls(jobTask(flow, id))) sendCall(flow, ModelCall, id, ModelTurnGoesOn) else flow

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

  /// A job holds its input while its task is unfinished, and after that while its output exists.
  pure def holdsItsInput(job: Job): bool =
    not(isFinished(job.tasks[job.tasks.length() - 1].status)) or job.artifact != NoArtifact

  pure def inputHeld(flow: Workflow, input: Input): bool =
    jobIds(flow).exists(id => flow.jobs[id].input == input and holdsItsInput(flow.jobs[id]))

  /// True while the loop of a workflow end waits on the destroy of an author's sandbox. Only this
  /// instance knows it, so a restart of the Durable Object forgets it with the calls it drops.
  pure def workflowEnding(flow: Workflow): bool =
    flow.calls.indices().exists(callId => match flow.calls[callId].rest {
      | TeardownGoesOn(teardown) => match teardown.caller {
        | WorkflowEnd(_) => true
        | ToolOrEvent => false
      }
      | _ => false
    })

  /// True when the plan set the stages and a job slot is free. A refiner run takes no slot.
  pure def hasAFreeJobSlot(flow: Workflow): bool = match flow.stagePlan {
    | NoStages => false
    | StagesPlanned(jobSlots) => unfinishedJobIds(flow).length() < jobSlots
  }

  pure def canStartJob(flow: Workflow, input: Input): bool = and {
    not(hasEnded(flow.status)),
    not(workflowEnding(flow)),
    hasAFreeJobSlot(flow),
    not(inputHeld(flow, input)),
  }

  /// `startJob`: the job starts with its researcher when the stage runs one, else with its author.
  pure def startedJob(flow: Workflow, input: Input): Workflow = {
    val task = newTask(flow, if (RESEARCH) Researcher else Author)
    val job = { input: input, tasks: List(task), artifact: NoArtifact, refinerRun: NoRefinerRun }
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
      ...job,
      refinerRun: if (job.refinerRun == RefinerRunning) RefinerRunFinished else job.refinerRun,
      artifact: if (handedOver) Ready else job.artifact,
    }
    { ...withJob(flow, id, ended), idleArmed: flow.idleArmed or handedOver }
  }

  /// The loop of a workflow end cancels the unfinished refiner runs and sets the status last.
  pure def finishWorkflowEnd(flow: Workflow, endsAs: WorkflowStatus): Workflow = {
    val stopped = flow.jobs.foldl(List(), (jobs, job) => jobs.append({
      ...job,
      refinerRun: if (job.refinerRun == RefinerRunning) RefinerRunFinished else job.refinerRun,
    }))
    { ...flow, jobs: stopped, status: endsAs }
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
  /// task posts its failure to the person.
  pure def teardownGoesOn(flow: Workflow, id: int, teardown: Teardown, caller: Caller): Workflow = {
    val reviewed = endReview(flow, id)
    val told =
      if (teardown == AfterFail) { ...reviewed, failuresPosted: reviewed.failuresPosted + 1 }
      else reviewed
    match caller {
      | ToolOrEvent => told
      | WorkflowEnd(endsAs) => continueWorkflowEnd(told, endsAs)
    }
  }

  /// `failTask`, `cancelTask` or `completeJob` ends a task. A harness author's end waits on the
  /// destroy of its sandbox. Any other end goes on at once.
  pure def endTask(flow: Workflow, id: int, status: TaskStatus, teardown: Teardown): Workflow = {
    val ended = finishTask(flow, id, status)
    if (destroyIsACall(jobTask(flow, id)))
      sendCall(ended, SandboxDestroy, id, TeardownGoesOn({ teardown: teardown, caller: ToolOrEvent }))
    else teardownGoesOn(ended, id, teardown, ToolOrEvent)
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

  /// `completeJob` ends the author done with the row it read before the check.
  pure def completeAuthor(flow: Workflow, id: int): Workflow =
    endTask(flow, id, TaskDone, AfterComplete)

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
        ModelTurnGoesOn,
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

  /// The provision alarm of each model-call author queued to produce its page sends its model call.
  pure def startQueuedModelAuthors(flow: Workflow): Workflow =
    range(0, MAX_JOBS).select(id => id < flow.jobs.length()).foldl(flow, (starting, id) =>
      if (waitsToProduce(starting, id)) sendCall(starting, ModelCall, id, ModelTurnGoesOn)
      else starting)

  /// `resumeLostModelTurn`: past its restarts the author fails. Otherwise the restart counts, the
  /// prompt of a lost revise turn waits again, and the author takes its next turn.
  pure def resumeLostModelTurn(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val pageOut = flow.jobs[id].artifact != NoArtifact
    if (task.restarts >= MAX_RESTARTS) endTask(flow, id, TaskFailed, AfterFail)
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

  /// The model call returns and its model turn applies the answer. A finished author drops it. A
  /// produce turn creates the page and hands it to the humans. A revise turn rewrites the page,
  /// which is a draft again until the author takes no further prompt.
  pure def modelTurnEnds(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val inReview = withTask(flow, id, { ...task, status: InReview })
    if (isFinished(task.status)) flow
    else if (flow.jobs[id].artifact == NoArtifact) takeNextModelTurn(handOverPage(inReview, id), id)
    else {
      val drained = takeNextModelTurn(withJob(inReview, id, { ...inReview.jobs[id], artifact: Drafted }), id)
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
  /// turn it cut again, in the order of the jobs, then the provision alarms that queues fire.
  pure def restartWorkflow(flow: Workflow): Workflow = {
    val cut = modelTurnsInFlight(flow)
    val resumed = range(0, MAX_JOBS).select(id => cut.contains(id)).foldl(dropCalls(flow), (resuming, id) =>
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

  /// `promptTask` queues a prompt for the job's task. A paused task keeps it. An unpaused harness
  /// task gets it at once when no turn runs, and a model-call author that is not at work takes
  /// its next turn, or produces its page first.
  pure def promptTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    val queued = withTask(flow, id, { ...task, promptsQueued: task.promptsQueued + 1 })
    if (isFinished(task.status)) flow
    else if (task.paused) queued
    else if (runsAsModelCalls(task)) {
      if (modelTurnInFlight(flow, id)) queued else startQueuedModelAuthors(takeNextModelTurn(queued, id))
    }
    else if (task.turnRunning) queued
    else withTask(flow, id, { ...task, status: Busy, turnRunning: true, promptsSent: task.promptsSent + 1 })
  }

  /// `pauseTask`: an unfinished task that is not paused holds its prompts from now on.
  pure def pauseTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    if (isFinished(task.status) or task.paused) flow else withTask(flow, id, { ...task, paused: true })
  }

  /// `resumeTask`: a paused task goes on with the resume prompt. A model-call author takes it as
  /// any prompt.
  pure def resumeTask(flow: Workflow, id: int): Workflow = {
    val task = jobTask(flow, id)
    if (isFinished(task.status) or not(task.paused)) flow
    else if (runsAsModelCalls(task)) promptTask(withTask(flow, id, { ...task, paused: false }), id)
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
  /// for the author to be quiet. Without refiners the humans get the page at once.
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
    if (not(REFINER)) { ...withJob(wrote, id, { ...job, tasks: tasks, artifact: Ready }), idleArmed: true }
    else if (queued) withJob(wrote, id, { ...job, tasks: tasks, artifact: Drafted })
    else withJob(wrote, id, { ...job, tasks: tasks, artifact: Drafted, refinerRun: RefinerRunning })
  }

  /// The reviewer approves. The humans get the page only while the author is quiet.
  pure def refinerRunFinished(flow: Workflow, id: int): Workflow = {
    val job = flow.jobs[id]
    val handedOver = job.artifact == Drafted and not(jobTask(flow, id).turnRunning)
    val finished = { ...job, refinerRun: RefinerRunFinished, artifact: if (handedOver) Ready else job.artifact }
    { ...withJob(flow, id, finished), idleArmed: flow.idleArmed or handedOver }
  }

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
  /// started from, and when it leaves out the stages on a started workflow.
  action agentSetsPlan: bool = all {
    not(hasEnded(workflow.status)),
    nondet definition = NAMED_DEFINITIONS.oneOf()
    nondet withStages = Set(true, false).oneOf()
    nondet jobSlots = SLOT_COUNTS.oneOf()
    val undeclared = not(DEFINITIONS.contains(definition))
    val otherDefinition = workflow.definition != Unplanned and workflow.definition != Planned(definition)
    val stagesLeftOut = not(withStages) and workflow.definition != Unplanned
    val refused = workflowEnding(workflow) or undeclared or otherDefinition or stagesLeftOut
    val planned = {
      ...workflow,
      definition: Planned(definition),
      status: Running,
      stagePlan: if (withStages) StagesPlanned(jobSlots) else workflow.stagePlan,
    }
    move(if (refused) workflow else planned, PlanStep(definition))
  }

  /// The agent calls `start_job` for the page stage in a turn a request woke. It may be refused.
  action agentStartsJob: bool = all {
    workflow.jobs.length() < MAX_JOBS,
    nondet request = REQUESTS.oneOf()
    val input = inputFor(workflow, request)
    move(if (canStartJob(workflow, input)) startedJob(workflow, input) else workflow, OtherStep),
  }

  /// The researcher's turn ends with its research payload written.
  action researcherHandsOver: bool = onJobWhere(
    id => taskWorks(workflow, id) and jobTask(workflow, id).role == Researcher,
    id => move(researchHandedOver(workflow, id), OtherStep),
  )

  /// The harness author writes its page and its turn ends.
  action authorWritesItsPage: bool = onJobWhere(
    id => and {
      taskWorks(workflow, id),
      jobTask(workflow, id).role == Author,
      workflow.jobs[id].artifact == NoArtifact,
    },
    id => move(pageWritten(workflow, id), OtherStep),
  )

  /// The reviewer of the page approves it, and its turn ends.
  action refinerRunEnds: bool = onJobWhere(
    id => workflow.jobs[id].refinerRun == RefinerRunning,
    id => move(refinerRunFinished(workflow, id), OtherStep),
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
      if (task.restarts >= MAX_RESTARTS) endTask(workflow, id, TaskFailed, AfterFail)
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
    else endTask(workflow, id, TaskCancelled, AfterCancel),
    OtherStep,
  ))

  /// The agent calls `complete_job` in a turn where the person accepted the page. It is refused
  /// while the researcher runs. A job without a page completes at once. Otherwise the decisions
  /// model checks the acceptance first.
  action agentCompletesJob: bool = onJob(id => move(
    if (isFinished(jobTask(workflow, id).status) or jobTask(workflow, id).role == Researcher) workflow
    else if (workflow.jobs[id].artifact == NoArtifact) completeAuthor(workflow, id)
    else sendCall(workflow, AcceptanceCheck, id, CompletionGoesOn),
    OtherStep,
  ))

  /// The decisions model answers the acceptance check. The job completes when it reads an acceptance
  /// in the person's message and stays open when it does not. `complete_job` reads the author
  /// again after the check, so an author that finished meanwhile keeps its status.
  action acceptanceCheckReturns: bool = all {
    outCalls(workflow, AcceptanceCheck).size() > 0,
    nondet callId = outCalls(workflow, AcceptanceCheck).oneOf()
    nondet accepted = Set(true, false).oneOf()
    val returned = withoutCall(workflow, callId)
    val id = workflow.calls[callId].job
    val completes = accepted and not(isFinished(jobTask(workflow, id).status))
    move(if (completes) completeAuthor(returned, id) else returned, OtherStep),
  }

  /// The sandbox provider returns from the destroy of an author's sandbox.
  action sandboxDestroyReturns: bool = all {
    outCalls(workflow, SandboxDestroy).size() > 0,
    nondet callId = outCalls(workflow, SandboxDestroy).oneOf()
    move(returnCall(workflow, callId), OtherStep),
  }

  /// The page model answers the model call of a model-call author.
  action modelCallReturns: bool = all {
    outCalls(workflow, ModelCall).size() > 0,
    nondet callId = outCalls(workflow, ModelCall).oneOf()
    move(returnCall(workflow, callId), OtherStep),
  }

  /// The deadline alarm of a model turn in flight fires, because its page write hangs. The turn is
  /// lost, and the answer of its model call changes nothing.
  action modelTurnOutlivesItsDeadline: bool = {
    val inFlight = outCalls(workflow, ModelCall).filter(callId =>
      not(isFinished(jobTask(workflow, workflow.calls[callId].job).status)))
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

  /// A person sends a verbal command in the chat thread: pause, resume, or instruct with its
  /// text. The message wakes a sleeping workflow. The command acts on the task of the one active
  /// job, a researcher too.
  action personSendsAVerbalCommand: bool = {
    nondet command = Set(Pause, Resume, Instruct).oneOf()
    move(
      if (hasEnded(workflow.status)) workflow else verbalCommandActs(messageWakes(workflow), command),
      VerbalCommandStep(command),
    )
  }

  /// The workflow ends once a job started. A person sends the cancel verbal command from the chat
  /// thread, the agent calls `fail_workflow`, or the agent calls `finish_workflow`, which is refused
  /// while a task is unfinished. Each is refused while another end runs. The cancel word may
  /// land on a workflow that already ended.
  action workflowEnds: bool = all {
    workflow.jobs.length() > 0,
    nondet ending = Set(PersonCancels, AgentFails, AgentFinishes).oneOf()
    val refused = hasEnded(workflow.status) or workflowEnding(workflow)
    match ending {
      | PersonCancels =>
        move(if (refused) workflow else continueWorkflowEnd(workflow, Cancelled), EventStep)
      | AgentFails => all {
        not(hasEnded(workflow.status)),
        move(if (refused) workflow else continueWorkflowEnd(workflow, Failed), OtherStep),
      }
      | AgentFinishes => all {
        not(hasEnded(workflow.status)),
        move(
          if (refused or unfinishedJobIds(workflow).length() > 0) workflow
          else finishWorkflowEnd(workflow, Done),
          OtherStep,
        ),
      }
    },
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

  /// The Durable Object restarts while a call is out. Every call that is out is lost with its isolate.
  action workflowRestarts: bool = all {
    workflow.calls.length() > 0,
    move(restartWorkflow(workflow), RestartStep),
  }

  action step: bool = any {
    agentSetsPlan,
    agentStartsJob,
    aTaskEndsItsTurn,
    refinerRunEnds,
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

  /// The researcher hands over to the author, or the harness author writes its page.
  action aTaskEndsItsTurn: bool = any { researcherHandsOver, authorWritesItsPage }

  /// The agent pauses, resumes or prompts a task.
  action theAgentSteersAnAuthor: bool = any { agentPausesAuthor, agentResumesAuthor, agentPromptsAuthor }

  /// The agent cancels or completes a job.
  action theAgentEndsAJob: bool = any { agentCancelsJob, agentCompletesJob }

  /// The page model answers a model call, or the deadline of its model turn passes first.
  action aModelTurnEnds: bool = any { modelCallReturns, modelTurnOutlivesItsDeadline }

  /// A message or an alarm reaches the workflow.
  action anOutsideEventLands: bool =
    any { personWrites, personSendsAVerbalCommand, idleAlarmFires, staleAlarmFires }

  pure def unfinishedCount(flow: Workflow): int = unfinishedJobIds(flow).length()

  pure def promptsSentToTasks(flow: Workflow): int =
    flow.jobs.foldl(0, (total, job) => job.tasks.foldl(total, (sum, task) => sum + task.promptsSent))

  /// True when a task of the job matches.
  pure def anyTaskOf(job: Job, matches: Task => bool): bool =
    job.tasks.indices().exists(index => matches(job.tasks[index]))

  pure def hasUnfinishedTask(flow: Workflow): bool =
    jobIds(flow).exists(id =>
      anyTaskOf(flow.jobs[id], task => not(isFinished(task.status))) or
      flow.jobs[id].refinerRun == RefinerRunning)

  pure def startedIn(before: Workflow, after: Workflow): bool = after.jobs.length() > before.jobs.length()

  /// True when the plan set the stages and the unfinished researchers and authors fit its job
  /// slots.
  pure def leavesAtMostTheJobSlots(flow: Workflow): bool = match flow.stagePlan {
    | NoStages => false
    | StagesPlanned(jobSlots) => unfinishedCount(flow) <= jobSlots
  }

  /// A job start leaves at most the plan's number of job slots of researchers and authors
  /// unfinished. A refiner run takes no slot.
  pure def startsOnlyIntoAFreeSlot(step: Transition): bool =
    startedIn(step.before, step.after) implies leavesAtMostTheJobSlots(step.after)

  /// True for a person's message: a chat message, a verbal command, or the cancel.
  pure def isEventStep(kind: StepKind): bool = match kind {
    | EventStep => true
    | VerbalCommandStep(_) => true
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

  /// A finished task never changes status again.
  pure def keepsFinishedTasks(step: Transition): bool =
    step.before.jobs.indices().forall(id => and {
      step.before.jobs[id].tasks.indices().forall(index =>
        isFinished(step.before.jobs[id].tasks[index].status) implies
          step.after.jobs[id].tasks[index].status == step.before.jobs[id].tasks[index].status),
      step.before.jobs[id].refinerRun == RefinerRunFinished implies
        step.after.jobs[id].refinerRun == RefinerRunFinished,
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
      aCallWasDropped: step.kind == RestartStep,
      aRestartCutsAModelTurn: step.kind == RestartStep and cut.size() > 0,
      aModelTurnOutlivesItsDeadline: match step.kind {
        | DeadlineStep(_) => true
        | _ => false
      },
      aReviseTurnIsCut: cut.exists(id => step.before.jobs[id].artifact != NoArtifact),
      aPausedAuthorLosesAModelTurn: cut.exists(id => jobTask(step.before, id).paused),
      anAuthorFailsOnALostModelTurn: cut.exists(id => jobTask(step.after, id).status == TaskFailed),
    }
  }

  /// A job start leaves at most the plan's number of job slots of jobs active.
  val jobStartsOnlyIntoAFreeSlot: bool = lastStepKept.jobStartsOnlyIntoAFreeSlot

  /// A workflow starts only from a plan that names a workflow definition of the deployment. Before
  /// that, a job does not start and the workflow is not running or waiting for input. A plan with
  /// an undeclared definition does not change the workflow.
  val workflowStartsOnlyFromAPlan: bool = and {
    lastStepKept.onlyAPlanStartsTheWorkflow,
    lastStepKept.anUndeclaredPlanChangesNothing,
    workflow.definition == Unplanned implies and {
      workflow.jobs.length() == 0,
      workflow.status != Running,
      workflow.status != WaitingInput,
    },
  }

  /// A later plan cannot change the workflow definition a workflow started with.
  val workflowKeepsItsDefinition: bool = lastStepKept.workflowKeepsItsDefinition

  /// Only one live job works from each input. An unfinished job holds its input. A finished job
  /// holds it while its output exists.
  val oneLiveJobPerInputArtifact: bool =
    jobIds(workflow).forall(id => jobIds(workflow).forall(other => and {
      id != other,
      workflow.jobs[id].input == workflow.jobs[other].input,
      holdsItsInput(workflow.jobs[id]),
    } implies not(holdsItsInput(workflow.jobs[other]))))

  /// A finished task never changes status again.
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
  val aRestartClosedAGeneration: bool =
    jobIds(workflow).exists(id => jobTask(workflow, id).generationClosed)

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

  /// A revise turn of a model-call author is in flight.
  val aReviseTurnIsInFlight: bool =
    modelTurnsInFlight(workflow).exists(id => workflow.jobs[id].artifact != NoArtifact)

  /// The reviewer of a page finished.
  val aRefinerRunFinished: bool =
    jobIds(workflow).exists(id => workflow.jobs[id].refinerRun == RefinerRunFinished)

  /// Witness for `inReviewTaskHasAnArtifact`: an author waits in review.
  val anAuthorIsInReview: bool = jobIds(workflow).exists(id => jobTask(workflow, id).status == InReview)

  /// The humans have a page.
  val theHumansHaveAPage: bool = jobIds(workflow).exists(id => workflow.jobs[id].artifact == Ready)

  /// The workflow finished done.
  val theWorkflowIsDone: bool = workflow.status == Done

  /// The workflow failed.
  val theWorkflowFailed: bool = workflow.status == Failed
}
