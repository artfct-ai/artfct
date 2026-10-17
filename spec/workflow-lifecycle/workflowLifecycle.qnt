/// The lifecycle of one workflow and its jobs, from the request to the end of the workflow.
/// Each action is one step of the orchestrator that runs to its end before the next event lands.
/// Two calls split a step: the destroy of an author's sandbox, and the acceptance check of
/// `complete_job`. One action sends the call and a later action returns it. A restart of the
/// Durable Object drops every call that is out, with the rest of its step.
/// The world answers every other await at once, so the model folds those into the step.
/// A refiner run is modelled only as running or finished.
module workflowLifecycleTypes {
  type WorkflowStatus = New | Running | WaitingInput | Done | Failed | Cancelled

  /// The workflow definition the plan started the workflow from, by its place in the deployment.
  type PlanDefinition = Unplanned | Planned(int)

  /// `Busy` covers queued, provisioning and working. `InReview` is an author whose page is out.
  type TaskStatus = Busy | InReview | TaskDone | TaskCancelled | TaskFailed

  /// The author task of a job. `turnRunning` holds while a prompt is in flight, also after the task
  /// finished. `promptsSent` counts the prompts the workflow sent its harness. `promptsQueued`
  /// counts the prompts that wait for the turn to end. `generationClosed` holds while a restart
  /// closed the container of the author's generation and did not start the next one, because a
  /// restart of the Durable Object dropped the rest or because the author is paused.
  type Author = {
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

  type Job = { input: Input, author: Author, artifact: ArtifactStatus, refinerRun: RefinerRunStatus }

  type CallKind = SandboxDestroy | AcceptanceCheck

  /// The end of an author task that sent the sandbox destroy.
  type Teardown = AfterCancel | AfterFail | AfterComplete

  /// Who ended the author: a tool call or an event, or the end of the workflow with the jobs it
  /// still has to cancel.
  type Caller = ToolOrEvent | WorkflowEnd({ endsAs: WorkflowStatus, remaining: List[int] })

  /// The rest of the step that runs when the call returns. `RestartAfterWake` is a restart whose
  /// author a resume woke in a new generation while its old container went. It stops there.
  type Rest =
    | TeardownGoesOn({ teardown: Teardown, caller: Caller })
    | RestartGoesOn
    | RestartAfterWake
    | CompletionGoesOn

  /// A call that is out. It leaves the list when it returns, or when a restart of the Durable
  /// Object drops it.
  type Call = { kind: CallKind, job: int, rest: Rest }

  type Workflow = {
    status: WorkflowStatus,
    definition: PlanDefinition,
    idleArmed: bool,
    jobs: List[Job],
    calls: List[Call],
  }

  /// What an observer knows about the last step besides the states around it.
  type StepKind = OtherStep | PlanStep(int) | EventStep | StaleAlarmStep | SleepStep | RestartStep

  /// One step: the workflow before it, the workflow after it, and what an observer knows of it.
  type Transition = { before: Workflow, after: Workflow, kind: StepKind }

  /// Whether the last step kept each before-and-after rule, by the name of the invariant that reads
  /// it. Each step writes it again, so the state does not keep the workflow before the step.
  type KeptRules = {
    jobStartsOnlyIntoAFreeSlot: bool,
    onlyAPlanStartsTheWorkflow: bool,
    workflowKeepsItsDefinition: bool,
    finishedTaskKeepsItsStatus: bool,
    nothingReopensAFinishedWorkflow: bool,
    staleAlarmIsIgnored: bool,
    sleepMessageOnlyDuringAWorkflow: bool,
    finishedWorkflowKeepsItsStatus: bool,
    pausedAuthorGetsNoPrompt: bool,
    workflowWaitsOnlyWhileNoAuthorWorks: bool,
  }

  /// Whether the last step reached each before-and-after witness, by the name of the witness. Only
  /// witnesses read it, so model checking leaves it out of the state.
  type ReachedWitnesses = {
    aPlanStartsTheWorkflow: bool,
    aPlanLandsOnAStartedWorkflow: bool,
    aJobStartsIntoTheLastSlot: bool,
    aFinishedTaskIsInAStep: bool,
    anEventLandsOnAFinishedWorkflow: bool,
    aStaleAlarmFires: bool,
    theSleepMessagePosts: bool,
    aMessageWakesTheWorkflow: bool,
    aPausedAuthorResumes: bool,
    aCallWasDropped: bool,
  }

  type Ending = PersonCancels | AgentFails | AgentFinishes
}

/// The lifecycle of a workflow whose jobs each write a page with a harness author.
module workflowLifecycle {
  import workflowLifecycleTypes.*

  /// True when the stage runs a reviewer on the page of each job.
  const REFINER: bool

  /// The task slots of the workflow.
  pure val SLOTS: int = 2

  /// How often a task restarts before it fails.
  pure val MAX_RESTARTS: int = 2

  /// The most jobs a trace starts.
  pure val MAX_JOBS: int = 3

  /// The request texts a job can work from.
  pure val REQUESTS: Set[int] = 0.to(1)

  /// The workflow definitions of the deployment.
  pure val DEFINITIONS: Set[int] = 0.to(1)

  pure val INITIAL_WORKFLOW: Workflow = {
    status: New,
    definition: Unplanned,
    idleArmed: true,
    jobs: List(),
    calls: List(),
  }

  var workflow: Workflow
  var lastStepKept: KeptRules
  var lastStepReached: ReachedWitnesses

  pure def isFinished(status: TaskStatus): bool =
    status == TaskDone or status == TaskCancelled or status == TaskFailed

  pure def hasEnded(status: WorkflowStatus): bool =
    status == Done or status == Failed or status == Cancelled

  pure def jobIds(flow: Workflow): Set[int] = flow.jobs.indices()

  pure def unfinishedJobIds(flow: Workflow): List[int] =
    range(0, MAX_JOBS).select(id => id < flow.jobs.length() and not(isFinished(flow.jobs[id].author.status)))

  pure def busyAuthors(flow: Workflow): Set[int] =
    jobIds(flow).filter(id => flow.jobs[id].author.status == Busy)

  pure def outCalls(flow: Workflow, kind: CallKind): Set[int] =
    flow.calls.indices().filter(id => flow.calls[id].kind == kind)

  pure def withJob(flow: Workflow, id: int, job: Job): Workflow =
    { ...flow, jobs: flow.jobs.replaceAt(id, job) }

  pure def withAuthor(flow: Workflow, id: int, author: Author): Workflow =
    withJob(flow, id, { ...flow.jobs[id], author: author })

  pure def withoutCall(flow: Workflow, id: int): Workflow =
    { ...flow, calls: flow.calls.slice(0, id).concat(flow.calls.slice(id + 1, flow.calls.length())) }

  pure def sendCall(flow: Workflow, kind: CallKind, id: int, rest: Rest): Workflow =
    { ...flow, calls: flow.calls.append({ kind: kind, job: id, rest: rest }) }

  /// The status an author takes from `finishTask`. The status is written before the sandbox goes.
  /// A prompt in flight stays in flight on the finished task.
  pure def finishAuthor(flow: Workflow, id: int, status: TaskStatus): Workflow =
    withAuthor(flow, id, {
      ...flow.jobs[id].author,
      status: status,
      promptsQueued: 0,
      generationClosed: false,
    })

  /// The input of a new job: the artifact of the latest done job whose artifact the humans have,
  /// or the request.
  pure def inputFor(flow: Workflow, request: int): Input = {
    val builtOn = jobIds(flow).filter(id =>
      flow.jobs[id].author.status == TaskDone and flow.jobs[id].artifact == Ready)
    if (builtOn.size() == 0) FromRequest(request)
    else FromArtifactOf(builtOn.fold(0, (latest, id) => if (id > latest) id else latest))
  }

  /// A job holds its input while its author is unfinished, and after that while its output exists.
  pure def holdsItsInput(job: Job): bool =
    not(isFinished(job.author.status)) or job.artifact != NoArtifact

  pure def inputHeld(flow: Workflow, input: Input): bool =
    jobIds(flow).exists(id => flow.jobs[id].input == input and holdsItsInput(flow.jobs[id]))

  /// True while the loop of a workflow end cancels its authors. Only this instance knows it, so a
  /// restart of the Durable Object forgets it with the calls it drops.
  pure def workflowEnding(flow: Workflow): bool =
    flow.calls.indices().exists(callId => match flow.calls[callId].rest {
      | TeardownGoesOn(teardown) => match teardown.caller {
        | WorkflowEnd(_) => true
        | ToolOrEvent => false
      }
      | _ => false
    })

  pure def canStartJob(flow: Workflow, input: Input): bool = and {
    not(hasEnded(flow.status)),
    not(workflowEnding(flow)),
    flow.definition != Unplanned,
    unfinishedJobIds(flow).length() < SLOTS,
    not(inputHeld(flow, input)),
  }

  pure def startedJob(flow: Workflow, input: Input): Workflow = {
    val author = {
      status: Busy,
      restarts: 0,
      paused: false,
      turnRunning: true,
      promptsSent: 1,
      promptsQueued: 0,
      generationClosed: false,
    }
    val job = { input: input, author: author, artifact: NoArtifact, refinerRun: NoRefinerRun }
    { ...flow, jobs: flow.jobs.append(job), status: Running }
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

  /// The loop of a workflow end cancels the next author of the list it read when it began. It reads
  /// each author again, so an author that finished meanwhile keeps its status.
  pure def continueWorkflowEnd(flow: Workflow, endsAs: WorkflowStatus, remaining: List[int]): Workflow = {
    val left = remaining.select(id => not(isFinished(flow.jobs[id].author.status)))
    if (left.length() == 0) finishWorkflowEnd(flow, endsAs)
    else {
      val id = left.head()
      val caller = WorkflowEnd({ endsAs: endsAs, remaining: left.tail() })
      sendCall(
        finishAuthor(flow, id, TaskCancelled),
        SandboxDestroy,
        id,
        TeardownGoesOn({ teardown: AfterCancel, caller: caller }),
      )
    }
  }

  pure def startWorkflowEnd(flow: Workflow, endsAs: WorkflowStatus): Workflow =
    continueWorkflowEnd(flow, endsAs, unfinishedJobIds(flow))

  pure def teardownGoesOn(flow: Workflow, id: int, caller: Caller): Workflow = {
    val reviewed = endReview(flow, id)
    match caller {
      | ToolOrEvent => reviewed
      | WorkflowEnd(end) => continueWorkflowEnd(reviewed, end.endsAs, end.remaining)
    }
  }

  /// The restart reads the author again once its old container went. A finished author stays
  /// finished. A paused author counts the restart and waits for its resume to start the next
  /// generation. Otherwise `restartSandbox` puts the task back to queued and counts the restart,
  /// then the sandbox comes up and the harness gets the queued prompt, or its first prompt.
  pure def restartGoesOn(flow: Workflow, id: int): Workflow = {
    val author = flow.jobs[id].author
    if (isFinished(author.status)) flow
    else if (author.paused)
      withAuthor(flow, id, { ...author, restarts: author.restarts + 1, generationClosed: true })
    else
      withAuthor(flow, id, {
        ...author,
        status: Busy,
        restarts: author.restarts + 1,
        turnRunning: true,
        promptsSent: author.promptsSent + 1,
        promptsQueued: if (author.promptsQueued > 0) author.promptsQueued - 1 else 0,
      })
  }

  /// `completeJob` ends the author done with the row it read before the check.
  pure def completeAuthor(flow: Workflow, id: int): Workflow =
    sendCall(
      finishAuthor(flow, id, TaskDone),
      SandboxDestroy,
      id,
      TeardownGoesOn({ teardown: AfterComplete, caller: ToolOrEvent }),
    )

  pure def returnCall(flow: Workflow, callId: int): Workflow = {
    val call = flow.calls[callId]
    val returned = withoutCall(flow, callId)
    match call.rest {
      | TeardownGoesOn(teardown) => teardownGoesOn(returned, call.job, teardown.caller)
      | RestartGoesOn => restartGoesOn(returned, call.job)
      | RestartAfterWake => returned
      | CompletionGoesOn => returned
    }
  }

  /// A restart of the Durable Object drops every call that is out. An author whose restart it
  /// dropped keeps its task while its generation is closed.
  pure def dropCalls(flow: Workflow): Workflow = {
    val stranded = flow.calls.indices().filter(callId =>
      flow.calls[callId].rest == RestartGoesOn and
      not(isFinished(flow.jobs[flow.calls[callId].job].author.status)))
    val jobs = range(0, MAX_JOBS).select(id => id < flow.jobs.length()).foldl(List(), (jobs, id) => jobs.append({
      ...flow.jobs[id],
      author: {
        ...flow.jobs[id].author,
        generationClosed: flow.jobs[id].author.generationClosed or
          stranded.exists(callId => flow.calls[callId].job == id),
      },
    }))
    { ...flow, jobs: jobs, calls: List() }
  }

  /// A stalled author whose generation is closed gets the next one, and its harness the queued
  /// prompt or a wake text. This does not count as a restart.
  pure def recoverLostTurn(flow: Workflow, id: int): Workflow = {
    val author = flow.jobs[id].author
    withAuthor(flow, id, {
      ...author,
      generationClosed: false,
      promptsSent: author.promptsSent + 1,
      promptsQueued: if (author.promptsQueued > 0) author.promptsQueued - 1 else 0,
    })
  }

  /// `resumeTask` queues the resume prompt and sends the head of the queue. Without a bridge it
  /// starts the next generation for it, also while a restart is closing the old container.
  pure def resumeAuthor(flow: Workflow, id: int): Workflow = {
    val author = flow.jobs[id].author
    val calls = flow.calls.foldl(List(), (calls, call) => calls.append(
      if (call.job == id and call.rest == RestartGoesOn)
        { ...call, rest: RestartAfterWake }
      else call))
    withAuthor({ ...flow, calls: calls }, id, {
      ...author,
      paused: false,
      turnRunning: true,
      promptsSent: author.promptsSent + 1,
      generationClosed: false,
      status: if (author.status == InReview) Busy else author.status,
    })
  }

  /// The turn that wrote the page ends. A queued prompt goes out at once, and the refiners wait
  /// for the author to be quiet. Without refiners the humans get the page at once.
  pure def pageWritten(flow: Workflow, id: int): Workflow = {
    val job = flow.jobs[id]
    val queued = job.author.promptsQueued > 0
    val author =
      if (queued)
        {
          ...job.author,
          promptsSent: job.author.promptsSent + 1,
          promptsQueued: job.author.promptsQueued - 1,
        }
      else { ...job.author, status: InReview, turnRunning: false }
    if (not(REFINER)) { ...withJob(flow, id, { ...job, author: author, artifact: Ready }), idleArmed: true }
    else if (queued) withJob(flow, id, { ...job, author: author, artifact: Drafted })
    else withJob(flow, id, { ...job, author: author, artifact: Drafted, refinerRun: RefinerRunning })
  }

  /// The reviewer approves. The humans get the page only while the author is quiet.
  pure def refinerRunFinished(flow: Workflow, id: int): Workflow = {
    val job = flow.jobs[id]
    val handedOver = job.artifact == Drafted and not(job.author.turnRunning)
    val finished = { ...job, refinerRun: RefinerRunFinished, artifact: if (handedOver) Ready else job.artifact }
    { ...withJob(flow, id, finished), idleArmed: flow.idleArmed or handedOver }
  }

  /// True when the author's harness is on a turn the agent did not pause, in a generation that runs.
  pure def authorWorks(flow: Workflow, id: int): bool =
    authorStuck(flow, id) and not(flow.jobs[id].author.generationClosed)

  /// True when the author's turn runs unpaused and its sandbox is not on its way out.
  pure def authorStuck(flow: Workflow, id: int): bool = and {
    flow.jobs[id].author.status == Busy,
    flow.jobs[id].author.turnRunning,
    not(flow.jobs[id].author.paused),
    not(flow.calls.indices().exists(callId =>
      flow.calls[callId].job == id and flow.calls[callId].kind == SandboxDestroy)),
  }

  pure def sleeps(flow: Workflow): bool = flow.status == Running and busyAuthors(flow).size() == 0

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

  /// The agent calls `set_plan` with stages and one of the workflow definitions while the workflow
  /// has not ended. A plan is refused while the workflow ends, and when it names another workflow
  /// definition than the one the workflow started from.
  action agentSetsPlan: bool = all {
    not(hasEnded(workflow.status)),
    nondet definition = DEFINITIONS.oneOf()
    val otherDefinition = workflow.definition != Unplanned and workflow.definition != Planned(definition)
    val refused = workflowEnding(workflow) or otherDefinition
    move(
      if (refused) workflow else { ...workflow, definition: Planned(definition), status: Running },
      PlanStep(definition),
    )
  }

  /// The agent calls `start_job` for the page stage in a turn a request woke. It may be refused.
  action agentStartsJob: bool = all {
    workflow.jobs.length() < MAX_JOBS,
    nondet request = REQUESTS.oneOf()
    val input = inputFor(workflow, request)
    move(if (canStartJob(workflow, input)) startedJob(workflow, input) else workflow, OtherStep),
  }

  /// The author writes its page and its turn ends.
  action authorWritesItsPage: bool = onJobWhere(
    id => authorWorks(workflow, id) and workflow.jobs[id].artifact == NoArtifact,
    id => move(pageWritten(workflow, id), OtherStep),
  )

  /// The reviewer of the page approves it, and its turn ends.
  action refinerRunEnds: bool = onJobWhere(
    id => workflow.jobs[id].refinerRun == RefinerRunning,
    id => move(refinerRunFinished(workflow, id), OtherStep),
  )

  /// The agent calls `pause_task` on the author. A finished or paused author is left alone.
  action agentPausesAuthor: bool = onJob(id => {
    val author = workflow.jobs[id].author
    val pauses = not(isFinished(author.status)) and not(author.paused)
    move(if (pauses) withAuthor(workflow, id, { ...author, paused: true }) else workflow, OtherStep)
  })

  /// The agent calls `resume_task` on the author. Its harness gets a prompt to go on.
  action agentResumesAuthor: bool = onJob(id => {
    val author = workflow.jobs[id].author
    val resumes = not(isFinished(author.status)) and author.paused
    move(if (resumes) resumeAuthor(workflow, id) else workflow, OtherStep)
  })

  /// The no progress alarm finds the author's turn stalled after a nudge. The author restarts in a
  /// fresh sandbox once its container is destroyed, or fails once its restarts are used up.
  action authorStalls: bool = onJobWhere(id => authorStuck(workflow, id), id => {
    val author = workflow.jobs[id].author
    all {
      move(
        if (author.generationClosed) recoverLostTurn(workflow, id)
        else if (author.restarts < MAX_RESTARTS)
          sendCall(
            withAuthor(workflow, id, { ...author, promptsQueued: author.promptsQueued + 1 }),
            SandboxDestroy,
            id,
            RestartGoesOn,
          )
        else
          sendCall(
            finishAuthor(workflow, id, TaskFailed),
            SandboxDestroy,
            id,
            TeardownGoesOn({ teardown: AfterFail, caller: ToolOrEvent }),
          ),
        OtherStep,
      ),
    }
  })

  /// The agent calls `cancel_job`. A finished job is left alone.
  action agentCancelsJob: bool = onJob(id => move(
    if (isFinished(workflow.jobs[id].author.status)) workflow
    else sendCall(
      finishAuthor(workflow, id, TaskCancelled),
      SandboxDestroy,
      id,
      TeardownGoesOn({ teardown: AfterCancel, caller: ToolOrEvent }),
    ),
    OtherStep,
  ))

  /// The agent calls `complete_job` in a turn where the person accepted the page. A job without a
  /// page completes at once. Otherwise the decisions model checks the acceptance first.
  action agentCompletesJob: bool = onJob(id => move(
    if (isFinished(workflow.jobs[id].author.status)) workflow
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
    val completes = accepted and not(isFinished(workflow.jobs[id].author.status))
    move(if (completes) completeAuthor(returned, id) else returned, OtherStep),
  }

  /// The sandbox provider returns from the destroy of an author's sandbox.
  action sandboxDestroyReturns: bool = all {
    outCalls(workflow, SandboxDestroy).size() > 0,
    nondet callId = outCalls(workflow, SandboxDestroy).oneOf()
    move(returnCall(workflow, callId), OtherStep),
  }

  /// A person writes a message in the chat thread. It wakes a sleeping workflow.
  action personWrites: bool = move(
    if (hasEnded(workflow.status)) workflow
    else { ...workflow, idleArmed: true, status: if (workflow.status == WaitingInput) Running else workflow.status },
    EventStep,
  )

  /// The workflow ends once a job started. A person sends the cancel control word from the chat
  /// thread, the agent calls `fail_workflow`, or the agent calls `finish_workflow`, which is refused
  /// while an author is unfinished. Each is refused while another end runs. The cancel word may
  /// land on a workflow that already ended.
  action workflowEnds: bool = all {
    workflow.jobs.length() > 0,
    nondet ending = Set(PersonCancels, AgentFails, AgentFinishes).oneOf()
    val refused = hasEnded(workflow.status) or workflowEnding(workflow)
    match ending {
      | PersonCancels =>
        move(if (refused) workflow else startWorkflowEnd(workflow, Cancelled), EventStep)
      | AgentFails => all {
        not(hasEnded(workflow.status)),
        move(if (refused) workflow else startWorkflowEnd(workflow, Failed), OtherStep),
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

  /// The idle alarm fires. A running workflow whose authors are not busy goes to sleep.
  action idleAlarmFires: bool = all {
    workflow.idleArmed,
    val disarmed = { ...workflow, idleArmed: false }
    if (sleeps(workflow)) move({ ...disarmed, status: WaitingInput }, SleepStep)
    else move(disarmed, OtherStep),
  }

  /// An alarm of a sandbox generation before the current one fires.
  action staleAlarmFires: bool = all {
    workflow.jobs.length() > 0,
    move(workflow, StaleAlarmStep),
  }

  /// The Durable Object restarts while a call is out. Every call that is out is lost with its isolate.
  action workflowRestarts: bool = all {
    workflow.calls.length() > 0,
    move(dropCalls(workflow), RestartStep),
  }

  action step: bool = any {
    agentSetsPlan,
    agentStartsJob,
    authorWritesItsPage,
    refinerRunEnds,
    theAgentSteersAnAuthor,
    authorStalls,
    theAgentEndsAJob,
    acceptanceCheckReturns,
    sandboxDestroyReturns,
    workflowEnds,
    anOutsideEventLands,
    workflowRestarts,
  }

  /// The agent pauses or resumes an author.
  action theAgentSteersAnAuthor: bool = any { agentPausesAuthor, agentResumesAuthor }

  /// The agent cancels or completes a job.
  action theAgentEndsAJob: bool = any { agentCancelsJob, agentCompletesJob }

  /// A message or an alarm reaches the workflow.
  action anOutsideEventLands: bool = any { personWrites, idleAlarmFires, staleAlarmFires }

  pure def unfinishedCount(flow: Workflow): int = unfinishedJobIds(flow).length()

  pure def promptsSentToAuthors(flow: Workflow): int =
    flow.jobs.foldl(0, (total, job) => total + job.author.promptsSent)

  pure def hasUnfinishedTask(flow: Workflow): bool =
    jobIds(flow).exists(id => not(isFinished(flow.jobs[id].author.status)) or flow.jobs[id].refinerRun == RefinerRunning)

  pure def startedIn(before: Workflow, after: Workflow): bool = after.jobs.length() > before.jobs.length()

  /// A job starts only into a free slot: before the step that started it, the unfinished authors
  /// were fewer than the slots. A refiner run takes no slot.
  pure def startsOnlyIntoAFreeSlot(step: Transition): bool =
    startedIn(step.before, step.after) implies unfinishedCount(step.before) < SLOTS

  /// A step that gives the workflow its definition is a plan that names a workflow definition of
  /// the deployment.
  pure def onlyAPlanStarts(step: Transition): bool =
    (step.before.definition == Unplanned and step.after.definition != Unplanned) implies
      DEFINITIONS.exists(definition =>
        step.after.definition == Planned(definition) and step.kind == PlanStep(definition))

  /// A later plan cannot change the workflow definition a workflow started with.
  pure def keepsTheDefinition(step: Transition): bool =
    step.before.definition != Unplanned implies step.after.definition == step.before.definition

  /// A finished task never changes status again.
  pure def keepsFinishedTasks(step: Transition): bool =
    step.before.jobs.indices().forall(id => and {
      isFinished(step.before.jobs[id].author.status) implies
        step.after.jobs[id].author.status == step.before.jobs[id].author.status,
      step.before.jobs[id].refinerRun == RefinerRunFinished implies
        step.after.jobs[id].refinerRun == RefinerRunFinished,
    })

  /// On a finished workflow, no event changes the status, the tasks, or the prompts.
  pure def leavesAFinishedWorkflow(step: Transition): bool =
    (step.kind == EventStep and hasEnded(step.before.status)) implies and {
      step.after.status == step.before.status,
      step.after.jobs.length() == step.before.jobs.length(),
      promptsSentToAuthors(step.after) == promptsSentToAuthors(step.before),
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

  /// The workflow sends a paused author no prompt until it resumes.
  pure def sendsAPausedAuthorNoPrompt(step: Transition): bool =
    step.before.jobs.indices().forall(id =>
      (step.before.jobs[id].author.paused and step.after.jobs[id].author.paused) implies
        step.after.jobs[id].author.promptsSent == step.before.jobs[id].author.promptsSent)

  /// The workflow moves to waiting for input only in a step that leaves no author busy.
  pure def waitsOnlyWhileNoAuthorWorks(step: Transition): bool =
    (step.after.status == WaitingInput and step.before.status != WaitingInput) implies
      busyAuthors(step.after).size() == 0

  /// Whether one step kept each before-and-after rule.
  pure def rulesKeptBy(step: Transition): KeptRules = {
    jobStartsOnlyIntoAFreeSlot: startsOnlyIntoAFreeSlot(step),
    onlyAPlanStartsTheWorkflow: onlyAPlanStarts(step),
    workflowKeepsItsDefinition: keepsTheDefinition(step),
    finishedTaskKeepsItsStatus: keepsFinishedTasks(step),
    nothingReopensAFinishedWorkflow: leavesAFinishedWorkflow(step),
    staleAlarmIsIgnored: ignoresAStaleAlarm(step),
    sleepMessageOnlyDuringAWorkflow: sleepsOnlyDuringAWorkflow(step),
    finishedWorkflowKeepsItsStatus: keepsAFinishedStatus(step),
    pausedAuthorGetsNoPrompt: sendsAPausedAuthorNoPrompt(step),
    workflowWaitsOnlyWhileNoAuthorWorks: waitsOnlyWhileNoAuthorWorks(step),
  }

  /// Whether one step reached each before-and-after witness.
  pure def witnessesReachedBy(step: Transition): ReachedWitnesses = {
    aPlanStartsTheWorkflow: step.before.definition == Unplanned and step.after.definition != Unplanned,
    aPlanLandsOnAStartedWorkflow: match step.kind {
      | PlanStep(_) => step.before.definition != Unplanned
      | _ => false
    },
    aJobStartsIntoTheLastSlot:
      startedIn(step.before, step.after) and unfinishedCount(step.before) == SLOTS - 1,
    aFinishedTaskIsInAStep:
      step.before.jobs.indices().exists(id => isFinished(step.before.jobs[id].author.status)),
    anEventLandsOnAFinishedWorkflow: step.kind == EventStep and hasEnded(step.before.status),
    aStaleAlarmFires: step.kind == StaleAlarmStep,
    theSleepMessagePosts: step.kind == SleepStep,
    aMessageWakesTheWorkflow:
      step.kind == EventStep and step.before.status == WaitingInput and step.after.status == Running,
    aPausedAuthorResumes: step.before.jobs.indices().exists(id =>
      step.before.jobs[id].author.paused and not(step.after.jobs[id].author.paused)),
    aCallWasDropped: step.kind == RestartStep,
  }

  /// A job starts only into a free slot.
  val jobStartsOnlyIntoAFreeSlot: bool = lastStepKept.jobStartsOnlyIntoAFreeSlot

  /// A workflow starts only from a plan that names a workflow definition of the deployment. Before
  /// that, a job does not start and the workflow is not running or waiting for input.
  val workflowStartsOnlyFromAPlan: bool = and {
    lastStepKept.onlyAPlanStartsTheWorkflow,
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

  /// A workflow whose status is done, failed or cancelled has no unfinished task.
  val endedWorkflowHasNoUnfinishedTask: bool =
    hasEnded(workflow.status) implies not(hasUnfinishedTask(workflow))

  /// On a finished workflow, no event changes the status, the tasks, or the prompts.
  val nothingReopensAFinishedWorkflow: bool = lastStepKept.nothingReopensAFinishedWorkflow

  /// An alarm of an older sandbox generation changes nothing.
  val staleAlarmIsIgnored: bool = lastStepKept.staleAlarmIsIgnored

  /// The sleep message posts only while the workflow runs from a plan.
  val sleepMessageOnlyDuringAWorkflow: bool = lastStepKept.sleepMessageOnlyDuringAWorkflow

  /// A workflow that is done, failed or cancelled keeps that status.
  val finishedWorkflowKeepsItsStatus: bool = lastStepKept.finishedWorkflowKeepsItsStatus

  /// A task restarts at most `MAX_RESTARTS` times, whatever the cause.
  val taskRestartsAtMostTwice: bool =
    jobIds(workflow).forall(id => workflow.jobs[id].author.restarts <= MAX_RESTARTS)

  /// The workflow sends a paused author no prompt until it resumes.
  val pausedAuthorGetsNoPrompt: bool = lastStepKept.pausedAuthorGetsNoPrompt

  /// The workflow moves to waiting for input only in a step that leaves no author busy.
  val workflowWaitsOnlyWhileNoAuthorWorks: bool = lastStepKept.workflowWaitsOnlyWhileNoAuthorWorks

  /// The prompts the workflow sent its authors, a counter that model checking bounds.
  val promptsSent: int = promptsSentToAuthors(workflow)

  /// The calls that are out, a counter that model checking bounds.
  val callsOut: int = workflow.calls.length()

  /// The jobs the workflow started, a counter that model checking bounds.
  val jobsStarted: int = workflow.jobs.length()

  /// Witness for `workflowStartsOnlyFromAPlan`: a plan starts the workflow.
  val aPlanStartsTheWorkflow: bool = lastStepReached.aPlanStartsTheWorkflow

  /// Witness for `workflowKeepsItsDefinition`: a plan lands on a started workflow.
  val aPlanLandsOnAStartedWorkflow: bool = lastStepReached.aPlanLandsOnAStartedWorkflow

  /// Witness for `jobStartsOnlyIntoAFreeSlot`: a job starts into the last slot.
  val aJobStartsIntoTheLastSlot: bool = lastStepReached.aJobStartsIntoTheLastSlot

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
  val anAuthorRestarted: bool = jobIds(workflow).exists(id => workflow.jobs[id].author.restarts > 0)

  /// A restart closed the generation of an author and did not start the next one.
  val aRestartClosedAGeneration: bool =
    jobIds(workflow).exists(id => workflow.jobs[id].author.generationClosed)

  /// A paused author restarted and waits for its resume to start the next generation.
  val aPausedAuthorWaitsToRestart: bool =
    jobIds(workflow).exists(id =>
      workflow.jobs[id].author.paused and workflow.jobs[id].author.generationClosed)

  /// The workflow ends while its loop waits on the destroy of an author's sandbox.
  val theWorkflowIsEnding: bool = workflowEnding(workflow)

  /// A prompt waits for the turn of an author to end.
  val aPromptWaits: bool = jobIds(workflow).exists(id => workflow.jobs[id].author.promptsQueued > 0)

  /// An author failed once its restarts were used up.
  val anAuthorFailed: bool = jobIds(workflow).exists(id => workflow.jobs[id].author.status == TaskFailed)

  /// A paused author resumes.
  val aPausedAuthorResumes: bool = lastStepReached.aPausedAuthorResumes

  /// A job completes.
  val aJobCompletes: bool = jobIds(workflow).exists(id => workflow.jobs[id].author.status == TaskDone)

  /// The acceptance check of a completion is out.
  val anAcceptanceCheckIsOut: bool = outCalls(workflow, AcceptanceCheck).size() > 0

  /// A restart of the Durable Object dropped a call.
  val aCallWasDropped: bool = lastStepReached.aCallWasDropped

  /// The reviewer of a page finished.
  val aRefinerRunFinished: bool =
    jobIds(workflow).exists(id => workflow.jobs[id].refinerRun == RefinerRunFinished)

  /// The humans have a page.
  val theHumansHaveAPage: bool = jobIds(workflow).exists(id => workflow.jobs[id].artifact == Ready)

  /// The workflow finished done.
  val theWorkflowIsDone: bool = workflow.status == Done

  /// The workflow failed.
  val theWorkflowFailed: bool = workflow.status == Failed
}
