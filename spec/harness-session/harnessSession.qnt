/// One harness author task: its sandbox, its bridge, and its harness session, from the provision
/// alarm to the end of the task.
/// Each action is one event the orchestrator handles to its end before the next event lands. Five
/// calls split an event: the branch binding write, the sandbox start, the sandbox destroy, the turn
/// outcome check, and the summarization of a turn text. One
/// action sends the call and a later action returns it. A restart of the Durable Object drops every
/// call that is out, with the rest of its event. Every other await is answered at once.
/// Any alarm may fire at any step, also before its delay ran out. Time moves only when
/// `timePasses` takes the clock past the reconnect ceiling.
/// The bridge and its harness are modelled from the outside. A bridge sends a frame only on a
/// socket that both ends hold open. The harness answers its prompts and handshake requests in the
/// order they came. It answers a steer apart from them, and it answers a steer it took before it
/// ends that turn.
module harnessSessionTypes {
  /// The status of the author task. A task in this model cannot finish done.
  type TaskStatus = Queued | Provisioning | Working | InReview | Cancelled | Failed

  /// What a queued prompt is, by the code that queued it. A person prompt names which of the
  /// person's prompts it is.
  type PromptKind =
    | PersonPrompt(int)
    | ContinuePrompt
    | NudgePrompt
    | GaveUpWake
    | LostSandboxWake
    | FirstPrompt

  /// Why the orchestrator sent a JSON-RPC request to the harness.
  type RpcPurpose = Initialize | SessionNew | SetEffort | Prompt | Steer

  /// The person prompt a request carries to the harness session, if any.
  type Carried = NoPerson | Person(int)

  /// A steered person prompt: its steer request is out, or the running turn took it.
  type SteerStatus = SteerOut | SteerTaken

  /// A queued person prompt that a request carried into the running turn. `rpc` is the id of that
  /// request: a steer, or the prompt that started the turn.
  type SteerRow = { person: int, rpc: int, status: SteerStatus }

  /// A request the orchestrator waits on. `serial` names the request itself, and the code does not
  /// see it. The store never gives an rpc id twice, so the id is the serial plus one.
  type RpcRow = { id: int, purpose: RpcPurpose, serial: int }

  /// The alarm a schedule column points at.
  type Slot = Unarmed | Armed(int)

  /// The alarm handler and the generation its payload names. The wall clock and the provision
  /// alarm name only the task.
  type AlarmKind =
    | Provision
    | HelloTimeout(int)
    | NoProgress(int)
    | WallClock
    | KeepAlive(int)
    | RetryQueue(int)
    | SettleIdleAuthor(int)
    | BridgeLost(int)

  type Alarm = { id: int, kind: AlarmKind }

  /// A time the store keeps: unset, within the reconnect ceiling of now, or older.
  type Stamp = Unset | Recent | Old

  /// A socket between the orchestrator and a bridge. `Connected` and `BridgeGone` are listed in
  /// the task's connections. `BridgeGone` is a socket whose bridge end closed or died before the
  /// orchestrator got the close. The `Closing` states are sockets the orchestrator closed, with
  /// the close code the bridge gets: `ClosingReplaced` for 4002, `ClosingContainer` for 1000.
  type SocketState = Connected | BridgeGone | ClosingReplaced | ClosingContainer | ClosingBridgeGone

  /// `generation` is the sandbox generation the orchestrator stored on the socket when it accepted it.
  type Socket = { bridge: int, generation: int, state: SocketState }

  /// A request a bridge passed to its harness. The harness has not answered it yet.
  type Request = { id: int, purpose: RpcPurpose, cancelled: bool, serial: int, carries: Carried }

  /// One bridge process and its harness. `token` is the bridge token it started with. `received`
  /// holds the person prompts its harness session received, except those of a cancelled turn.
  /// `inTurn` holds the ones its running turn received.
  type Bridge = {
    generation: int,
    token: int,
    alive: bool,
    saidHello: bool,
    requests: List[Request],
    received: Set[int],
    inTurn: Set[int],
  }

  /// What runs after the call that returns, innermost first. `CloseFeedWithoutStopReason` throws
  /// when the author is idle, because the feed closing reads a stop reason the answer lacked.
  /// `AlarmEnds` marks the end of an alarm's handler. The alarm stays scheduled until it runs.
  /// `WakeTheAgent` wakes the orchestrator agent when the harness is idle after a turn end or a
  /// refused prompt. With `summarizes`, the turn text needs a summarization first.
  /// `RestartAfterClose` names the generation and the restart count that its restart began from.
  /// `StartEnds` names the generation of its sandbox start. That start is out while a call that is
  /// out carries the frame.
  type Frame =
    | RestartAfterClose({ generation: int, restarts: int })
    | StartEnds(int)
    | CloseFeedWithoutStopReason
    | AlarmEnds(Alarm)
    | WakeTheAgent({ summarizes: bool })

  /// A call the orchestrator awaits. A sandbox destroy kills the bridges up to the generation it
  /// names. An outcome check remembers the prompts sent and the generation when its turn ended. A
  /// summarization is the model call that shortens a long turn text before the agent wakes. A branch
  /// binding is the router write that routes pushes on the job's branch to the workflow.
  type CallKind =
    | BranchBinding
    | SandboxStart({ generation: int, token: int, launched: bool })
    | SandboxDestroy(int)
    | OutcomeCheck({ promptsSent: int, generation: int })
    | Summarization

  /// A call is out until it returns and leaves the list. A restart of the Durable Object drops the
  /// calls that are out. A dropped start stays until its container comes up. Every other dropped
  /// call leaves the list.
  type CallState = Out | Dropped

  type Call = { id: int, kind: CallKind, state: CallState, rest: List[Frame] }

  /// How the author left its work when its turn ended on its own, by the decisions model.
  type Outcome = Finished | WaitsOnPerson | Blocked | StoppedEarly

  /// The stop reason a prompt answer carries.
  type StopReason = EndTurn | CancelledTurn | MaxTokens

  /// What the harness reports during its turn: a tool call, or a todo list that has open entries or
  /// whose every entry is completed.
  type ProgressReport = ToolCall | OpenTodoList | FinishedTodoList

  /// The task, its sandbox row, its queue and rpc rows, its alarms, the sockets and bridges around
  /// it, and the calls out. The counters and the stop flag at the end are what an observer records.
  /// `lostTurns` counts the lost turns the code handled: each one recovered, or failed its task.
  /// `turnText` says the turn so far printed text. `openTodos` says the stored todo list of the task
  /// has open entries. `steers` holds the steered person prompts. `delivered` holds the person
  /// prompts a harness turn received and ended without a cancel. `discarded` holds the ones a stop
  /// or the end of the task dropped. `receivedTwice` counts a harness session that received a
  /// person prompt it already had.
  type World = {
    status: TaskStatus,
    restarts: int,
    paused: bool,
    generation: int,
    token: int,
    session: bool,
    hadPrompt: bool,
    promptInFlight: bool,
    nudged: bool,
    stoppedEarly: bool,
    turnText: bool,
    openTodos: bool,
    bridgeClosedAt: Stamp,
    lastProgressAt: Stamp,
    queue: List[PromptKind],
    rpcs: List[RpcRow],
    steers: Set[SteerRow],
    artifact: bool,
    helloSlot: Slot,
    noProgressSlot: Slot,
    wallSlot: Slot,
    keepAliveSlot: Slot,
    alarms: List[Alarm],
    nextAlarm: int,
    sockets: List[Socket],
    bridges: List[Bridge],
    calls: List[Call],
    nextCall: int,
    nextSerial: int,
    promptsSent: int,
    cancelsDelivered: int,
    permissionsAsked: int,
    permissionsWithAnAllowOption: int,
    permissionsAllowed: int,
    socketsClosed: int,
    lostTurns: int,
    stopsEnded: int,
    answersToOtherRequests: int,
    agentWakes: int,
    eventsThatThrew: int,
    personPrompts: int,
    delivered: Set[int],
    discarded: Set[int],
    receivedTwice: int,
    resumesChosen: int,
    faults: int,
    actions: int,
    stopped: bool,
  }

  /// What kind of event the last step was, as far as a rule needs it.
  type StepKind =
    | OtherStep
    | HelloStep
    | StopStep
    | StaleAlarmStep
    | ExitStep
    | StartFailedStep({ generation: int, atOnce: bool })
    | HelloTimeoutStep
    | PromptRefusedStep
    | ProvisionStep
    | BranchBindingReturnStep
    | WallClockStep
    | KeepAliveStep
    | DialStep
    | DurableObjectRestartStep
    | AnswerStep({ reachedItsOwnRow: bool, purpose: RpcPurpose })
    | SteerAnswerStep({ injected: bool, reachedItsRow: bool })
    | EmptyTurnEndStep
    | OutcomeStep({ laterPromptInFlight: bool })

  /// One step: the world before it, the world after it, and what kind of step it was.
  type Step = { before: World, after: World, kind: StepKind }

  /// For each before-and-after rule, whether the last step kept it. Each step writes it anew.
  type RulesKept = {
    finishedTaskKeepsItsStatus: bool,
    pausedAuthorGetsNoPrompt: bool,
    staleAlarmIsIgnored: bool,
    stopEndsTheAuthorsTurn: bool,
    aSandboxStartBeginsAFreshGeneration: bool,
    aStartingTaskWorksOnlyAfterItsHello: bool,
    anAuthorInReviewWorksOnlyWithAPrompt: bool,
    aLostTurnCountsOneRestart: bool,
    aHarnessExitCountsOneRestart: bool,
    aFailedSandboxStartRestartsOrFails: bool,
    aRefusedPromptLeavesTheTurn: bool,
    provisionStartsOnlyAQueuedTask: bool,
    wallClockFailsWithoutARestart: bool,
    aBridgeConnectsOnlyWithTheCurrentToken: bool,
    aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn: bool,
    theHelloTimeoutWaitsWhileItsStartIsOut: bool,
    aTaskWithoutAnEarlierPromptGetsTheTaskPrompt: bool,
  }

  /// For each witness that reads a step, whether the last step showed it. Each step writes it anew.
  type StepWitnesses = {
    aFinishedTaskIsInAStep: bool,
    aPausedAuthorStaysPaused: bool,
    aStaleAlarmFires: bool,
    aStopLandsDuringATurn: bool,
    aStopEndsAStartingTurn: bool,
    aLaterGenerationBegins: bool,
    aHelloMovesTheTaskToWorking: bool,
    anAuthorInReviewTakesAPrompt: bool,
    aLostTurnIsRecovered: bool,
    aLostTurnFailsTheTask: bool,
    aLostTurnOfATaskQueuedForARestart: bool,
    aHarnessExitRestartsTheTask: bool,
    aHarnessExitRestartsAnIdleAuthor: bool,
    aHarnessExitFailsTheTask: bool,
    aSandboxStartFails: bool,
    aStaleSandboxStartFails: bool,
    aSandboxStartFailsAtOnce: bool,
    aStaleSandboxStartFailsAtOnce: bool,
    aStaleRestartIsDropped: bool,
    aStaleOutcomeCheckIsDropped: bool,
    theHarnessRefusesAPrompt: bool,
    theProvisionAlarmFires: bool,
    theWallClockFailsATurn: bool,
    theWallClockFiresDuringARestart: bool,
    theKeepAliveFiresOnATurn: bool,
    aDialIsRefused: bool,
    aSocketIsReplaced: bool,
    aResumeLandsDuringACancelledTurn: bool,
    aPromptGoesOutDuringAnOutcomeCheck: bool,
    anEmptyTurnStopsEarly: bool,
    theAgentWakesAfterAnEmptyTurn: bool,
    anAnswerArrivesAfterItsRowWasCleared: bool,
    theEffortIsSet: bool,
    aCallWasDropped: bool,
    theInstanceRestartsWithoutACallOut: bool,
    anAlarmRunsAgainAfterARestart: bool,
    aHelloTimeoutFiresWhileItsStartIsOut: bool,
    aResumePromptIsChosen: bool,
    aStoppedTaskGetsTheTaskPrompt: bool,
    theAgentWakesForAnIdleHarness: bool,
    aRestartDropsTheSummarization: bool,
    aTaskLeftQueuedDuringItsBranchBinding: bool,
    theBranchBindingFails: bool,
    aSteerIsTaken: bool,
    aSteerRacesTheTurnEnd: bool,
    aRestartLandsWhileASteerIsOut: bool,
    aRestartCutsTheOutcomeCheckOfATurnThatTookAnInstruction: bool,
    aLostTurnReturnsATakenInstruction: bool,
  }
}

/// The harness session of one author whose stage asks for an effort or leaves the harness default.
module harnessSession {
  import harnessSessionTypes.*

  /// True when the stage asks for an effort the harness session does not hold at first.
  const ASKS_EFFORT: bool

  /// True when the agent pauses and resumes the author during its turns more often than any other
  /// step happens, so a resume lands while the cancel of the pause is out.
  const PAUSES_RUNNING_TURNS: bool

  /// True when nothing interrupts the work of an unfinished task before the first prompt goes out,
  /// so more samples reach the end of a turn and what follows it.
  const INTERRUPTS_AFTER_THE_FIRST_PROMPT: bool

  /// True when the stage gives the job its own branch, so the provision alarm writes the branch
  /// binding before it starts the sandbox.
  const BINDS_A_BRANCH: bool

  /// How often a task restarts before it fails.
  pure val MAX_RESTARTS: int = 2

  /// The most prompts a person sends in one trace.
  pure val MAX_PERSON_PROMPTS: int = 2

  /// The most faults one trace injects: dropped sockets, crashed sandboxes, harness exits and
  /// errors, failed starts, and restarts of the Durable Object.
  pure val MAX_FAULTS: int = 3

  pure val INITIAL_WORLD: World = {
    status: Queued,
    restarts: 0,
    paused: false,
    generation: 0,
    token: 0,
    session: false,
    hadPrompt: false,
    promptInFlight: false,
    nudged: false,
    stoppedEarly: false,
    turnText: false,
    openTodos: false,
    bridgeClosedAt: Unset,
    lastProgressAt: Recent,
    queue: List(),
    rpcs: List(),
    steers: Set(),
    artifact: false,
    helloSlot: Unarmed,
    noProgressSlot: Unarmed,
    wallSlot: Unarmed,
    keepAliveSlot: Unarmed,
    alarms: List({ id: 0, kind: Provision }),
    nextAlarm: 1,
    sockets: List(),
    bridges: List(),
    calls: List(),
    nextCall: 0,
    nextSerial: 0,
    promptsSent: 0,
    cancelsDelivered: 0,
    permissionsAsked: 0,
    permissionsWithAnAllowOption: 0,
    permissionsAllowed: 0,
    socketsClosed: 0,
    lostTurns: 0,
    stopsEnded: 0,
    answersToOtherRequests: 0,
    agentWakes: 0,
    eventsThatThrew: 0,
    personPrompts: 0,
    delivered: Set(),
    discarded: Set(),
    receivedTwice: 0,
    resumesChosen: 0,
    faults: 0,
    actions: 0,
    stopped: false,
  }

  var world: World
  var rulesKept: RulesKept
  var stepWitnesses: StepWitnesses

  /// A counter that model checking bounds: the actions taken so far. Every other counter, id and
  /// list of the world grows at most once per action.
  val actionsTaken: int = world.actions

  pure def isFinished(status: TaskStatus): bool = status == Cancelled or status == Failed

  pure def isListed(state: SocketState): bool = state == Connected or state == BridgeGone

  pure def listedSockets(w: World): int = w.sockets.select(socket => isListed(socket.state)).length()

  pure def connected(w: World): bool = listedSockets(w) > 0

  pure def handshakePending(w: World): bool =
    w.rpcs.select(row => row.purpose != Prompt and row.purpose != Steer).length() > 0

  pure def issued(before: World, after: World): bool = after.nextCall > before.nextCall

  pure def noCallOut(w: World): bool = w.calls.select(call => call.state == Out).length() == 0

  pure def bridgesOn(w: World, state: SocketState): Set[int] =
    w.sockets.foldl(Set(), (found, socket) =>
      if (socket.state == state) found.union(Set(socket.bridge)) else found)

  pure def changeBridges(w: World, reached: Set[int], change: Bridge => Bridge): World = {
    val changed = w.bridges.foldl({ index: 0, bridges: List() }, (progress, bridge) => {
      index: progress.index + 1,
      bridges: progress.bridges.append(if (reached.contains(progress.index)) change(bridge) else bridge),
    })
    { ...w, bridges: changed.bridges }
  }

  pure def changeSockets(w: World, change: Socket => Socket): World =
    { ...w, sockets: w.sockets.foldl(List(), (changed, socket) => changed.append(change(socket))) }

  pure def withoutSocketAt(w: World, removed: int): World = {
    val kept = w.sockets.foldl({ index: 0, sockets: List() }, (progress, socket) => {
      index: progress.index + 1,
      sockets: if (progress.index == removed) progress.sockets else progress.sockets.append(socket),
    })
    { ...w, sockets: kept.sockets }
  }

  /// True when the sandbox says the bridge process of the current generation runs.
  pure def bridgeRunning(w: World): bool =
    w.bridges.select(bridge => bridge.alive and bridge.generation == w.generation).length() > 0

  pure def bridgeProcessGone(w: World): bool = not(connected(w)) and not(bridgeRunning(w))

  pure def arm(w: World, kind: AlarmKind): World =
    { ...w, alarms: w.alarms.append({ id: w.nextAlarm, kind: kind }), nextAlarm: w.nextAlarm + 1 }

  pure def cancelSlot(w: World, slot: Slot): World = match slot {
    | Unarmed => w
    | Armed(id) => { ...w, alarms: w.alarms.select(alarm => alarm.id != id) }
  }

  pure def armHelloTimeout(w: World, generation: int): World = {
    val cancelled = cancelSlot(w, w.helloSlot)
    { ...arm(cancelled, HelloTimeout(generation)), helloSlot: Armed(cancelled.nextAlarm) }
  }

  pure def armNoProgress(w: World): World = {
    val cancelled = cancelSlot(w, w.noProgressSlot)
    {
      ...arm(cancelled, NoProgress(cancelled.generation)),
      noProgressSlot: Armed(cancelled.nextAlarm),
      lastProgressAt: Recent,
    }
  }

  pure def armWallClock(w: World): World = {
    val cancelled = cancelSlot(w, w.wallSlot)
    { ...arm(cancelled, WallClock), wallSlot: Armed(cancelled.nextAlarm) }
  }

  pure def armKeepAlive(w: World): World =
    if (w.keepAliveSlot != Unarmed) w
    else { ...arm(w, KeepAlive(w.generation)), keepAliveSlot: Armed(w.nextAlarm) }

  pure def clearTaskTimers(w: World): World = {
    val cancelled = cancelSlot(cancelSlot(cancelSlot(cancelSlot(w, w.noProgressSlot), w.wallSlot), w.helloSlot), w.keepAliveSlot)
    { ...cancelled, noProgressSlot: Unarmed, wallSlot: Unarmed, helloSlot: Unarmed, keepAliveSlot: Unarmed }
  }

  /// The harness session of `bridge` receives the person prompt a request carries. It counts a
  /// person prompt it already had.
  pure def receivePerson(w: World, bridge: int, carries: Carried): World = match carries {
    | NoPerson => w
    | Person(person) =>
      val again = w.bridges[bridge].received.contains(person)
      val received = changeBridges(w, Set(bridge), process => {
        ...process,
        received: process.received.union(Set(person)),
        inTurn: process.inTurn.union(Set(person)),
      })
      { ...received, receivedTwice: w.receivedTwice + (if (again) 1 else 0) }
  }

  /// Write a request that carries `carries` to every listed socket. Only a connected socket carries
  /// it to its bridge. A harness session receives the person prompt of a prompt as it reads it.
  pure def sendRequestCarrying(w: World, purpose: RpcPurpose, carries: Carried): World = {
    val id = w.nextSerial + 1
    val stored = {
      ...w,
      rpcs: w.rpcs.append({ id: id, purpose: purpose, serial: w.nextSerial }),
      nextSerial: w.nextSerial + 1,
    }
    val request = { id: id, purpose: purpose, cancelled: false, serial: w.nextSerial, carries: carries }
    bridgesOn(stored, Connected).fold(stored, (sent, bridge) => {
      val read = changeBridges(sent, Set(bridge), process => { ...process, requests: process.requests.append(request) })
      if (purpose == Prompt) receivePerson(read, bridge, carries) else read
    })
  }

  pure def sendRequest(w: World, purpose: RpcPurpose): World = sendRequestCarrying(w, purpose, NoPerson)

  /// The requests of a bridge other than its steers: its handshake and its prompts, in order.
  pure def turnRequests(bridge: Bridge): List[Request] = bridge.requests.select(request => request.purpose != Steer)

  /// Write `session/cancel` to every listed socket. A harness that runs a prompt cancels its turn.
  pure def sendCancel(w: World): World = {
    val reached = bridgesOn(w, Connected)
    val marked = changeBridges(w, reached, bridge => {
      val turn = turnRequests(bridge)
      if (turn.length() > 0 and turn[0].purpose == Prompt)
        { ...bridge, requests: bridge.requests.foldl(List(), (requests, request) =>
          requests.append(if (request.serial == turn[0].serial) { ...request, cancelled: true } else request)) }
      else bridge
    })
    { ...marked, cancelsDelivered: w.cancelsDelivered + reached.size() }
  }

  pure def issueCall(w: World, kind: CallKind, rest: List[Frame]): World =
    {
      ...w,
      calls: w.calls.append({ id: w.nextCall, kind: kind, state: Out, rest: rest }),
      nextCall: w.nextCall + 1,
    }

  /// `beginGeneration`: a new generation and bridge token, without the old harness session, rpc
  /// rows, keep alive and nudge.
  pure def beginGeneration(w: World): World = {
    val withoutKeepAlive = cancelSlot(w, w.keepAliveSlot)
    val generation = w.generation + 1
    val armed = armHelloTimeout(withoutKeepAlive, generation)
    {
      ...armed,
      status: Provisioning,
      generation: generation,
      token: w.token + 1,
      session: false,
      promptInFlight: false,
      keepAliveSlot: Unarmed,
      bridgeClosedAt: Unset,
      nudged: false,
      rpcs: List(),
      steers: Set(),
    }
  }

  /// `startSandbox`: the call is out until `sandboxStartReturns`. The start of the generation stays
  /// out until the event that awaited it ends.
  pure def startSandbox(w: World, rest: List[Frame]): World = {
    val begun = beginGeneration(w)
    issueCall(
      begun,
      SandboxStart({ generation: begun.generation, token: begun.token, launched: false }),
      List(StartEnds(begun.generation)).concat(rest),
    )
  }

  /// `sandboxStartInFlight`: the generations whose sandbox start this instance awaits. A restart
  /// of the Durable Object drops the calls that carry them.
  pure def startsOut(w: World): Set[int] =
    w.calls.foldl(Set(), (generations, call) =>
      if (call.state != Out) generations
      else call.rest.foldl(generations, (named, frame) => match frame {
        | StartEnds(generation) => named.union(Set(generation))
        | _ => named
      }))

  /// True while the sandbox provider has not returned a start of `generation` this instance awaits.
  pure def startCallOut(w: World, generation: int): bool =
    w.calls.select(call => call.state == Out and match call.kind {
      | SandboxStart(start) => start.generation == generation
      | _ => false
    }).length() > 0

  pure def restartSandbox(w: World, rest: List[Frame]): World =
    startSandbox({ ...w, status: Queued, restarts: w.restarts + 1 }, rest)

  /// `closeContainer`: close the listed sockets with 1000, forget the harness session, replace the
  /// token, and destroy the container.
  pure def closeContainer(w: World, rest: List[Frame]): World = {
    val closed = changeSockets(w, socket =>
      if (socket.state == Connected) { ...socket, state: ClosingContainer }
      else if (socket.state == BridgeGone) { ...socket, state: ClosingBridgeGone }
      else socket)
    issueCall(
      { ...closed, session: false, token: w.token + 1, socketsClosed: w.socketsClosed + listedSockets(w) },
      SandboxDestroy(w.generation),
      rest,
    )
  }

  /// The person prompts in the queue.
  pure def queuedPersons(w: World): Set[int] =
    w.queue.foldl(Set(), (persons, kind) => match kind {
      | PersonPrompt(person) => persons.union(Set(person))
      | _ => persons
    })

  /// `clearPromptQueue`: drop every queued prompt with its steer.
  pure def discardQueue(w: World): World =
    { ...w, queue: List(), steers: Set(), discarded: w.discarded.union(queuedPersons(w)) }

  /// `finishTask`: the status is written before the sandbox goes.
  pure def finishTask(w: World, status: TaskStatus, rest: List[Frame]): World =
    closeContainer(discardQueue(clearTaskTimers({ ...w, status: status })), rest)

  pure def failTask(w: World, rest: List[Frame]): World =
    if (isFinished(w.status)) w else finishTask(w, Failed, rest)

  pure def cancelTask(w: World): World =
    if (isFinished(w.status)) w else finishTask(w, Cancelled, List())

  /// `restartOrFailTask`: the restart is written before the old container goes, so a restart of
  /// the Durable Object during the destroy leaves the task queued for the start step. A paused
  /// task waits queued for its resume. A queued task already has its restart written and is left
  /// to it.
  pure def restartOrFailTask(w: World, rest: List[Frame]): World =
    if (isFinished(w.status) or w.status == Queued) w
    else if (w.restarts >= MAX_RESTARTS) failTask(w, rest)
    else {
      val restarting = { ...w, status: Queued, restarts: w.restarts + 1 }
      closeContainer(restarting, List(RestartAfterClose({ generation: w.generation, restarts: w.restarts })).concat(rest))
    }

  pure def steered(w: World, person: int): bool = w.steers.exists(row => row.person == person)

  pure def waits(w: World, kind: PromptKind): bool = match kind {
    | PersonPrompt(person) => not(steered(w, person))
    | _ => true
  }

  /// `peekPrompt`: the queued prompts that wait for the next turn. A steered person prompt does not.
  pure def waiting(w: World): List[PromptKind] = w.queue.select(kind => waits(w, kind))

  /// The queue without its oldest waiting prompt.
  pure def withoutFirstWaiting(w: World): World = {
    val kept = w.queue.foldl({ removed: false, queue: List() }, (progress, kind) =>
      if (not(progress.removed) and waits(w, kind)) { ...progress, removed: true }
      else { ...progress, queue: progress.queue.append(kind) })
    { ...w, queue: kept.queue }
  }

  /// `steerWaitingInstructions`: steer each waiting person prompt into the running turn of a
  /// harness session with an open bridge.
  pure def steerWaiting(w: World): World =
    if (not(w.session) or not(connected(w))) w
    else w.queue.foldl(w, (steering, kind) => match kind {
      | PersonPrompt(person) =>
        if (steered(steering, person)) steering
        else {
          val out = { ...steering, steers: steering.steers.union(Set({ person: person, rpc: steering.nextSerial + 1, status: SteerOut })) }
          sendRequestCarrying(out, Steer, Person(person))
        }
      | _ => steering
    })

  /// `sendPrompt`: the turn goes in flight. A person prompt it carries stays queued as taken. The
  /// person prompts that still wait are steered into the turn, and the turn arms its timers.
  pure def sendPrompt(w: World, carried: Carried): World =
    if (not(w.session)) w
    else {
      val inFlight = {
        ...w,
        promptInFlight: true,
        turnText: false,
        status: if (w.status == InReview) Working else w.status,
        promptsSent: w.promptsSent + 1,
      }
      val held = match carried {
        | NoPerson => inFlight
        | Person(person) =>
          { ...inFlight, steers: inFlight.steers.union(Set({ person: person, rpc: inFlight.nextSerial + 1, status: SteerTaken })) }
      }
      armKeepAlive(armWallClock(armNoProgress(steerWaiting(sendRequestCarrying(held, Prompt, carried)))))
    }

  /// Send the oldest waiting prompt. A person prompt goes held as taken, and any other leaves the queue.
  pure def sendWaitingHead(w: World): World = match waiting(w)[0] {
    | PersonPrompt(person) => sendPrompt(w, Person(person))
    | _ => sendPrompt(withoutFirstWaiting(w), NoPerson)
  }

  /// `sendFirstPrompt`: a task that had a first prompt before resumes, and takes the oldest waiting
  /// prompt as its wake text. A paused task keeps the first prompt at the head of its queue and
  /// does not take a wake.
  pure def sendFirstPrompt(w: World): World = {
    val resumes = w.hadPrompt
    val chosen = { ...w, hadPrompt: true, resumesChosen: if (resumes) w.resumesChosen + 1 else w.resumesChosen }
    if (chosen.paused) { ...chosen, queue: List(FirstPrompt).concat(chosen.queue) }
    else if (resumes and waiting(chosen).length() > 0) sendWaitingHead(chosen)
    else sendPrompt(chosen, NoPerson)
  }

  pure def wakeOrWait(w: World, rest: List[Frame]): World =
    if (w.session and w.bridgeClosedAt == Recent and not(bridgeProcessGone(w)))
      arm(w, RetryQueue(w.generation))
    else startSandbox(w, rest)

  pure def drainQueue(w: World, rest: List[Frame]): World =
    if (isFinished(w.status) or w.paused) w
    else if (w.promptInFlight) steerWaiting(w)
    else if (waiting(w).length() == 0) w
    else if (w.status == Provisioning or handshakePending(w)) w
    else if (connected(w) and w.session) sendWaitingHead(w)
    else if (connected(w)) w
    else wakeOrWait(w, rest)

  pure def promptTask(w: World, kind: PromptKind, rest: List[Frame]): World =
    if (isFinished(w.status)) w
    else {
      val queued = { ...w, queue: w.queue.append(kind) }
      if (queued.paused) queued else drainQueue(queued, rest)
    }

  pure def markAuthorInReview(w: World): World =
    if ((w.status == Working or w.status == Queued) and w.artifact and not(w.promptInFlight) and not(handshakePending(w)))
      { ...w, status: InReview }
    else w

  /// `settleAndResumeAuthor`: send what is queued, else the author waits in review. An author
  /// whose sandbox the drain woke is not idle, so it stays out of review whatever its start does.
  pure def settleAndResumeAuthor(w: World, rest: List[Frame]): World = {
    val drained = drainQueue(w, rest)
    if (issued(w, drained)) drained else markAuthorInReview(drained)
  }

  /// Settle the author, then wake the agent once the drain and any start it awaited end.
  pure def settleThenWake(w: World, summarizes: bool): World = {
    val wake = List(WakeTheAgent({ summarizes: summarizes }))
    goOn(w, settleAndResumeAuthor(w, wake), wake)
  }

  /// The agent wakes when the harness is idle. A turn text that needs a summarization waits on
  /// that model call first.
  pure def wakeTheAgent(w: World, summarizes: bool, rest: List[Frame]): World =
    if (w.promptInFlight) w
    else if (summarizes) issueCall(w, Summarization, rest)
    else { ...w, agentWakes: w.agentWakes + 1 }

  /// `recoverLostTurn`: a lost turn counts one restart. With restarts left, forget the lost turn
  /// and its harness session, so the queue wakes a fresh sandbox instead of a bridge that may still
  /// run the turn. Once its restarts are used up, the task fails. A task queued for a restart
  /// already has that restart written, so its lost turn does not count another one.
  pure def recoverLostTurn(w: World, rest: List[Frame]): World = {
    val counted = { ...w, lostTurns: w.lostTurns + 1 }
    val restartWritten = w.status == Queued
    if (not(restartWritten) and w.restarts >= MAX_RESTARTS) failTask(counted, rest)
    else {
      val cleared = {
        ...counted,
        restarts: if (restartWritten) w.restarts else w.restarts + 1,
        rpcs: List(),
        steers: Set(),
        promptInFlight: false,
        turnText: false,
        session: false,
      }
      val woken = if (cleared.queue.length() == 0) { ...cleared, queue: List(LostSandboxWake) } else cleared
      drainQueue(woken, rest)
    }
  }

  pure def nudgeOrRestartStalledTask(w: World, rest: List[Frame]): World =
    if (w.nudged) restartOrFailTask(w, rest)
    else {
      val queued = { ...w, queue: w.queue.append(NudgePrompt) }
      if (not(queued.promptInFlight)) { ...queued, nudged: true }
      else {
        val cancelled = if (queued.session) sendCancel(queued) else queued
        { ...arm(cancelled, NoProgress(cancelled.generation)), nudged: true, noProgressSlot: Armed(cancelled.nextAlarm) }
      }
    }

  /// A prompt in flight or a handshake waits on the bridge. Its loss is recovered.
  pure def waitsOnTheBridge(w: World): bool = w.promptInFlight or handshakePending(w)

  pure def onBridgeLostNow(w: World): World =
    if (not(waitsOnTheBridge(w)) or isFinished(w.status) or w.paused or connected(w)) w
    else recoverLostTurn(w, List())

  pure def onBridgeClosed(w: World, generation: int): World =
    if (generation != w.generation) w
    else {
      val closed = { ...w, bridgeClosedAt: Recent }
      if (not(waitsOnTheBridge(closed)) or isFinished(closed.status)) closed
      else if (bridgeProcessGone(closed)) onBridgeLostNow(closed)
      else arm(closed, BridgeLost(closed.generation))
    }

  pure def onBridgeHello(w: World, fresh: bool): World = {
    val greeted = { ...cancelSlot(w, w.helloSlot), helloSlot: Unarmed, bridgeClosedAt: Unset }
    val working = if (greeted.status == Provisioning) { ...greeted, status: Working } else greeted
    if (working.session and not(fresh)) drainQueue(working, List())
    else sendRequest({ ...working, rpcs: List(), steers: Set(), session: false, promptInFlight: false }, Initialize)
  }

  /// `onSessionNew`: the harness session opens. A stage that asks for an effort sets it first.
  pure def onSessionNew(w: World): World = {
    val opened = { ...w, session: true }
    if (ASKS_EFFORT) sendRequest(opened, SetEffort) else sendFirstPrompt(opened)
  }

  /// A turn that ends forgets whether the turn before it stopped early, and its text. Its own outcome
  /// says whether it did. A turn that ended on its own with text waits on the outcome check. One
  /// without text skips the check. Every text a harness prints is longer than the room the digest
  /// has for it, so the wake after a turn with text waits on its summarization.
  pure def onTurnEnd(w: World, stop: StopReason): World = {
    val stopped = { ...w, promptInFlight: false, stoppedEarly: false, turnText: false }
    val ended = if (stop == CancelledTurn) { ...stopped, steers: Set() } else dropTaken(stopped)
    if (stop != EndTurn) settleThenWake(ended, w.turnText)
    else if (w.turnText) issueCall(ended, OutcomeCheck({ promptsSent: ended.promptsSent, generation: ended.generation }), List())
    else onOutcome(ended, emptyTurnOutcome(ended), false)
  }

  /// `authorTurnOutcome` without a turn text: an author with open todos and without an artifact
  /// stopped early, and any other finished.
  pure def emptyTurnOutcome(w: World): Outcome =
    if (w.openTodos and not(w.artifact)) StoppedEarly else Finished

  /// The feed of an idle author closes on the stop reason of its turn. Without one the event throws.
  pure def closeFeedWithoutStopReason(w: World): World =
    if (w.promptInFlight) w else { ...w, eventsThatThrew: w.eventsThatThrew + 1 }

  /// `dropTakenPrompts`: the person prompts the turn took leave the queue, and the steered ones it
  /// did not take wait again.
  pure def dropTaken(w: World): World = {
    val taken = w.steers.filter(row => row.status == SteerTaken).map(row => row.person)
    val kept = w.queue.select(kind => match kind {
      | PersonPrompt(person) => not(taken.contains(person))
      | _ => true
    })
    { ...w, queue: kept, steers: Set() }
  }

  /// An answer to another request reaches a prompt row. The turn ends and settles like a turn
  /// without an outcome check, then the event throws if the author is idle.
  pure def endTurnWithoutStopReason(w: World): World = {
    val ended = dropTaken({ ...w, promptInFlight: false, stoppedEarly: false, turnText: false })
    val settled = settleAndResumeAuthor(ended, List(CloseFeedWithoutStopReason))
    if (issued(ended, settled)) settled else closeFeedWithoutStopReason(settled)
  }

  /// `stalledAtTurnEnd`: an author that stopped early stalled, unless a prompt is in flight or
  /// queued or its task finished. An author that restarts for it does not wake the agent.
  pure def settleStoppedEarlyAuthor(w: World, summarizes: bool): World =
    if (isFinished(w.status) or w.promptInFlight or w.queue.length() > 0) settleThenWake(w, summarizes)
    else if (w.nudged) restartOrFailTask(w, List())
    else settleThenWake(nudgeOrRestartStalledTask(w, List()), summarizes)

  /// A refused prompt of an author whose last turn stopped early counts as a stall.
  pure def onRpcError(w: World, purpose: RpcPurpose): World = match purpose {
    | Initialize => restartOrFailTask(w, List())
    | SessionNew => restartOrFailTask(w, List())
    | SetEffort => sendFirstPrompt(w)
    | Prompt =>
      val refused = dropTaken({ ...w, promptInFlight: false })
      if (refused.stoppedEarly) settleStoppedEarlyAuthor(refused, false) else settleThenWake(refused, false)
    | Steer => w
  }

  pure def onBridgeExit(w: World): World =
    if (isFinished(w.status)) w
    else if (w.restarts >= MAX_RESTARTS) failTask(w, List())
    else restartSandbox(w, List())

  pure def touchProgress(w: World): World = {
    val recent = w.noProgressSlot != Unarmed and w.lastProgressAt == Recent
    val armed = if (recent) w else armNoProgress(w)
    { ...armed, nudged: false }
  }

  /// One frame of the rest of an event after the call it waited on.
  pure def runFrame(w: World, frame: Frame, rest: List[Frame]): World = match frame {
    | StartEnds(_) => w
    | CloseFeedWithoutStopReason => closeFeedWithoutStopReason(w)
    | AlarmEnds(_) => w
    | WakeTheAgent(wake) => wakeTheAgent(w, wake.summarizes, rest)
    | RestartAfterClose(began) =>
      if (isFinished(w.status) or w.generation != began.generation or w.restarts != began.restarts + 1) w
      else if (w.paused) clearTaskTimers(w)
      else startSandbox(w, rest)
  }

  /// Run the frames in order until one sends a call. That call carries the frames after it.
  pure def runFrames(w: World, frames: List[Frame]): World = {
    val ran = frames.foldl({ world: w, waiting: false, remaining: frames }, (progress, frame) =>
      if (progress.waiting) progress
      else {
        val after = runFrame(progress.world, frame, progress.remaining.tail())
        { world: after, waiting: issued(progress.world, after), remaining: progress.remaining.tail() }
      })
    ran.world
  }

  /// Run the part of an event that follows a call, then its frames unless that part sent a call.
  pure def goOn(before: World, after: World, rest: List[Frame]): World =
    if (issued(before, after)) after else runFrames(after, rest)

  pure def callsWith(w: World, callId: int): List[Call] = w.calls.select(call => call.id == callId)

  pure def withoutCall(w: World, callId: int): World = { ...w, calls: w.calls.select(call => call.id != callId) }

  pure def launchBridge(w: World, generation: int, token: int): World =
    {
      ...w,
      bridges: w.bridges.append({
        generation: generation,
        token: token,
        alive: true,
        saidHello: false,
        requests: List(),
        received: Set(),
        inTurn: Set(),
      }),
    }

  /// The bridge process ends. Its connected socket is left to the orchestrator to close.
  pure def bridgeEnds(w: World, bridge: int): World = {
    val ended = changeBridges(w, Set(bridge), process => { ...process, alive: false })
    changeSockets(ended, socket =>
      if (socket.bridge != bridge) socket
      else if (socket.state == Connected) { ...socket, state: BridgeGone }
      else if (socket.state == ClosingReplaced or socket.state == ClosingContainer) { ...socket, state: ClosingBridgeGone }
      else socket)
  }

  /// The container of the task goes. Every bridge up to `generation` ends with it.
  pure def containerGoes(w: World, generation: int): World =
    w.bridges.indices().filter(index => w.bridges[index].alive and w.bridges[index].generation <= generation)
      .fold(w, (gone, index) => bridgeEnds(gone, index))

  pure def connectedSocketsOf(w: World, bridge: int): List[Socket] =
    w.sockets.select(socket => socket.bridge == bridge and socket.state == Connected)

  /// A bridge that holds a connected socket and has a harness turn running.
  pure def runsATurn(w: World, bridge: int): bool = and {
    w.bridges[bridge].alive,
    connectedSocketsOf(w, bridge).length() > 0,
    turnRequests(w.bridges[bridge]).length() > 0,
    turnRequests(w.bridges[bridge])[0].purpose == Prompt,
  }

  /// True when the frame a bridge sends lands on a socket of the current generation.
  pure def served(w: World, bridge: int): bool =
    connectedSocketsOf(w, bridge).select(socket => socket.generation == w.generation).length() > 0

  pure def withoutRequest(w: World, bridge: int, answered: Request): World =
    changeBridges(w, Set(bridge), process =>
      { ...process, requests: process.requests.select(request => request.serial != answered.serial) })

  /// The harness turn of `bridge` ends. A turn that ended without a cancel delivered the person
  /// prompts it received. A cancelled turn did not, so its harness session may receive them again.
  pure def endHarnessTurn(w: World, bridge: int, cancelled: bool): World = {
    val inTurn = w.bridges[bridge].inTurn
    val ended = changeBridges(w, Set(bridge), process => {
      ...process,
      received: if (cancelled) process.received.exclude(inTurn) else process.received,
      inTurn: Set(),
    })
    { ...ended, delivered: if (cancelled) w.delivered else w.delivered.union(inTurn) }
  }

  /// A harness turn runs: a prompt is in flight and a connected bridge of the task works on one.
  pure def turnRunning(w: World): bool =
    w.promptInFlight and w.bridges.indices().exists(bridge => runsATurn(w, bridge))

  /// The turn of the author is running or about to start.
  pure def atWork(w: World): bool =
    w.status == Queued or w.status == Provisioning or w.promptInFlight or handshakePending(w)

  pure def sentPrompt(step: Step): bool = step.after.promptsSent > step.before.promptsSent

  pure def sentCancel(step: Step): bool = step.after.cancelsDelivered > step.before.cancelsDelivered

  pure def endedAStop(step: Step): bool = step.after.stopsEnded > step.before.stopsEnded

  pure def handledALostTurn(step: Step): bool = step.after.lostTurns > step.before.lostTurns

  pure def closedASocket(step: Step): bool = step.after.socketsClosed > step.before.socketsClosed

  pure def openedASocket(step: Step): bool = step.after.sockets.length() > step.before.sockets.length()

  pure def changedBesidesAlarms(step: Step): bool =
    { ...step.before, alarms: step.after.alarms, actions: step.after.actions } != step.after

  /// A finished task never changes status again.
  pure def finishedTaskKeepsItsStatusIn(step: Step): bool =
    isFinished(step.before.status) implies step.after.status == step.before.status

  /// The workflow sends a paused author no prompt until it resumes.
  pure def pausedAuthorGetsNoPromptIn(step: Step): bool =
    (step.before.paused and step.after.paused) implies not(sentPrompt(step))

  /// An alarm armed for an older generation of the task changes nothing but its own schedule row.
  pure def staleAlarmIsIgnoredIn(step: Step): bool =
    step.kind == StaleAlarmStep implies not(changedBesidesAlarms(step))

  /// A stop drops the queued prompts. It cancels a running turn. Once its work ran to the end, the
  /// author does not resume unless its task finished.
  pure def stopEndsTheAuthorsTurnIn(step: Step): bool = and {
    step.kind == StopStep implies step.after.queue.length() == 0,
    (step.kind == StopStep and turnRunning(step.before)) implies sentCancel(step),
    (step.kind == StopStep and not(turnRunning(step.before)) and not(issued(step.before, step.after))) implies
      (not(atWork(step.after)) or isFinished(step.after.status)),
    endedAStop(step) implies (not(atWork(step.after)) or isFinished(step.after.status)),
  }

  /// T4. A sandbox start moves the task to provisioning in the next generation with a
  /// new bridge token. The harness session, the prompt in flight, the rpc rows, the nudge, the keep
  /// alive and the time of the last bridge close are cleared, and the hello timeout of the new
  /// generation is armed. A stop also begins a new generation, without a start.
  pure def aSandboxStartBeginsAFreshGenerationIn(step: Step): bool =
    (step.after.generation != step.before.generation and step.kind != StopStep) implies and {
      step.after.generation == step.before.generation + 1,
      step.after.status == Provisioning,
      step.after.token > step.before.token,
      not(step.after.session),
      not(step.after.promptInFlight),
      step.after.rpcs.length() == 0,
      not(step.after.nudged),
      step.after.keepAliveSlot == Unarmed,
      step.after.bridgeClosedAt == Unset,
      match step.after.helloSlot {
        | Armed(id) => step.after.alarms.select(alarm => alarm.id == id and alarm.kind == HelloTimeout(step.after.generation)).length() == 1
        | Unarmed => false
      },
    }

  /// T5. A provisioning task becomes working only when its bridge says hello, or when a
  /// stop ends the turn it was starting.
  pure def aStartingTaskWorksOnlyAfterItsHelloIn(step: Step): bool =
    (step.before.status == Provisioning and step.after.status == Working) implies
      (step.kind == HelloStep or endedAStop(step))

  /// T19. An author in review becomes working only in a step that sends it a prompt.
  pure def anAuthorInReviewWorksOnlyWithAPromptIn(step: Step): bool =
    (step.before.status == InReview and step.after.status == Working) implies sentPrompt(step)

  /// T21. A lost turn counts one restart, and the task recovers it in a fresh harness session. A
  /// lost turn on a task whose restarts are used up fails the task. A task queued for a restart
  /// already counted it, so its lost turn does not count another one.
  pure def aLostTurnCountsOneRestartIn(step: Step): bool =
    handledALostTurn(step) implies (
      if (step.before.status == Queued) and {
        step.after.restarts == step.before.restarts,
        not(step.after.session),
        not(step.after.promptInFlight),
      }
      else if (step.before.restarts < MAX_RESTARTS) and {
        step.after.restarts == step.before.restarts + 1,
        not(step.after.session),
        not(step.after.promptInFlight),
      }
      else step.after.status == Failed
    )

  /// T22. A harness exit on an unfinished task with restarts left counts one restart and
  /// starts the next generation, also when the author was idle in review. An author that had its
  /// first prompt keeps it, so the harness session of that generation resumes the author. The
  /// orchestrator does not close a socket for it. A harness exit on a task whose restarts are used
  /// up fails the task.
  pure def aHarnessExitCountsOneRestartIn(step: Step): bool =
    (step.kind == ExitStep and not(isFinished(step.before.status))) implies (
      if (step.before.restarts < MAX_RESTARTS) and {
        step.after.restarts == step.before.restarts + 1,
        step.after.generation == step.before.generation + 1,
        step.after.hadPrompt == step.before.hadPrompt,
        not(closedASocket(step)),
      }
      else step.after.status == Failed
    )

  /// T23. A sandbox start of the current generation that throws on an unfinished task
  /// fails it, or closes its container to restart it. One that throws on a task already queued
  /// for a restart changes nothing, and neither does one of an older generation.
  pure def aFailedSandboxStartRestartsOrFailsIn(step: Step): bool = match step.kind {
    | StartFailedStep(failure) =>
      val generation = failure.generation
      if (generation != step.before.generation or step.before.status == Queued) and {
        step.after.status == step.before.status,
        step.after.restarts == step.before.restarts,
        step.after.generation == step.before.generation,
      }
      else not(isFinished(step.before.status)) implies or {
        step.after.status == Failed,
        and {
          issued(step.before, step.after),
          step.after.calls.select(call => call.id == step.after.nextCall - 1 and call.rest.length() > 0 and call.rest[0] == RestartAfterClose({ generation: generation, restarts: step.before.restarts })).length() == 1,
        },
      }
    | _ => true
  }

  /// T29. A prompt the harness refuses is no longer in flight, unless the next prompt
  /// went out in the same step.
  pure def aRefusedPromptLeavesTheTurnIn(step: Step): bool =
    step.kind == PromptRefusedStep implies (not(step.after.promptInFlight) or sentPrompt(step))

  /// T40. The provision alarm starts a sandbox only for a queued task. The return of its branch
  /// binding write leaves a task that left queued while the write was out as it is.
  pure def provisionStartsOnlyAQueuedTaskIn(step: Step): bool =
    step.before.status != Queued implies match step.kind {
      | ProvisionStep => not(changedBesidesAlarms(step))
      | BranchBindingReturnStep =>
        { ...step.before, calls: step.after.calls, faults: step.after.faults, actions: step.after.actions } == step.after
      | _ => true
    }

  /// T42. The wall clock fails a task whose turn is in flight, without a restart.
  pure def wallClockFailsWithoutARestartIn(step: Step): bool =
    (step.kind == WallClockStep and step.before.promptInFlight and not(step.before.paused) and not(isFinished(step.before.status))) implies
      (step.after.status == Failed and step.after.restarts == step.before.restarts)

  /// T50. A bridge connects only with the task's current token, and its socket is then
  /// the only one the task lists.
  pure def aBridgeConnectsOnlyWithTheCurrentTokenIn(step: Step): bool =
    openedASocket(step) implies and {
      step.after.sockets.length() > 0,
      step.after.bridges[step.after.sockets[step.after.sockets.length() - 1].bridge].token == step.before.token,
      listedSockets(step.after) <= 1,
    }

  /// T26. A turn outcome does not restart or fail the author while a prompt sent after
  /// that turn ended is in flight.
  pure def aLaterPromptSurvivesTheOutcomeOfAnEarlierTurnIn(step: Step): bool =
    step.kind == OutcomeStep({ laterPromptInFlight: true }) implies and {
      step.after.restarts == step.before.restarts,
      step.after.status == Failed implies step.before.status == Failed,
      not(issued(step.before, step.after)),
    }

  /// T43. The hello timeout of the current generation does not restart, fail or move the
  /// task while the sandbox start of that generation is out. The end of an older start does not end
  /// the wait.
  pure def theHelloTimeoutWaitsWhileItsStartIsOutIn(step: Step): bool =
    (step.kind == HelloTimeoutStep and startCallOut(step.before, step.before.generation)) implies and {
      step.after.status == step.before.status,
      step.after.restarts == step.before.restarts,
      step.after.generation == step.before.generation,
      not(issued(step.before, step.after)),
    }

  /// A task that never had a first prompt gets the task prompt as its first prompt, also after a
  /// stop or a restart began a later generation.
  pure def aTaskWithoutAnEarlierPromptGetsTheTaskPromptIn(step: Step): bool =
    step.after.resumesChosen > step.before.resumesChosen implies step.before.hadPrompt

  /// Whether one step kept each before-and-after rule.
  pure def rulesKeptIn(step: Step): RulesKept = {
    finishedTaskKeepsItsStatus: finishedTaskKeepsItsStatusIn(step),
    pausedAuthorGetsNoPrompt: pausedAuthorGetsNoPromptIn(step),
    staleAlarmIsIgnored: staleAlarmIsIgnoredIn(step),
    stopEndsTheAuthorsTurn: stopEndsTheAuthorsTurnIn(step),
    aSandboxStartBeginsAFreshGeneration: aSandboxStartBeginsAFreshGenerationIn(step),
    aStartingTaskWorksOnlyAfterItsHello: aStartingTaskWorksOnlyAfterItsHelloIn(step),
    anAuthorInReviewWorksOnlyWithAPrompt: anAuthorInReviewWorksOnlyWithAPromptIn(step),
    aLostTurnCountsOneRestart: aLostTurnCountsOneRestartIn(step),
    aHarnessExitCountsOneRestart: aHarnessExitCountsOneRestartIn(step),
    aFailedSandboxStartRestartsOrFails: aFailedSandboxStartRestartsOrFailsIn(step),
    aRefusedPromptLeavesTheTurn: aRefusedPromptLeavesTheTurnIn(step),
    provisionStartsOnlyAQueuedTask: provisionStartsOnlyAQueuedTaskIn(step),
    wallClockFailsWithoutARestart: wallClockFailsWithoutARestartIn(step),
    aBridgeConnectsOnlyWithTheCurrentToken: aBridgeConnectsOnlyWithTheCurrentTokenIn(step),
    aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn: aLaterPromptSurvivesTheOutcomeOfAnEarlierTurnIn(step),
    theHelloTimeoutWaitsWhileItsStartIsOut: theHelloTimeoutWaitsWhileItsStartIsOutIn(step),
    aTaskWithoutAnEarlierPromptGetsTheTaskPrompt: aTaskWithoutAnEarlierPromptGetsTheTaskPromptIn(step),
  }

  /// Whether a sandbox start of the current generation, or of an older one, failed for an unfinished task.
  pure def failedASandboxStart(step: Step, current: bool): bool = match step.kind {
    | StartFailedStep(failure) =>
      (failure.generation == step.before.generation) == current and not(isFinished(step.before.status))
    | _ => false
  }

  /// Whether a sandbox start of the current generation, or of an older one, failed at once for an
  /// unfinished task.
  pure def failedASandboxStartAtOnce(step: Step, current: bool): bool = match step.kind {
    | StartFailedStep(failure) => failure.atOnce and failedASandboxStart(step, current)
    | _ => false
  }

  /// Whether a step dropped the restart of an unfinished task whose container closed after another
  /// restart or a newer generation.
  pure def droppedAStaleRestart(step: Step): bool = and {
    step.kind == OtherStep,
    not(isFinished(step.before.status)),
    step.before.calls.foldl(false, (dropped, call) => dropped or and {
      call.state == Out,
      isDestroy(call.kind),
      staleRestartAfter(step.before, call),
      callsWith(step.after, call.id).length() == 0,
    }),
  }

  /// Whether a step dropped the outcome check of a turn of an older generation.
  pure def droppedAStaleOutcomeCheck(step: Step): bool = match step.kind {
    | OutcomeStep(_) =>
      step.before.calls.foldl(false, (dropped, call) => dropped or and {
        isOutcomeCheck(call.kind),
        generationOfCall(step.before, call.id) != step.before.generation,
        callsWith(step.after, call.id).length() == 0,
      })
    | _ => false
  }

  /// Whether one step showed each witness that reads a step.
  pure def stepWitnessesOf(step: Step): StepWitnesses = {
    aFinishedTaskIsInAStep: isFinished(step.before.status),
    aPausedAuthorStaysPaused: step.before.paused and step.after.paused,
    aStaleAlarmFires: step.kind == StaleAlarmStep,
    aStopLandsDuringATurn: step.kind == StopStep and turnRunning(step.before),
    aStopEndsAStartingTurn: endedAStop(step),
    aLaterGenerationBegins: step.after.generation > 1 and step.after.generation != step.before.generation,
    aHelloMovesTheTaskToWorking:
      step.kind == HelloStep and step.before.status == Provisioning and step.after.status == Working,
    anAuthorInReviewTakesAPrompt: step.before.status == InReview and step.after.status == Working,
    aLostTurnIsRecovered:
      handledALostTurn(step) and step.before.status != Queued and step.before.restarts < MAX_RESTARTS,
    aLostTurnFailsTheTask:
      handledALostTurn(step) and step.before.status != Queued and step.before.restarts >= MAX_RESTARTS,
    aLostTurnOfATaskQueuedForARestart: handledALostTurn(step) and step.before.status == Queued,
    aHarnessExitRestartsTheTask:
      step.kind == ExitStep and not(isFinished(step.before.status)) and step.before.restarts < MAX_RESTARTS,
    aHarnessExitRestartsAnIdleAuthor: and {
      step.kind == ExitStep,
      step.before.status == InReview,
      not(atWork(step.before)),
      step.before.restarts < MAX_RESTARTS,
    },
    aHarnessExitFailsTheTask:
      step.kind == ExitStep and not(isFinished(step.before.status)) and step.before.restarts >= MAX_RESTARTS,
    aSandboxStartFails: failedASandboxStart(step, true),
    aStaleSandboxStartFails: failedASandboxStart(step, false),
    aSandboxStartFailsAtOnce: failedASandboxStartAtOnce(step, true),
    aStaleSandboxStartFailsAtOnce: failedASandboxStartAtOnce(step, false),
    aStaleRestartIsDropped: droppedAStaleRestart(step),
    aStaleOutcomeCheckIsDropped: droppedAStaleOutcomeCheck(step),
    theHarnessRefusesAPrompt: step.kind == PromptRefusedStep,
    theProvisionAlarmFires: step.kind == ProvisionStep,
    theWallClockFailsATurn:
      step.kind == WallClockStep and step.before.promptInFlight and step.after.status == Failed,
    theWallClockFiresDuringARestart:
      step.kind == WallClockStep and step.before.status == Queued and step.before.promptInFlight and not(step.before.paused),
    theKeepAliveFiresOnATurn: step.kind == KeepAliveStep and step.before.promptInFlight,
    aDialIsRefused: step.kind == DialStep,
    aSocketIsReplaced: step.kind == HelloStep and listedSockets(step.before) > 0,
    aResumeLandsDuringACancelledTurn:
      step.before.paused and not(step.after.paused) and turnRunning(step.before),
    aPromptGoesOutDuringAnOutcomeCheck:
      sentPrompt(step) and outCalls(step.after, isOutcomeCheck).size() > 0,
    anEmptyTurnStopsEarly:
      step.kind == EmptyTurnEndStep and step.after.stoppedEarly and not(isFinished(step.before.status)),
    theAgentWakesAfterAnEmptyTurn: step.kind == EmptyTurnEndStep and step.after.agentWakes > step.before.agentWakes,
    anAnswerArrivesAfterItsRowWasCleared: match step.kind {
      | AnswerStep(answer) => not(answer.reachedItsOwnRow)
      | _ => false
    },
    theEffortIsSet:
      step.kind == AnswerStep({ reachedItsOwnRow: true, purpose: SetEffort }) and sentPrompt(step),
    aCallWasDropped: step.kind == DurableObjectRestartStep and not(noCallOut(step.before)),
    theInstanceRestartsWithoutACallOut: step.kind == DurableObjectRestartStep and noCallOut(step.before),
    anAlarmRunsAgainAfterARestart:
      step.kind == DurableObjectRestartStep and
        step.before.calls.select(call => call.state == Out and alarmsAwaiting(call).length() > 0).length() > 0,
    aHelloTimeoutFiresWhileItsStartIsOut:
      step.kind == HelloTimeoutStep and step.before.status == Provisioning and startCallOut(step.before, step.before.generation),
    aResumePromptIsChosen: step.after.resumesChosen > step.before.resumesChosen,
    aStoppedTaskGetsTheTaskPrompt:
      not(step.before.hadPrompt) and step.after.hadPrompt and step.after.generation > 1 and step.after.restarts == 0,
    theAgentWakesForAnIdleHarness: step.after.agentWakes > step.before.agentWakes,
    aRestartDropsTheSummarization:
      step.kind == DurableObjectRestartStep and outCalls(step.before, isSummarization).size() > 0,
    aTaskLeftQueuedDuringItsBranchBinding:
      step.kind == BranchBindingReturnStep and step.before.status != Queued,
    theBranchBindingFails: step.kind == BranchBindingReturnStep and step.after.faults > step.before.faults,
    aSteerIsTaken: step.kind == SteerAnswerStep({ injected: true, reachedItsRow: true }),
    aSteerRacesTheTurnEnd: step.kind == SteerAnswerStep({ injected: false, reachedItsRow: true }),
    aRestartLandsWhileASteerIsOut:
      step.kind == DurableObjectRestartStep and step.before.steers.exists(row => row.status == SteerOut),
    aRestartCutsTheOutcomeCheckOfATurnThatTookAnInstruction: and {
      step.kind == DurableObjectRestartStep,
      outCalls(step.before, isOutcomeCheck).size() > 0,
      step.before.delivered.size() > 0,
    },
    aLostTurnReturnsATakenInstruction:
      handledALostTurn(step) and step.before.steers.exists(row => row.status == SteerTaken),
  }

  /// Write the world after a step, and which rules and witnesses that step kept and showed.
  action recordStep(step: Step): bool = all {
    world' = step.after,
    rulesKept' = rulesKeptIn(step),
    stepWitnesses' = stepWitnessesOf(step),
  }

  /// Take one action from the current world and count it.
  action move(after: World, kind: StepKind): bool =
    recordStep({ before: world, after: { ...after, actions: world.actions + 1 }, kind: kind })

  /// A queued task before any action.
  action init: bool = {
    val step = { before: INITIAL_WORLD, after: INITIAL_WORLD, kind: OtherStep }
    all {
      world' = INITIAL_WORLD,
      rulesKept' = rulesKeptIn(step),
      stepWitnesses' = stepWitnessesOf(step),
    }
  }

  /// A person instructs the author: a reply in its job session, or an instruct command. A finished
  /// task drops it.
  action personPrompts: bool = all {
    world.personPrompts < MAX_PERSON_PROMPTS,
    val person = world.personPrompts
    val prompted = { ...world, personPrompts: person + 1, stopped: false }
    move(
      if (isFinished(world.status)) { ...prompted, discarded: prompted.discarded.union(Set(person)) }
      else promptTask(prompted, PersonPrompt(person), List()),
      OtherStep,
    ),
  }

  /// The agent calls `pause_task`. The tool refuses a finished task.
  action agentPausesAuthor: bool = all {
    not(isFinished(world.status)),
    if (world.paused) move(world, OtherStep)
    else {
      val paused = { ...world, paused: true }
      move(if (paused.session and paused.promptInFlight) sendCancel(paused) else paused, OtherStep)
    },
  }

  /// The agent calls `resume_task` without a text. The tool refuses a finished task. The continue
  /// prompt waits for the answer to a turn the pause cancelled. A prompt or a handshake whose
  /// bridge was lost during the pause is recovered.
  action agentResumesAuthor: bool = all {
    not(isFinished(world.status)),
    if (not(world.paused)) move(world, OtherStep)
    else move(onBridgeLostNow(promptTask({ ...world, paused: false, stopped: false }, ContinuePrompt, List())), OtherStep),
  }

  /// `endResumingTurn`: the stopped state is written before the container goes.
  pure def endStoppedTurn(w: World): World = {
    val starting = w.status == Queued or w.status == Provisioning
    {
      ...w,
      rpcs: List(),
      steers: Set(),
      promptInFlight: false,
      turnText: false,
      status: if (starting) Working else w.status,
      generation: w.generation + 1,
      stopsEnded: if (atWork(w)) w.stopsEnded + 1 else w.stopsEnded,
    }
  }

  /// A person presses Stop in the job session of the author. A running turn gets a cancel. The stop
  /// ends the generation of an unfinished author, also an idle one, and closes its container even
  /// when the cancel is lost.
  action personStops: bool = {
    val cleared = { ...discardQueue(world), stoppedEarly: false, stopped: true }
    val cancelled = if (connected(cleared) and cleared.session and cleared.promptInFlight) sendCancel(cleared) else cleared
    if (not(isFinished(cancelled.status)))
      move(closeContainer(endStoppedTurn(clearTaskTimers(cancelled)), List()), StopStep)
    else move(cancelled, StopStep)
  }

  /// The agent calls `cancel_job`. The tool refuses a finished task.
  action agentCancelsJob: bool = all {
    not(isFinished(world.status)),
    move(cancelTask(world), OtherStep),
  }

  pure def isStale(w: World, kind: AlarmKind): bool = match kind {
    | Provision => false
    | WallClock => false
    | HelloTimeout(generation) => generation != w.generation
    | NoProgress(generation) => generation != w.generation
    | KeepAlive(generation) => generation != w.generation
    | RetryQueue(generation) => generation != w.generation
    | SettleIdleAuthor(generation) => generation != w.generation
    | BridgeLost(generation) => generation != w.generation
  }

  pure def onAlarm(w: World, kind: AlarmKind): World = match kind {
    | Provision =>
      if (w.status != Queued) w
      else if (BINDS_A_BRANCH) issueCall(w, BranchBinding, List())
      else startSandbox(w, List())
    | HelloTimeout(_) =>
      if (w.status != Provisioning) w
      else if (startsOut(w).contains(w.generation)) { ...arm(w, HelloTimeout(w.generation)), helloSlot: Armed(w.nextAlarm) }
      else restartOrFailTask(w, List())
    | NoProgress(_) =>
      if (not(w.promptInFlight) or isFinished(w.status) or w.paused) w
      else if (not(connected(w))) recoverLostTurn(w, List())
      else nudgeOrRestartStalledTask(w, List())
    | WallClock =>
      if (not(w.promptInFlight) or isFinished(w.status) or w.paused) w
      else failTask(w, List())
    | KeepAlive(generation) =>
      if (not(w.promptInFlight) or isFinished(w.status)) { ...w, keepAliveSlot: Unarmed }
      else { ...arm(w, KeepAlive(generation)), keepAliveSlot: Armed(w.nextAlarm) }
    | RetryQueue(_) => drainQueue(w, List())
    | SettleIdleAuthor(_) => if (w.status != Working or w.promptInFlight) w else settleAndResumeAuthor(w, List())
    | BridgeLost(_) => onBridgeLostNow(w)
  }

  pure def alarmStep(w: World, kind: AlarmKind): StepKind =
    if (isStale(w, kind)) StaleAlarmStep
    else match kind {
      | Provision => ProvisionStep
      | WallClock => WallClockStep
      | HelloTimeout(_) => HelloTimeoutStep
      | KeepAlive(_) => KeepAliveStep
      | _ => OtherStep
    }

  /// An armed alarm fires. Its schedule row goes before its handler runs.
  action alarmFires: bool = all {
    world.alarms.length() > 0,
    nondet alarmIndex = world.alarms.indices().oneOf()
    val alarm = world.alarms[alarmIndex]
    val fired = { ...world, alarms: world.alarms.select(armed => armed.id != alarm.id) }
    val handled = if (isStale(fired, alarm.kind)) fired else onAlarm(fired, alarm.kind)
    move(untilAlarmEnds(fired, handled, alarm), alarmStep(fired, alarm.kind)),
  }

  /// A handler that awaits a call ends with the frames after that call.
  pure def untilAlarmEnds(fired: World, handled: World, alarm: Alarm): World =
    if (not(issued(fired, handled))) handled
    else {
      ...handled,
      calls: handled.calls.foldl(List(), (calls, call) =>
        calls.append(if (call.id == handled.nextCall - 1) { ...call, rest: call.rest.append(AlarmEnds(alarm)) } else call)),
    }

  /// True when `call` closes a container to restart a task that has since restarted or begun a
  /// newer generation.
  pure def staleRestartAfter(w: World, call: Call): bool =
    call.rest.length() > 0 and match call.rest[0] {
      | RestartAfterClose(began) => began.generation != w.generation or began.restarts + 1 != w.restarts
      | _ => false
    }

  /// The alarms whose handlers awaited `call`. A restart loses the handler, so the alarm runs again.
  pure def alarmsAwaiting(call: Call): List[Alarm] =
    call.rest.foldl(List(), (alarms, frame) => match frame {
      | AlarmEnds(alarm) => alarms.append(alarm)
      | _ => alarms
    })

  /// The clock moves past the reconnect ceiling and the progress window.
  action timePasses: bool = all {
    world.bridgeClosedAt == Recent or world.lastProgressAt == Recent,
    move({
      ...world,
      bridgeClosedAt: if (world.bridgeClosedAt == Recent) Old else world.bridgeClosedAt,
      lastProgressAt: Old,
    }, OtherStep),
  }

  /// `provisionQueuedTasks` and `settleIdleAuthors`: the start step of a new instance arms the
  /// provision alarm of an unpaused queued task and the settle alarm of a working author with no
  /// prompt in flight.
  pure def startStep(w: World): World =
    if (w.status == Queued and not(w.paused)) arm(w, Provision)
    else if (w.status == Working and not(w.promptInFlight)) arm(w, SettleIdleAuthor(w.generation))
    else w

  /// The Durable Object restarts, with or without a call out. The calls out are lost with the
  /// isolate. A destroy that was out still takes the container. A start that was out may still
  /// bring its container up. An alarm whose handler awaited a lost call is scheduled again, because
  /// its row is deleted only when the handler ends. Then the start step runs.
  action durableObjectRestarts: bool = all {
    world.faults < MAX_FAULTS,
    val lost = world.calls.foldl({ ...world, calls: List(), faults: world.faults + 1 }, (restarted, call) =>
      if (call.state != Out) { ...restarted, calls: restarted.calls.append(call) }
      else {
        val rescheduled = { ...restarted, alarms: restarted.alarms.concat(alarmsAwaiting(call)) }
        match call.kind {
          | SandboxDestroy(generation) => containerGoes(rescheduled, generation)
          | SandboxStart(start) =>
            if (start.launched) rescheduled
            else { ...rescheduled, calls: rescheduled.calls.append({ ...call, state: Dropped, rest: List() }) }
          | OutcomeCheck(_) => rescheduled
          | Summarization => rescheduled
          | BranchBinding => rescheduled
        }
      })
    move(startStep(lost), DurableObjectRestartStep),
  }

  pure def unlaunchedStarts(w: World): Set[int] =
    w.calls.foldl(Set(), (ids, call) => match call.kind {
      | SandboxStart(start) => if (start.launched) ids else ids.union(Set(call.id))
      | _ => ids
    })

  /// The container of a start comes up and its bridge runs. A dropped start then leaves the list.
  pure def launched(w: World, callId: int): World =
    callsWith(w, callId).foldl(w, (up, call) => match call.kind {
      | SandboxStart(start) =>
        if (start.launched) up
        else {
          val running = launchBridge(up, start.generation, start.token)
          if (call.state == Dropped) withoutCall(running, callId)
          else {
            ...running,
            calls: running.calls.foldl(List(), (calls, other) =>
              calls.append(if (other.id == callId) { ...other, kind: SandboxStart({ ...start, launched: true }) } else other)),
          }
        }
      | _ => up
    })

  /// The container of a start comes up and runs its bridge before the start returns. A start a
  /// restart of the Durable Object dropped may still come up.
  action sandboxStartLaunchesBridge: bool = all {
    unlaunchedStarts(world).size() > 0,
    nondet callId = unlaunchedStarts(world).oneOf()
    move(launched(world, callId), OtherStep),
  }

  pure def isStart(kind: CallKind): bool = match kind {
    | SandboxStart(_) => true
    | _ => false
  }

  pure def isDestroy(kind: CallKind): bool = match kind {
    | SandboxDestroy(_) => true
    | _ => false
  }

  pure def isOutcomeCheck(kind: CallKind): bool = match kind {
    | OutcomeCheck(_) => true
    | _ => false
  }

  pure def isBranchBinding(kind: CallKind): bool = match kind {
    | BranchBinding => true
    | _ => false
  }

  pure def isSummarization(kind: CallKind): bool = match kind {
    | Summarization => true
    | _ => false
  }

  pure def outCalls(w: World, isKind: CallKind => bool): Set[int] =
    w.calls.foldl(Set(), (ids, call) => if (call.state == Out and isKind(call.kind)) ids.union(Set(call.id)) else ids)

  pure def restOf(w: World, callId: int): List[Frame] =
    callsWith(w, callId).foldl(List(), (rest, call) => call.rest)

  /// The sandbox provider returns from a start. A start that returns has its bridge running. One
  /// of the current generation that throws restarts or fails the task.
  action sandboxStartReturns: bool = all {
    outCalls(world, isStart).size() > 0,
    nondet callId = outCalls(world, isStart).oneOf()
    nondet ok = Set(true, false).oneOf()
    all {
      ok or world.faults < MAX_FAULTS,
      val rest = restOf(world, callId)
      if (ok) {
        val up = withoutCall(launched(world, callId), callId)
        val armed = armHelloTimeout(up, up.generation)
        move(goOn(up, armed, rest), OtherStep)
      } else {
        val failed = { ...withoutCall(world, callId), faults: world.faults + 1 }
        val generation = generationOfCall(world, callId)
        val handled = if (generation == world.generation) restartOrFailTask(failed, rest) else failed
        move(goOn(failed, handled, rest), StartFailedStep({ generation: generation, atOnce: false }))
      },
    },
  }

  /// A sandbox start fails before its container launches, on an error that a restart cannot fix:
  /// the gateway route, the skills or the start spec. The task fails. One of an older generation
  /// changes nothing.
  action sandboxStartFailsAtOnce: bool = all {
    world.faults < MAX_FAULTS,
    outCalls(world, isStart).intersect(unlaunchedStarts(world)).size() > 0,
    nondet callId = outCalls(world, isStart).intersect(unlaunchedStarts(world)).oneOf()
    val rest = restOf(world, callId)
    val failed = { ...withoutCall(world, callId), faults: world.faults + 1 }
    val generation = generationOfCall(world, callId)
    val handled = if (generation == world.generation) failTask(failed, rest) else failed
    move(goOn(failed, handled, rest), StartFailedStep({ generation: generation, atOnce: true })),
  }

  /// The router write of the branch binding returns. The provision alarm then starts the sandbox
  /// of a task that is still queued. A failed write of a queued task counts a restart and arms the
  /// provision alarm again, or fails the task once its restarts are used up. A task that left
  /// queued while the write was out is left as it is.
  action branchBindingReturns: bool = all {
    outCalls(world, isBranchBinding).size() > 0,
    nondet callId = outCalls(world, isBranchBinding).oneOf()
    nondet ok = Set(true, false).oneOf()
    all {
      ok or world.faults < MAX_FAULTS,
      val rest = restOf(world, callId)
      val returned = withoutCall(world, callId)
      if (ok) {
        val handled = if (returned.status == Queued) startSandbox(returned, rest) else returned
        move(goOn(returned, handled, rest), BranchBindingReturnStep)
      } else {
        val failed = { ...returned, faults: world.faults + 1 }
        val handled =
          if (failed.status != Queued) failed
          else if (failed.restarts >= MAX_RESTARTS) failTask(failed, rest)
          else arm({ ...failed, restarts: failed.restarts + 1 }, Provision)
        move(goOn(failed, handled, rest), BranchBindingReturnStep)
      },
    },
  }

  /// The sandbox provider returns from a destroy. The container went with the bridges it ran.
  action sandboxDestroyReturns: bool = all {
    outCalls(world, isDestroy).size() > 0,
    nondet callId = outCalls(world, isDestroy).oneOf()
    val gone = callsWith(world, callId).foldl(withoutCall(world, callId), (destroyed, call) => match call.kind {
      | SandboxDestroy(generation) => containerGoes(destroyed, generation)
      | _ => destroyed
    })
    move(runFrames(gone, restOf(world, callId)), OtherStep),
  }

  /// A blocked author restarts, unless a prompt is in flight or queued or its task finished. With
  /// `summarizes`, the turn ended with text, so the agent's wake waits on its summarization.
  pure def onOutcome(w: World, outcome: Outcome, summarizes: bool): World = {
    val recorded = { ...w, stoppedEarly: outcome == StoppedEarly }
    match outcome {
      | Blocked =>
        if (isFinished(recorded.status)) recorded
        else if (recorded.promptInFlight or recorded.queue.length() > 0) settleThenWake(recorded, summarizes)
        else restartOrFailTask({ ...recorded, queue: recorded.queue.append(GaveUpWake) }, List())
      | StoppedEarly => settleStoppedEarlyAuthor(recorded, summarizes)
      | _ => settleThenWake(recorded, summarizes)
    }
  }

  /// The generation of the call `callId`. Only a start and an outcome check carry one.
  pure def generationOfCall(w: World, callId: int): int =
    callsWith(w, callId).foldl(w.generation, (generation, call) => match call.kind {
      | SandboxStart(start) => start.generation
      | OutcomeCheck(check) => check.generation
      | _ => generation
    })

  pure def promptsAtTurnEnd(w: World, callId: int): int =
    callsWith(w, callId).foldl(0, (prompts, call) => match call.kind {
      | OutcomeCheck(check) => check.promptsSent
      | _ => prompts
    })

  /// The decisions model answers how the author left its work. The answer about a turn of an older
  /// generation is dropped.
  action outcomeCheckReturns: bool = all {
    outCalls(world, isOutcomeCheck).size() > 0,
    nondet callId = outCalls(world, isOutcomeCheck).oneOf()
    nondet outcome = Set(Finished, WaitsOnPerson, Blocked, StoppedEarly).oneOf()
    val later = world.promptInFlight and world.promptsSent > promptsAtTurnEnd(world, callId)
    val checked = withoutCall(world, callId)
    val current = generationOfCall(world, callId) == world.generation
    move(if (current) onOutcome(checked, outcome, true) else checked, OutcomeStep({ laterPromptInFlight: later })),
  }

  /// The summarization of the turn text returns, and the agent wakes.
  action summarizationReturns: bool = all {
    outCalls(world, isSummarization).size() > 0,
    nondet callId = outCalls(world, isSummarization).oneOf()
    val woken = { ...withoutCall(world, callId), agentWakes: world.agentWakes + 1 }
    move(runFrames(woken, restOf(world, callId)), OtherStep),
  }

  pure def canDial(w: World, bridge: int): bool = and {
    w.bridges[bridge].alive,
    w.sockets.select(socket => and {
      socket.bridge == bridge,
      Set(Connected, ClosingReplaced, ClosingContainer).contains(socket.state),
    }).length() == 0,
  }

  /// A bridge dials in. A dial without the task's token is refused with 4001 and the bridge exits.
  /// An accepted dial replaces the task's other sockets with 4002, and the bridge says hello.
  action bridgeDials: bool = all {
    world.bridges.indices().exists(bridge => canDial(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => canDial(world, index)).oneOf()
    if (world.bridges[bridge].token != world.token)
      move(changeBridges(world, Set(bridge), process => { ...process, alive: false }), DialStep)
    else {
      val replaced = changeSockets(world, socket =>
        if (socket.state == Connected) { ...socket, state: ClosingReplaced }
        else if (socket.state == BridgeGone) { ...socket, state: ClosingBridgeGone }
        else socket)
      val accepted = {
        ...replaced,
        sockets: replaced.sockets.append({ bridge: bridge, generation: world.generation, state: Connected }),
        socketsClosed: world.socketsClosed + listedSockets(world),
      }
      val fresh = not(world.bridges[bridge].saidHello)
      val greeted = changeBridges(accepted, Set(bridge), process => { ...process, saidHello: true })
      move(onBridgeHello(greeted, fresh), HelloStep)
    },
  }

  /// A connected socket drops on the bridge side. The bridge redials. The orchestrator still lists
  /// the socket until its close lands.
  action socketDrops: bool = all {
    world.faults < MAX_FAULTS,
    world.sockets.indices().exists(index => world.sockets[index].state == Connected),
    nondet index = world.sockets.indices().filter(socketIndex => world.sockets[socketIndex].state == Connected).oneOf()
    val dropped = world.sockets.replaceAt(index, { ...world.sockets[index], state: BridgeGone })
    move({ ...world, sockets: dropped, faults: world.faults + 1 }, OtherStep),
  }

  /// The container crashes and its bridge with it. The bridge does not send an exit.
  action bridgeDies: bool = all {
    world.faults < MAX_FAULTS,
    world.bridges.indices().exists(bridge => world.bridges[bridge].alive),
    nondet bridge = world.bridges.indices().filter(index => world.bridges[index].alive).oneOf()
    move({ ...bridgeEnds(world, bridge), faults: world.faults + 1 }, OtherStep),
  }

  /// The close of a socket lands on the orchestrator, and on a bridge that still held the socket.
  /// A bridge closed with 1000 exits and takes its harness with it.
  action socketCloseLands: bool = all {
    world.sockets.indices().exists(index => world.sockets[index].state != Connected),
    nondet index = world.sockets.indices().filter(socketIndex => world.sockets[socketIndex].state != Connected).oneOf()
    val socket = world.sockets[index]
    val removed = withoutSocketAt(world, index)
    val reacted = if (socket.state == ClosingContainer and world.bridges[socket.bridge].alive)
      bridgeEnds(removed, socket.bridge) else removed
    move(onBridgeClosed(reacted, socket.generation), OtherStep),
  }

  /// A bridge that holds a connected socket and a request.
  pure def holdsARequest(w: World, bridge: int): bool = and {
    w.bridges[bridge].alive,
    connectedSocketsOf(w, bridge).length() > 0,
    w.bridges[bridge].requests.length() > 0,
  }

  /// A bridge that holds a connected socket and a handshake request or a prompt.
  pure def answerable(w: World, bridge: int): bool = and {
    w.bridges[bridge].alive,
    connectedSocketsOf(w, bridge).length() > 0,
    turnRequests(w.bridges[bridge]).length() > 0,
  }

  /// A bridge that holds a connected socket and a steer.
  pure def steerable(w: World, bridge: int): bool = and {
    w.bridges[bridge].alive,
    connectedSocketsOf(w, bridge).length() > 0,
    w.bridges[bridge].requests.select(request => request.purpose == Steer).length() > 0,
  }

  pure def rowsWith(w: World, id: int): List[RpcRow] = w.rpcs.select(row => row.id == id)

  /// The orchestrator takes the rpc row an answer names. It counts an answer that reaches a row
  /// another request wrote.
  pure def takeRow(w: World, request: Request): World =
    rowsWith(w, request.id).foldl(w, (taken, row) => {
      ...taken,
      rpcs: taken.rpcs.select(other => other.id != request.id),
      answersToOtherRequests: taken.answersToOtherRequests + (if (row.serial == request.serial) 0 else 1),
    })

  /// The orchestrator takes the rpc row an answer names and runs the handler of that row's purpose.
  pure def onAnswer(w: World, request: Request, stop: StopReason): World =
    rowsWith(w, request.id).foldl(takeRow(w, request), (taken, row) => match row.purpose {
      | Initialize => sendRequest(taken, SessionNew)
      | SessionNew =>
        if (request.purpose == SessionNew) onSessionNew(taken)
        else { ...taken, eventsThatThrew: taken.eventsThatThrew + 1 }
      | SetEffort => sendFirstPrompt(taken)
      | Prompt => if (request.purpose == Prompt) onTurnEnd(taken, stop) else endTurnWithoutStopReason(taken)
      | Steer => taken
    })

  /// The harness answers its oldest handshake request or prompt. A prompt ends its turn, cancelled
  /// when a cancel reached it. A turn that ends on its own prints its closing text first, or ends
  /// without text.
  action harnessAnswers: bool = all {
    world.bridges.indices().exists(bridge => answerable(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => answerable(world, index)).oneOf()
    nondet finished = Set(EndTurn, MaxTokens).oneOf()
    nondet endsWithText = Set(true, false).oneOf()
    val request = turnRequests(world.bridges[bridge])[0]
    val stop = if (request.cancelled) CancelledTurn else finished
    val removed = withoutRequest(world, bridge, request)
    val answered = if (request.purpose == Prompt) endHarnessTurn(removed, bridge, stop == CancelledTurn) else removed
    val printed = { ...answered, turnText: world.turnText or (endsWithText and request.purpose == Prompt and stop == EndTurn) }
    val ownRow = served(world, bridge) and world.rpcs.select(row => row.serial == request.serial).length() > 0
    val endsATurn = request.purpose == Prompt and rowsWith(world, request.id).select(row => row.purpose == Prompt).length() > 0
    val emptyTurnEnd = served(world, bridge) and endsATurn and stop == EndTurn and not(printed.turnText)
    move(
      if (served(world, bridge)) onAnswer(printed, request, stop) else answered,
      if (emptyTurnEnd) EmptyTurnEndStep else AnswerStep({ reachedItsOwnRow: ownRow, purpose: request.purpose }),
    ),
  }

  /// The harness answers its oldest request with an error. A refused prompt ends its turn, and the
  /// person prompts it received count as delivered.
  action harnessRefuses: bool = all {
    world.faults < MAX_FAULTS,
    world.bridges.indices().exists(bridge => holdsARequest(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => holdsARequest(world, index)).oneOf()
    val request = world.bridges[bridge].requests[0]
    val removed = withoutRequest(world, bridge, request)
    val ended = if (request.purpose == Prompt) endHarnessTurn(removed, bridge, false) else removed
    val answered = { ...ended, faults: world.faults + 1 }
    val refused =
      if (not(served(world, bridge))) answered
      else rowsWith(answered, request.id).foldl(takeRow(answered, request), (taken, row) => onRpcError(taken, row.purpose))
    val promptRefused = served(world, bridge) and rowsWith(world, request.id).select(row => row.purpose == Prompt).length() > 0
    move(refused, if (promptRefused) PromptRefusedStep else OtherStep),
  }

  /// The oldest steer a bridge holds, and whether a prompt came before it, so the turn of that
  /// prompt runs when the harness reads the steer.
  pure def oldestSteer(bridge: Bridge): { steer: Request, intoATurn: bool } = {
    val scan = bridge.requests.foldl({ found: false, steer: bridge.requests[0], intoATurn: false, promptBefore: false }, (progress, request) =>
      if (progress.found) progress
      else if (request.purpose == Steer) { ...progress, found: true, steer: request, intoATurn: progress.promptBefore }
      else { ...progress, promptBefore: progress.promptBefore or request.purpose == Prompt })
    { steer: scan.steer, intoATurn: scan.intoATurn }
  }

  /// `onSteerAnswer`: the running turn took the person prompt of an injected steer. A steer the
  /// turn did not take changes nothing, and its person prompt waits for the turn end.
  pure def onSteerAnswer(w: World, request: Request, injected: bool): World =
    rowsWith(w, request.id).foldl(takeRow(w, request), (taken, row) =>
      if (row.purpose == Steer and injected)
        { ...taken, steers: taken.steers.map(steer => if (steer.rpc == request.id) { ...steer, status: SteerTaken } else steer) }
      else taken)

  /// The harness answers its oldest steer. A turn that runs takes it and its harness session
  /// receives the person prompt. Without a running turn, the harness answers that it needs a
  /// prompt.
  action harnessAnswersASteer: bool = all {
    world.bridges.indices().exists(bridge => steerable(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => steerable(world, index)).oneOf()
    val oldest = oldestSteer(world.bridges[bridge])
    val removed = withoutRequest(world, bridge, oldest.steer)
    val answered = if (oldest.intoATurn) receivePerson(removed, bridge, oldest.steer.carries) else removed
    val reachedItsRow = served(world, bridge) and rowsWith(world, oldest.steer.id).length() > 0
    move(
      if (served(world, bridge)) onSteerAnswer(answered, oldest.steer, oldest.intoATurn) else answered,
      SteerAnswerStep({ injected: oldest.intoATurn, reachedItsRow: reachedItsRow }),
    ),
  }

  /// `setTodos`: the todo list of an author is fixed once its job has an artifact.
  pure def storeTodos(w: World, open: bool): World = if (w.artifact) w else { ...w, openTodos: open }

  pure def reportProgress(w: World, report: ProgressReport): World = match report {
    | ToolCall => w
    | OpenTodoList => storeTodos(w, true)
    | FinishedTodoList => storeTodos(w, false)
  }

  /// The harness reports a tool call or a todo list change during its turn.
  action harnessShowsProgress: bool = all {
    world.bridges.indices().exists(bridge => runsATurn(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => runsATurn(world, index)).oneOf()
    nondet report = Set(ToolCall, OpenTodoList, FinishedTodoList).oneOf()
    move(if (served(world, bridge)) reportProgress(touchProgress(world), report) else world, OtherStep),
  }

  /// The harness writes the page and prints its link during its turn. `recordArtifact` stores it,
  /// completes the todo list, and moves an author without a prompt in flight to review.
  action harnessWritesThePage: bool = all {
    not(world.artifact),
    world.bridges.indices().exists(bridge => runsATurn(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => runsATurn(world, index)).oneOf()
    val printed = { ...world, turnText: true }
    move(
      if (not(served(world, bridge))) world
      else if (isFinished(world.status)) printed
      else markAuthorInReview({ ...printed, artifact: true, openTodos: false }),
      OtherStep,
    ),
  }

  /// The harness asks permission for a tool call during its turn, with or without an option that
  /// allows it. The orchestrator answers on the socket the request came on. It selects the allow
  /// option, and a request without one is not allowed.
  action harnessAsksPermission: bool = all {
    world.bridges.indices().exists(bridge => runsATurn(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => runsATurn(world, index)).oneOf()
    nondet offersAllow = Set(true, false).oneOf()
    val asked = {
      ...world,
      permissionsAsked: world.permissionsAsked + 1,
      permissionsWithAnAllowOption: world.permissionsWithAnAllowOption + (if (offersAllow) 1 else 0),
    }
    move(
      if (not(served(world, bridge))) world
      else if (offersAllow) { ...asked, permissionsAllowed: world.permissionsAllowed + 1 }
      else asked,
      OtherStep,
    ),
  }

  /// The harness process exits. The bridge sends its exit and closes its socket.
  action harnessExits: bool = all {
    world.faults < MAX_FAULTS,
    world.bridges.indices().exists(bridge => world.bridges[bridge].alive and connectedSocketsOf(world, bridge).length() > 0),
    nondet bridge = world.bridges.indices().filter(index =>
      world.bridges[index].alive and connectedSocketsOf(world, index).length() > 0).oneOf()
    val handled = if (served(world, bridge)) onBridgeExit(world) else world
    move({ ...bridgeEnds(handled, bridge), faults: world.faults + 1 }, if (served(world, bridge)) ExitStep else OtherStep),
  }

  /// Time passes or an alarm fires.
  action timeMoves: bool = any { alarmFires, timePasses }

  /// Somebody pauses, resumes or ends the work, or something breaks.
  action theWorkIsInterrupted: bool = any {
    agentPausesAuthor,
    agentResumesAuthor,
    personStops,
    agentCancelsJob,
    durableObjectRestarts,
    sandboxStartFailsAtOnce,
    socketDrops,
    bridgeDies,
    harnessRefuses,
    harnessExits,
  }

  /// The harness reports its work in a running turn: progress or a permission request.
  action theHarnessReportsItsWork: bool = any { harnessShowsProgress, harnessAsksPermission }

  /// The agent pauses or resumes the author while its turn runs.
  action theAgentPausesARunningTurn: bool = all {
    PAUSES_RUNNING_TURNS,
    turnRunning(world),
    any { agentPausesAuthor, agentResumesAuthor },
  }

  /// The harness exits under an author idle in review. A walk reaches review only near its end,
  /// so this step weighs that exit as much as any other step.
  action theHarnessExitsUnderAnIdleAuthor: bool = all {
    world.status == InReview,
    not(atWork(world)),
    harnessExits,
  }

  /// The harness reports its work while the job has no artifact, so its todo list can still change.
  /// Samples rarely list todos before the page is written, so this step gives that report more
  /// weight.
  action theHarnessListsItsTodos: bool = all {
    not(world.artifact),
    harnessShowsProgress,
  }

  /// A step picks a prompt, the clock, an interruption and a report of the harness each as often
  /// as one event of a call, a socket or the harness, so a random walk of 25 steps reaches the end
  /// of a turn.
  action step: bool = any {
    personPrompts,
    timeMoves,
    all {
      not(INTERRUPTS_AFTER_THE_FIRST_PROMPT) or world.promptsSent > 0 or isFinished(world.status),
      theWorkIsInterrupted,
    },
    branchBindingReturns,
    sandboxStartLaunchesBridge,
    sandboxStartReturns,
    sandboxDestroyReturns,
    outcomeCheckReturns,
    summarizationReturns,
    bridgeDials,
    socketCloseLands,
    harnessAnswers,
    harnessAnswersASteer,
    harnessWritesThePage,
    theHarnessReportsItsWork,
    theAgentPausesARunningTurn,
    theHarnessExitsUnderAnIdleAuthor,
    theHarnessListsItsTodos,
  }

  /// A finished task never changes status again.
  val finishedTaskKeepsItsStatus: bool = rulesKept.finishedTaskKeepsItsStatus

  /// A task restarts at most `MAX_RESTARTS` times, whatever the cause.
  val taskRestartsAtMostTwice: bool = world.restarts <= MAX_RESTARTS

  /// The workflow sends a paused author no prompt until it resumes.
  val pausedAuthorGetsNoPrompt: bool = rulesKept.pausedAuthorGetsNoPrompt

  /// A task cannot be in review without an artifact on its job.
  val inReviewTaskHasAnArtifact: bool = world.status == InReview implies world.artifact

  /// An alarm armed for an older generation of the task changes nothing but its own schedule row.
  val staleAlarmIsIgnored: bool = rulesKept.staleAlarmIsIgnored

  /// An idle author whose last turn stopped early is never left alone. It has a prompt queued or
  /// in flight, or it is queued for a restart or restarting, or its task finished. The world checks it only between steps
  /// that ran to their end, so a state with a call out is not checked.
  val anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone: bool =
    (noCallOut(world) and world.stoppedEarly and not(isFinished(world.status)) and not(world.promptInFlight)) implies
      (world.queue.length() > 0 or world.status == Queued or world.status == Provisioning or handshakePending(world))

  /// A stop drops the queued prompts. It cancels a running turn. Once its work ran to the end, the
  /// author does not resume unless its task finished.
  val stopEndsTheAuthorsTurn: bool = rulesKept.stopEndsTheAuthorsTurn

  /// T4. A sandbox start moves the task to provisioning in the next generation with a
  /// new bridge token. The harness session, the prompt in flight, the rpc rows, the nudge, the keep
  /// alive and the time of the last bridge close are cleared, and the hello timeout of the new
  /// generation is armed.
  val aSandboxStartBeginsAFreshGeneration: bool = rulesKept.aSandboxStartBeginsAFreshGeneration

  /// T5. A provisioning task becomes working only when its bridge says hello, or when a
  /// stop ends the turn it was starting.
  val aStartingTaskWorksOnlyAfterItsHello: bool = rulesKept.aStartingTaskWorksOnlyAfterItsHello

  /// T19. An author in review becomes working only in a step that sends it a prompt.
  val anAuthorInReviewWorksOnlyWithAPrompt: bool = rulesKept.anAuthorInReviewWorksOnlyWithAPrompt

  /// T21. A lost turn counts one restart, and the task recovers it in a fresh harness session. A
  /// lost turn on a task whose restarts are used up fails the task. A task queued for a restart
  /// already counted it, so its lost turn does not count another one.
  val aLostTurnCountsOneRestart: bool = rulesKept.aLostTurnCountsOneRestart

  /// T22. A harness exit on an unfinished task with restarts left counts one restart and
  /// starts the next generation, also when the author was idle in review. A harness exit on a
  /// task whose restarts are used up fails the task.
  val aHarnessExitCountsOneRestart: bool = rulesKept.aHarnessExitCountsOneRestart

  /// T23. A sandbox start of the current generation that throws on an unfinished task
  /// fails it, or closes its container to restart it. One of an older generation changes nothing.
  val aFailedSandboxStartRestartsOrFails: bool = rulesKept.aFailedSandboxStartRestartsOrFails

  /// A bridge of the current generation that can still move the task: it can dial in, or it holds
  /// a request to answer.
  pure def bridgeCanMoveTheTask(w: World): bool =
    w.bridges.indices().exists(bridge => and {
      w.bridges[bridge].alive,
      w.bridges[bridge].generation == w.generation,
      w.bridges[bridge].token == w.token,
      canDial(w, bridge) or (connectedSocketsOf(w, bridge).length() > 0 and turnRequests(w.bridges[bridge]).length() > 0),
    })

  /// True when draining the queue now sends a prompt or starts a sandbox. A drain that only arms
  /// the next retry does not move the task.
  pure def drainMovesTheTask(w: World): bool = {
    val drained = drainQueue(w, List())
    drained.promptsSent > w.promptsSent or issued(w, drained)
  }

  /// An alarm whose handler moves the task in the state it would fire in now.
  pure def alarmMovesTheTask(w: World): bool =
    w.alarms.select(alarm => match alarm.kind {
      | Provision => w.status == Queued
      | HelloTimeout(generation) => generation == w.generation and w.status == Provisioning
      | NoProgress(generation) => generation == w.generation and w.promptInFlight
      | BridgeLost(generation) => generation == w.generation and waitsOnTheBridge(w)
      | RetryQueue(generation) => generation == w.generation and drainMovesTheTask(w)
      | SettleIdleAuthor(generation) => generation == w.generation and w.status == Working and not(w.promptInFlight)
      | WallClock => w.promptInFlight
      | KeepAlive(_) => false
    }).length() > 0

  /// T24 and T45. An unpaused, unfinished task with work to do always has a way forward:
  /// a call out, an alarm that acts on it, a bridge that can answer, or an open socket whose close
  /// recovers a prompt in flight or an unfinished handshake.
  val anUnpausedTaskWithWorkIsNeverStranded: bool =
    (not(isFinished(world.status)) and not(world.paused) and (world.queue.length() > 0 or atWork(world))) implies or {
      not(noCallOut(world)),
      alarmMovesTheTask(world),
      bridgeCanMoveTheTask(world),
      waitsOnTheBridge(world) and world.sockets.length() > 0,
    }

  /// T29. A prompt the harness refuses is no longer in flight, unless the next prompt
  /// went out in the same step.
  val aRefusedPromptLeavesTheTurn: bool = rulesKept.aRefusedPromptLeavesTheTurn

  /// T40. The provision alarm starts a sandbox only for a queued task.
  val provisionStartsOnlyAQueuedTask: bool = rulesKept.provisionStartsOnlyAQueuedTask

  /// T42. The wall clock fails a task whose turn is in flight, without a restart.
  val wallClockFailsWithoutARestart: bool = rulesKept.wallClockFailsWithoutARestart

  /// T44. While a turn of an unfinished task is in flight in a harness session, the keep
  /// alive alarm of its generation is armed.
  val aRunningTurnKeepsItsSandboxAwake: bool =
    (world.promptInFlight and world.session and not(isFinished(world.status))) implies match world.keepAliveSlot {
      | Armed(id) => world.alarms.select(alarm => alarm.id == id and alarm.kind == KeepAlive(world.generation)).length() == 1
      | Unarmed => false
    }

  /// T50. A bridge connects only with the task's current token, and its socket is then
  /// the only one the task lists.
  val aBridgeConnectsOnlyWithTheCurrentToken: bool = rulesKept.aBridgeConnectsOnlyWithTheCurrentToken

  /// T51. The orchestrator allows every permission request of the current generation that offers
  /// an allow option.
  val everyPermissionRequestWithAnAllowOptionIsAllowed: bool =
    world.permissionsAllowed == world.permissionsWithAnAllowOption

  /// T7 and A39. A harness session runs one turn at a time: no bridge holds two prompts.
  val aHarnessSessionRunsOneTurnAtATime: bool =
    world.bridges.select(bridge => bridge.requests.select(request => request.purpose == Prompt).length() > 1).length() == 0

  /// T7. An author in review runs no turn and no handshake.
  val anAuthorInReviewRunsNoTurn: bool =
    world.status == InReview implies (not(world.promptInFlight) and not(handshakePending(world)))

  /// T26. A turn outcome does not restart or fail the author while a prompt sent after
  /// that turn ended is in flight.
  val aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn: bool = rulesKept.aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn

  /// T43. The hello timeout of the current generation does not restart, fail or move the
  /// task while the sandbox start of that generation is out. The end of an older start does not end
  /// the wait.
  val theHelloTimeoutWaitsWhileItsStartIsOut: bool = rulesKept.theHelloTimeoutWaitsWhileItsStartIsOut

  /// After a stop, the author stays out of work until a person prompts it or a resume continues it,
  /// unless its task finished.
  val aStoppedAuthorStaysQuiet: bool =
    (world.stopped and not(isFinished(world.status))) implies not(atWork(world))

  /// A task that never had a first prompt gets the task prompt as its first prompt, also after a
  /// stop or a restart began a later generation.
  val aTaskWithoutAnEarlierPromptGetsTheTaskPrompt: bool = rulesKept.aTaskWithoutAnEarlierPromptGetsTheTaskPrompt

  /// A harness answer reaches only the request it answers, never a later request that
  /// took the same rpc id.
  val anAnswerReachesOnlyItsOwnRequest: bool = world.answersToOtherRequests == 0

  pure def isPersonPrompt(kind: PromptKind): bool = match kind {
    | PersonPrompt(_) => true
    | _ => false
  }

  /// K10. While a turn runs and the task is not paused, every queued person prompt has a steer out
  /// or is taken. A harness that cannot steer keeps its queue, and this spec does not model one.
  val aPersonPromptDoesNotWaitForTheTurnToEnd: bool =
    (turnRunning(world) and not(world.paused) and not(isFinished(world.status))) implies
      waiting(world).select(isPersonPrompt).length() == 0

  /// K15. A harness session receives each person prompt at most once, by steer or as a prompt,
  /// unless the turn that received it was cancelled.
  val aHarnessSessionReceivesEachPersonPromptOnce: bool = world.receivedTwice == 0

  /// K15. Each person prompt is queued, delivered by a harness turn that ended without a cancel, or
  /// dropped by a stop or the end of its task.
  val aPersonPromptIsNeverDropped: bool =
    0.to(MAX_PERSON_PROMPTS - 1).forall(person => person < world.personPrompts implies or {
      queuedPersons(world).contains(person),
      world.delivered.contains(person),
      world.discarded.contains(person),
    })

  /// Every mirrored invariant, for one check of all of them.
  val invariants: bool = and {
    finishedTaskKeepsItsStatus,
    taskRestartsAtMostTwice,
    pausedAuthorGetsNoPrompt,
    inReviewTaskHasAnArtifact,
    staleAlarmIsIgnored,
    anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone,
    stopEndsTheAuthorsTurn,
  }

  /// Every proposed invariant, for one check of all of them.
  val proposedInvariants: bool = and {
    aSandboxStartBeginsAFreshGeneration,
    aStartingTaskWorksOnlyAfterItsHello,
    anAuthorInReviewWorksOnlyWithAPrompt,
    aLostTurnCountsOneRestart,
    aHarnessExitCountsOneRestart,
    aFailedSandboxStartRestartsOrFails,
    anUnpausedTaskWithWorkIsNeverStranded,
    aRefusedPromptLeavesTheTurn,
    provisionStartsOnlyAQueuedTask,
    wallClockFailsWithoutARestart,
    aRunningTurnKeepsItsSandboxAwake,
    aBridgeConnectsOnlyWithTheCurrentToken,
    everyPermissionRequestWithAnAllowOptionIsAllowed,
    aHarnessSessionRunsOneTurnAtATime,
    anAuthorInReviewRunsNoTurn,
    aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn,
    anAnswerReachesOnlyItsOwnRequest,
    theHelloTimeoutWaitsWhileItsStartIsOut,
    aStoppedAuthorStaysQuiet,
    aTaskWithoutAnEarlierPromptGetsTheTaskPrompt,
    aPersonPromptDoesNotWaitForTheTurnToEnd,
    aHarnessSessionReceivesEachPersonPromptOnce,
    aPersonPromptIsNeverDropped,
  }

  /// Witness for `finishedTaskKeepsItsStatus`: a finished task is there before a step.
  val aFinishedTaskIsInAStep: bool = stepWitnesses.aFinishedTaskIsInAStep

  /// Witness for `taskRestartsAtMostTwice`: the task restarted twice.
  val theTaskRestartedTwice: bool = world.restarts == MAX_RESTARTS

  /// Witness for `pausedAuthorGetsNoPrompt`: a paused author stays paused through a step.
  val aPausedAuthorStaysPaused: bool = stepWitnesses.aPausedAuthorStaysPaused

  /// Witness for `inReviewTaskHasAnArtifact`: the author waits in review.
  val theAuthorWaitsInReview: bool = world.status == InReview

  /// Witness for `staleAlarmIsIgnored`: a stale alarm fires.
  val aStaleAlarmFires: bool = stepWitnesses.aStaleAlarmFires

  /// Witness for `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone`: an author stopped early and
  /// has no prompt in flight.
  val anAuthorStoppedEarlyAndIsIdle: bool =
    world.stoppedEarly and not(world.promptInFlight) and not(isFinished(world.status))

  /// Witness for `stopEndsTheAuthorsTurn`: a stop lands during a running turn.
  val aStopLandsDuringATurn: bool = stepWitnesses.aStopLandsDuringATurn

  /// Witness for `stopEndsTheAuthorsTurn`: a stop ends a turn that was starting.
  val aStopEndsAStartingTurn: bool = stepWitnesses.aStopEndsAStartingTurn

  /// Witness for `aSandboxStartBeginsAFreshGeneration`: a later generation begins.
  val aLaterGenerationBegins: bool = stepWitnesses.aLaterGenerationBegins

  /// Witness for `aStoppedAuthorStaysQuiet`: a stopped, unfinished author has a call out.
  val aStoppedAuthorHasACallOut: bool =
    world.stopped and not(isFinished(world.status)) and not(noCallOut(world))

  /// Witness for `aStartingTaskWorksOnlyAfterItsHello`: a hello moves the task to working.
  val aHelloMovesTheTaskToWorking: bool = stepWitnesses.aHelloMovesTheTaskToWorking

  /// Witness for `anAuthorInReviewWorksOnlyWithAPrompt`: an author in review takes a prompt.
  val anAuthorInReviewTakesAPrompt: bool = stepWitnesses.anAuthorInReviewTakesAPrompt

  /// Witness for `aLostTurnCountsOneRestart`: a lost turn is recovered.
  val aLostTurnIsRecovered: bool = stepWitnesses.aLostTurnIsRecovered

  /// Witness for `aLostTurnCountsOneRestart`: a lost turn fails a task whose restarts are used up.
  val aLostTurnFailsTheTask: bool = stepWitnesses.aLostTurnFailsTheTask

  /// Witness for `aLostTurnCountsOneRestart`: a lost turn of a task queued for a restart.
  val aLostTurnOfATaskQueuedForARestart: bool = stepWitnesses.aLostTurnOfATaskQueuedForARestart

  /// Witness for `aHarnessExitCountsOneRestart`: the harness exits on a task with restarts left.
  val aHarnessExitRestartsTheTask: bool = stepWitnesses.aHarnessExitRestartsTheTask

  /// Witness for `aHarnessExitCountsOneRestart`: the harness exits under an author idle in review.
  val aHarnessExitRestartsAnIdleAuthor: bool = stepWitnesses.aHarnessExitRestartsAnIdleAuthor

  /// Witness for `aHarnessExitCountsOneRestart`: the harness exits on a task whose restarts are
  /// used up.
  val aHarnessExitFailsTheTask: bool = stepWitnesses.aHarnessExitFailsTheTask

  /// Witness for `aFailedSandboxStartRestartsOrFails`: a sandbox start throws.
  val aSandboxStartFails: bool = stepWitnesses.aSandboxStartFails

  /// Witness for `taskRestartsAtMostTwice`: the start of an older generation throws.
  val aStaleSandboxStartFails: bool = stepWitnesses.aStaleSandboxStartFails

  /// Witness for `aFailedSandboxStartRestartsOrFails`: a sandbox start fails at once and fails the task.
  val aSandboxStartFailsAtOnce: bool = stepWitnesses.aSandboxStartFailsAtOnce

  /// Witness for `aFailedSandboxStartRestartsOrFails`: the start of an older generation fails at once.
  val aStaleSandboxStartFailsAtOnce: bool = stepWitnesses.aStaleSandboxStartFailsAtOnce

  /// Witness for `taskRestartsAtMostTwice` and `aRunningTurnKeepsItsSandboxAwake`: a destroy returns
  /// after another restart counted or a newer generation began, and its restart is dropped.
  val aStaleRestartIsDropped: bool = stepWitnesses.aStaleRestartIsDropped

  /// Witness for `anAuthorInReviewRunsNoTurn`: the outcome of a turn of an older generation returns
  /// and is dropped.
  val aStaleOutcomeCheckIsDropped: bool = stepWitnesses.aStaleOutcomeCheckIsDropped

  /// Witness for `anUnpausedTaskWithWorkIsNeverStranded`: the handshake waits on the harness.
  val theHandshakeWaitsOnTheHarness: bool = handshakePending(world) and not(world.paused) and not(isFinished(world.status))

  /// Witness for `aRefusedPromptLeavesTheTurn`: the harness refuses a prompt.
  val theHarnessRefusesAPrompt: bool = stepWitnesses.theHarnessRefusesAPrompt

  /// Witness for `provisionStartsOnlyAQueuedTask`: the provision alarm fires.
  val theProvisionAlarmFires: bool = stepWitnesses.theProvisionAlarmFires

  /// Witness for `wallClockFailsWithoutARestart`: the wall clock fails a turn in flight.
  val theWallClockFailsATurn: bool = stepWitnesses.theWallClockFailsATurn

  /// Witness for `wallClockFailsWithoutARestart`: the wall clock of a turn fires while its task is
  /// queued for a restart.
  val theWallClockFiresDuringARestart: bool = stepWitnesses.theWallClockFiresDuringARestart

  /// Witness for `aRunningTurnKeepsItsSandboxAwake`: the keep alive alarm fires on a turn in flight.
  val theKeepAliveFiresOnATurn: bool = stepWitnesses.theKeepAliveFiresOnATurn

  /// Witness for `aBridgeConnectsOnlyWithTheCurrentToken`: a dial with an old token is refused.
  val aDialIsRefused: bool = stepWitnesses.aDialIsRefused

  /// Witness for `aBridgeConnectsOnlyWithTheCurrentToken`: a new socket replaces a listed one.
  val aSocketIsReplaced: bool = stepWitnesses.aSocketIsReplaced

  /// Witness for `everyPermissionRequestWithAnAllowOptionIsAllowed`: a permission request is allowed.
  val aPermissionIsAllowed: bool = world.permissionsAllowed > 0

  /// Witness for `everyPermissionRequestWithAnAllowOptionIsAllowed`: a permission request offers no
  /// allow option.
  val aPermissionRequestOffersNoAllowOption: bool = world.permissionsAsked > world.permissionsWithAnAllowOption

  /// Witness for `aHarnessSessionRunsOneTurnAtATime`: a harness turn runs.
  val aTurnRuns: bool = turnRunning(world)

  /// Witness for `anAuthorInReviewRunsNoTurn`: a resume while the harness still runs the turn the
  /// pause cancelled.
  val aResumeLandsDuringACancelledTurn: bool = stepWitnesses.aResumeLandsDuringACancelledTurn

  /// Witness for `aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn`: a prompt goes out while an
  /// outcome check is out.
  val aPromptGoesOutDuringAnOutcomeCheck: bool = stepWitnesses.aPromptGoesOutDuringAnOutcomeCheck

  /// Witness for `anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone`: a turn ends on its own without
  /// text while the todo list has open entries and the job has no artifact, so the author stopped
  /// early without an outcome check.
  val anEmptyTurnStopsEarly: bool = stepWitnesses.anEmptyTurnStopsEarly

  /// The agent wakes after a turn that ended on its own without text, without a summarization.
  val theAgentWakesAfterAnEmptyTurn: bool = stepWitnesses.theAgentWakesAfterAnEmptyTurn

  /// Witness for `anAnswerReachesOnlyItsOwnRequest`: the harness answers a request after the
  /// orchestrator cleared its rpc row.
  val anAnswerArrivesAfterItsRowWasCleared: bool = stepWitnesses.anAnswerArrivesAfterItsRowWasCleared

  /// The stage asked for an effort and the harness session took it before its first prompt.
  val theEffortIsSet: bool = stepWitnesses.theEffortIsSet

  /// A restart of the Durable Object dropped a call.
  val aCallWasDropped: bool = stepWitnesses.aCallWasDropped

  /// The Durable Object restarts while no call is out, so only the start step runs.
  val theInstanceRestartsWithoutACallOut: bool = stepWitnesses.theInstanceRestartsWithoutACallOut

  /// A restart of the Durable Object cut an alarm's handler, and the alarm runs again.
  val anAlarmRunsAgainAfterARestart: bool = stepWitnesses.anAlarmRunsAgainAfterARestart

  /// Witness for `theHelloTimeoutWaitsWhileItsStartIsOut`: the hello timeout fires on a
  /// provisioning task while the start of its generation is out.
  val aHelloTimeoutFiresWhileItsStartIsOut: bool = stepWitnesses.aHelloTimeoutFiresWhileItsStartIsOut

  /// Witness for `aTaskWithoutAnEarlierPromptGetsTheTaskPrompt`: a task that had a first prompt
  /// before gets the resume prompt.
  val aResumePromptIsChosen: bool = stepWitnesses.aResumePromptIsChosen

  /// Witness for `aTaskWithoutAnEarlierPromptGetsTheTaskPrompt`: a task whose generation a stop
  /// ended before its first prompt gets the task prompt.
  val aStoppedTaskGetsTheTaskPrompt: bool = stepWitnesses.aStoppedTaskGetsTheTaskPrompt

  /// The agent wakes because the harness is idle after a turn end or a refused prompt.
  val theAgentWakesForAnIdleHarness: bool = stepWitnesses.theAgentWakesForAnIdleHarness

  /// A restart of the Durable Object drops the summarization of a turn end, and the agent does not
  /// wake.
  val aRestartDropsTheSummarization: bool = stepWitnesses.aRestartDropsTheSummarization

  /// Witness for `provisionStartsOnlyAQueuedTask`: the branch binding write returns after the task
  /// left queued, so the provision alarm does not start the sandbox.
  val aTaskLeftQueuedDuringItsBranchBinding: bool = stepWitnesses.aTaskLeftQueuedDuringItsBranchBinding

  /// The router write of the branch binding fails.
  val theBranchBindingFails: bool = stepWitnesses.theBranchBindingFails

  /// Witness for `aPersonPromptDoesNotWaitForTheTurnToEnd`: the running turn takes a steer.
  val aSteerIsTaken: bool = stepWitnesses.aSteerIsTaken

  /// Witness for `aPersonPromptIsNeverDropped`: a steer reaches the harness after its turn ended,
  /// so its person prompt goes as the next prompt.
  val aSteerRacesTheTurnEnd: bool = stepWitnesses.aSteerRacesTheTurnEnd

  /// Witness for `aPersonPromptIsNeverDropped`: the Durable Object restarts while a steer is out.
  val aRestartLandsWhileASteerIsOut: bool = stepWitnesses.aRestartLandsWhileASteerIsOut

  /// Witness for `aHarnessSessionReceivesEachPersonPromptOnce`: a restart of the Durable Object cuts
  /// the outcome check of a turn end after a harness turn delivered a person prompt.
  val aRestartCutsTheOutcomeCheckOfATurnThatTookAnInstruction: bool =
    stepWitnesses.aRestartCutsTheOutcomeCheckOfATurnThatTookAnInstruction

  /// Witness for `aPersonPromptIsNeverDropped`: a lost turn returns a taken person prompt to the
  /// queue.
  val aLostTurnReturnsATakenInstruction: bool = stepWitnesses.aLostTurnReturnsATakenInstruction

  /// The author was nudged.
  val theAuthorWasNudged: bool = world.nudged

  /// The agent cancelled the task.
  val theTaskWasCancelled: bool = world.status == Cancelled
}
