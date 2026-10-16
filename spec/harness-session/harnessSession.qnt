/// One harness author task: its sandbox, its bridge, and its harness session, from the provision
/// alarm to the end of the task.
/// Each action is one event the orchestrator handles to its end before the next event lands. Three
/// calls split an event: the sandbox start, the sandbox destroy, and the turn outcome check. One
/// action sends the call and a later action returns it. A restart of the Durable Object drops every
/// call that is out, with the rest of its event. Every other await is answered at once.
/// Any alarm may fire at any step, also before its delay ran out. Time moves only when
/// `timePasses` takes the clock past the reconnect ceiling.
/// The bridge and its harness are modelled from the outside. A bridge sends a frame only on a
/// socket that both ends hold open. The harness answers its requests in the order they came.
module harnessSessionTypes {
  /// The status of the author task. A task in this model cannot finish done.
  type TaskStatus = Queued | Provisioning | Working | InReview | Cancelled | Failed

  /// What a queued prompt is, by the code that queued it.
  type PromptKind =
    | PersonPrompt
    | ContinuePrompt
    | NudgePrompt
    | GaveUpWake
    | LostSandboxWake
    | FirstPrompt

  /// Why the orchestrator sent a JSON-RPC request to the harness.
  type RpcPurpose = Initialize | SessionNew | SetEffort | Prompt

  /// A request the orchestrator waits on. `serial` names the request itself, and the code does not
  /// see it.
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
  type Request = { id: int, purpose: RpcPurpose, cancelled: bool, serial: int }

  /// One bridge process and its harness. `token` is the bridge token it started with.
  type Bridge = {
    generation: int,
    token: int,
    alive: bool,
    saidHello: bool,
    requests: List[Request],
  }

  /// What runs after the call that returns, innermost first. `CloseFeedWithoutStopReason` throws
  /// when the author is idle, because the feed closing reads a stop reason the answer lacked.
  /// `AlarmEnds` marks the end of an alarm's handler. The alarm stays scheduled until it runs.
  type Frame =
    | RestartAfterClose({ generation: int, restarts: int })
    | SettleAfterDrain
    | StartEnds
    | CloseFeedWithoutStopReason
    | AlarmEnds(Alarm)

  /// A call the orchestrator awaits. A sandbox destroy kills the bridges up to the generation it
  /// names. An outcome check remembers the prompts sent and the generation when its turn ended.
  type CallKind =
    | SandboxStart({ generation: int, token: int, launched: bool })
    | SandboxDestroy(int)
    | OutcomeCheck({ promptsSent: int, generation: int })

  /// A call is out until it returns and leaves the list. A restart of the Durable Object drops the
  /// calls that are out. A dropped start stays until its container comes up. Every other dropped
  /// call leaves the list.
  type CallState = Out | Dropped

  type Call = { id: int, kind: CallKind, state: CallState, rest: List[Frame] }

  /// How the author left its work when its turn ended on its own, by the decisions model.
  type Outcome = Finished | WaitsOnPerson | Blocked | StoppedEarly

  /// The stop reason a prompt answer carries.
  type StopReason = EndTurn | CancelledTurn | MaxTokens

  /// The task, its sandbox row, its queue and rpc rows, its alarms, the sockets and bridges around
  /// it, and the calls out. The counters at the end are what an observer counts.
  type World = {
    status: TaskStatus,
    restarts: int,
    paused: bool,
    generation: int,
    token: int,
    session: bool,
    promptInFlight: bool,
    nudged: bool,
    bridgeClosedAt: Stamp,
    lastProgressAt: Stamp,
    queue: List[PromptKind],
    rpcs: List[RpcRow],
    artifact: bool,
    helloSlot: Slot,
    noProgressSlot: Slot,
    wallSlot: Slot,
    keepAliveSlot: Slot,
    alarms: List[Alarm],
    nextAlarm: int,
    startTracked: bool,
    sockets: List[Socket],
    bridges: List[Bridge],
    calls: List[Call],
    nextCall: int,
    nextSerial: int,
    promptsSent: int,
    cancelsDelivered: int,
    permissionsAsked: int,
    permissionsAllowed: int,
    socketsClosed: int,
    lostTurnsRecovered: int,
    stopsEnded: int,
    answersToOtherRequests: int,
    eventsThatThrew: int,
    stoppedEarly: bool,
    personPrompts: int,
    faults: int,
    actions: int,
  }

  /// What kind of event the last step was, as far as a rule needs it.
  type StepKind =
    | OtherStep
    | HelloStep
    | StopStep
    | StaleAlarmStep
    | ExitStep
    | StartFailedStep(int)
    | PromptRefusedStep
    | ProvisionStep
    | WallClockStep
    | KeepAliveStep
    | DialStep
    | DurableObjectRestartStep
    | AnswerStep({ reachedItsOwnRow: bool, purpose: RpcPurpose })
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
    aLostTurnIsRecoveredWithoutARestart: bool,
    aHarnessExitCountsOneRestart: bool,
    aFailedSandboxStartRestartsOrFails: bool,
    aRefusedPromptLeavesTheTurn: bool,
    provisionStartsOnlyAQueuedTask: bool,
    wallClockFailsWithoutARestart: bool,
    aBridgeConnectsOnlyWithTheCurrentToken: bool,
    aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn: bool,
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
    aHarnessExitRestartsTheTask: bool,
    aSandboxStartFails: bool,
    aStaleSandboxStartFails: bool,
    aStaleRestartIsDropped: bool,
    aStaleOutcomeCheckIsDropped: bool,
    theHarnessRefusesAPrompt: bool,
    theProvisionAlarmFires: bool,
    theWallClockFailsATurn: bool,
    theKeepAliveFiresOnATurn: bool,
    aDialIsRefused: bool,
    aSocketIsReplaced: bool,
    aResumeLandsDuringACancelledTurn: bool,
    aPromptGoesOutDuringAnOutcomeCheck: bool,
    anAnswerArrivesAfterItsRowWasCleared: bool,
    theEffortIsSet: bool,
    aCallWasDropped: bool,
    anAlarmRunsAgainAfterARestart: bool,
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
    promptInFlight: false,
    nudged: false,
    bridgeClosedAt: Unset,
    lastProgressAt: Recent,
    queue: List(),
    rpcs: List(),
    artifact: false,
    helloSlot: Unarmed,
    noProgressSlot: Unarmed,
    wallSlot: Unarmed,
    keepAliveSlot: Unarmed,
    alarms: List({ id: 0, kind: Provision }),
    nextAlarm: 1,
    startTracked: false,
    sockets: List(),
    bridges: List(),
    calls: List(),
    nextCall: 0,
    nextSerial: 0,
    promptsSent: 0,
    cancelsDelivered: 0,
    permissionsAsked: 0,
    permissionsAllowed: 0,
    socketsClosed: 0,
    lostTurnsRecovered: 0,
    stopsEnded: 0,
    answersToOtherRequests: 0,
    eventsThatThrew: 0,
    stoppedEarly: false,
    personPrompts: 0,
    faults: 0,
    actions: 0,
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

  pure def handshakePending(w: World): bool = w.rpcs.select(row => row.purpose != Prompt).length() > 0

  pure def issued(before: World, after: World): bool = after.nextCall > before.nextCall

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

  /// Write a request to every listed socket. Only a connected socket carries it to its bridge.
  pure def sendRequest(w: World, purpose: RpcPurpose): World = {
    val id = w.rpcs.foldl(0, (highest, row) => if (row.id > highest) row.id else highest) + 1
    val stored = {
      ...w,
      rpcs: w.rpcs.append({ id: id, purpose: purpose, serial: w.nextSerial }),
      nextSerial: w.nextSerial + 1,
    }
    val request = { id: id, purpose: purpose, cancelled: false, serial: w.nextSerial }
    changeBridges(stored, bridgesOn(stored, Connected), bridge =>
      { ...bridge, requests: bridge.requests.append(request) })
  }

  /// Write `session/cancel` to every listed socket. A harness that runs a prompt cancels its turn.
  pure def sendCancel(w: World): World = {
    val reached = bridgesOn(w, Connected)
    val marked = changeBridges(w, reached, bridge =>
      if (bridge.requests.length() > 0 and bridge.requests[0].purpose == Prompt)
        { ...bridge, requests: bridge.requests.replaceAt(0, { ...bridge.requests[0], cancelled: true }) }
      else bridge)
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
    }
  }

  /// `startSandbox`: the start is out until `sandboxStartReturns`.
  pure def startSandbox(w: World, rest: List[Frame]): World = {
    val begun = beginGeneration({ ...w, startTracked: true })
    issueCall(
      begun,
      SandboxStart({ generation: begun.generation, token: begun.token, launched: false }),
      List(StartEnds).concat(rest),
    )
  }

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

  /// `finishTask`: the status is written before the sandbox goes.
  pure def finishTask(w: World, status: TaskStatus, rest: List[Frame]): World =
    closeContainer({ ...clearTaskTimers({ ...w, status: status }), queue: List() }, rest)

  pure def failTask(w: World, rest: List[Frame]): World =
    if (isFinished(w.status)) w else finishTask(w, Failed, rest)

  pure def cancelTask(w: World): World =
    if (isFinished(w.status)) w else finishTask(w, Cancelled, List())

  pure def restartOrFailTask(w: World, rest: List[Frame]): World =
    if (isFinished(w.status)) w
    else if (w.restarts >= MAX_RESTARTS) failTask(w, rest)
    else closeContainer(w, List(RestartAfterClose({ generation: w.generation, restarts: w.restarts })).concat(rest))

  pure def holdRestartForResume(w: World): World = clearTaskTimers({ ...w, restarts: w.restarts + 1 })

  /// `sendPrompt`: the turn goes in flight and arms its timers.
  pure def sendPrompt(w: World): World =
    if (not(w.session)) w
    else {
      val inFlight = {
        ...w,
        promptInFlight: true,
        status: if (w.status == InReview) Working else w.status,
        promptsSent: w.promptsSent + 1,
      }
      armKeepAlive(armWallClock(armNoProgress(sendRequest(inFlight, Prompt))))
    }

  /// `sendFirstPrompt`: a later generation takes the head of the queue as its wake text. A paused
  /// task keeps the first prompt at the head of its queue.
  pure def sendFirstPrompt(w: World): World = {
    val resumes = w.generation > 1 or w.restarts > 0
    val woken = if (resumes and w.queue.length() > 0) { ...w, queue: w.queue.tail() } else w
    if (not(woken.paused)) sendPrompt(woken)
    else { ...woken, queue: List(FirstPrompt).concat(woken.queue) }
  }

  pure def wakeOrWait(w: World, rest: List[Frame]): World =
    if (w.session and w.bridgeClosedAt == Recent and not(bridgeProcessGone(w)))
      arm(w, RetryQueue(w.generation))
    else startSandbox(w, rest)

  pure def drainQueue(w: World, rest: List[Frame]): World =
    if (isFinished(w.status) or w.paused) w
    else if (w.promptInFlight) w
    else if (w.queue.length() == 0) w
    else if (connected(w) and w.session) sendPrompt({ ...w, queue: w.queue.tail() })
    else if (w.status == Provisioning or handshakePending(w)) w
    else if (connected(w)) w
    else wakeOrWait(w, rest)

  pure def promptTask(w: World, kind: PromptKind, rest: List[Frame]): World =
    if (isFinished(w.status)) w
    else {
      val queued = { ...w, queue: w.queue.append(kind) }
      if (queued.paused) queued else drainQueue(queued, rest)
    }

  pure def markAuthorInReview(w: World): World =
    if ((w.status == Working or w.status == Queued) and w.artifact and not(w.promptInFlight))
      { ...w, status: InReview }
    else w

  /// `settleAndResumeAuthor`: send what is queued, else the author waits in review.
  pure def settleAndResumeAuthor(w: World, rest: List[Frame]): World = {
    val drained = drainQueue(w, List(SettleAfterDrain).concat(rest))
    if (issued(w, drained)) drained else markAuthorInReview(drained)
  }

  pure def recoverLostTurn(w: World, rest: List[Frame]): World = {
    val cleared = { ...w, rpcs: List(), promptInFlight: false, lostTurnsRecovered: w.lostTurnsRecovered + 1 }
    val woken = if (cleared.queue.length() == 0) { ...cleared, queue: List(LostSandboxWake) } else cleared
    drainQueue(woken, rest)
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

  pure def onBridgeLostNow(w: World): World =
    if (not(w.promptInFlight) or isFinished(w.status) or w.paused or connected(w)) w
    else recoverLostTurn(w, List())

  pure def onBridgeClosed(w: World, generation: int): World =
    if (generation != w.generation) w
    else {
      val closed = { ...w, bridgeClosedAt: Recent }
      if (not(closed.promptInFlight) or isFinished(closed.status)) closed
      else if (bridgeProcessGone(closed)) onBridgeLostNow(closed)
      else arm(closed, BridgeLost(closed.generation))
    }

  pure def onBridgeHello(w: World, fresh: bool): World = {
    val greeted = { ...cancelSlot(w, w.helloSlot), helloSlot: Unarmed, bridgeClosedAt: Unset }
    val working = if (greeted.status == Provisioning) { ...greeted, status: Working } else greeted
    if (working.session and not(fresh)) drainQueue(working, List())
    else sendRequest({ ...working, rpcs: List(), session: false, promptInFlight: false }, Initialize)
  }

  /// `onSessionNew`: the harness session opens. A stage that asks for an effort sets it first.
  pure def onSessionNew(w: World): World = {
    val opened = { ...w, session: true }
    if (ASKS_EFFORT) sendRequest(opened, SetEffort) else sendFirstPrompt(opened)
  }

  pure def onTurnEnd(w: World, stop: StopReason): World = {
    val ended = { ...w, promptInFlight: false }
    if (stop == EndTurn) issueCall(ended, OutcomeCheck({ promptsSent: ended.promptsSent, generation: ended.generation }), List())
    else settleAndResumeAuthor({ ...ended, stoppedEarly: false }, List())
  }

  /// The feed of an idle author closes on the stop reason of its turn. Without one the event throws.
  pure def closeFeedWithoutStopReason(w: World): World =
    if (w.promptInFlight) w else { ...w, eventsThatThrew: w.eventsThatThrew + 1 }

  /// An answer to another request reaches a prompt row. The turn ends and settles like a turn
  /// without an outcome check, then the event throws if the author is idle.
  pure def endTurnWithoutStopReason(w: World): World = {
    val ended = { ...w, promptInFlight: false, stoppedEarly: false }
    val settled = settleAndResumeAuthor(ended, List(CloseFeedWithoutStopReason))
    if (issued(ended, settled)) settled else closeFeedWithoutStopReason(settled)
  }

  pure def onRpcError(w: World, purpose: RpcPurpose): World = match purpose {
    | Initialize => restartOrFailTask(w, List())
    | SessionNew => restartOrFailTask(w, List())
    | SetEffort => sendFirstPrompt(w)
    | Prompt => settleAndResumeAuthor({ ...w, promptInFlight: false }, List())
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
    | StartEnds => { ...w, startTracked: false }
    | SettleAfterDrain => markAuthorInReview(w)
    | CloseFeedWithoutStopReason => closeFeedWithoutStopReason(w)
    | AlarmEnds(_) => w
    | RestartAfterClose(began) =>
      if (isFinished(w.status) or w.generation != began.generation or w.restarts != began.restarts) w
      else if (w.paused) holdRestartForResume(w)
      else restartSandbox(w, rest)
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
    { ...w, bridges: w.bridges.append({ generation: generation, token: token, alive: true, saidHello: false, requests: List() }) }

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
    w.bridges[bridge].requests.length() > 0,
    w.bridges[bridge].requests[0].purpose == Prompt,
  }

  /// True when the frame a bridge sends lands on a socket of the current generation.
  pure def served(w: World, bridge: int): bool =
    connectedSocketsOf(w, bridge).select(socket => socket.generation == w.generation).length() > 0

  pure def withoutFirstRequest(w: World, bridge: int): World =
    changeBridges(w, Set(bridge), process => { ...process, requests: process.requests.tail() })

  /// A harness turn runs: a prompt is in flight and a connected bridge of the task works on one.
  pure def turnRunning(w: World): bool =
    w.promptInFlight and w.bridges.indices().exists(bridge => runsATurn(w, bridge))

  /// The turn of the author is running or about to start.
  pure def atWork(w: World): bool =
    w.status == Queued or w.status == Provisioning or w.promptInFlight or handshakePending(w)

  pure def sentPrompt(step: Step): bool = step.after.promptsSent > step.before.promptsSent

  pure def sentCancel(step: Step): bool = step.after.cancelsDelivered > step.before.cancelsDelivered

  pure def endedAStop(step: Step): bool = step.after.stopsEnded > step.before.stopsEnded

  pure def recoveredALostTurn(step: Step): bool =
    step.after.lostTurnsRecovered > step.before.lostTurnsRecovered

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

  /// PROPOSED, T4. A sandbox start moves the task to provisioning in the next generation with a
  /// new bridge token. The harness session, the prompt in flight, the rpc rows, the nudge, the keep
  /// alive and the time of the last bridge close are cleared, and the hello timeout of the new
  /// generation is armed.
  pure def aSandboxStartBeginsAFreshGenerationIn(step: Step): bool =
    step.after.generation != step.before.generation implies and {
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

  /// PROPOSED, T5. A provisioning task becomes working only when its bridge says hello, or when a
  /// stop ends the turn it was starting.
  pure def aStartingTaskWorksOnlyAfterItsHelloIn(step: Step): bool =
    (step.before.status == Provisioning and step.after.status == Working) implies
      (step.kind == HelloStep or endedAStop(step))

  /// PROPOSED, T19. An author in review becomes working only in a step that sends it a prompt.
  pure def anAuthorInReviewWorksOnlyWithAPromptIn(step: Step): bool =
    (step.before.status == InReview and step.after.status == Working) implies sentPrompt(step)

  /// PROPOSED, T21. The recovery of a lost turn does not count a restart.
  pure def aLostTurnIsRecoveredWithoutARestartIn(step: Step): bool =
    recoveredALostTurn(step) implies step.after.restarts == step.before.restarts

  /// PROPOSED, T22. A harness exit on an unfinished task with restarts left counts one restart and
  /// starts the next generation. The orchestrator does not close a socket for it.
  pure def aHarnessExitCountsOneRestartIn(step: Step): bool =
    (step.kind == ExitStep and not(isFinished(step.before.status)) and step.before.restarts < MAX_RESTARTS) implies and {
      step.after.restarts == step.before.restarts + 1,
      step.after.generation == step.before.generation + 1,
      not(closedASocket(step)),
    }

  /// PROPOSED, T23. A sandbox start of the current generation that throws on an unfinished task
  /// fails it, or closes its container to restart it. One of an older generation changes nothing.
  pure def aFailedSandboxStartRestartsOrFailsIn(step: Step): bool = match step.kind {
    | StartFailedStep(generation) =>
      if (generation != step.before.generation) and {
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

  /// PROPOSED, T29. A prompt the harness refuses is no longer in flight, unless the next prompt
  /// went out in the same step.
  pure def aRefusedPromptLeavesTheTurnIn(step: Step): bool =
    step.kind == PromptRefusedStep implies (not(step.after.promptInFlight) or sentPrompt(step))

  /// PROPOSED, T40. The provision alarm starts a sandbox only for a queued task.
  pure def provisionStartsOnlyAQueuedTaskIn(step: Step): bool =
    (step.kind == ProvisionStep and step.before.status != Queued) implies not(changedBesidesAlarms(step))

  /// PROPOSED, T42. The wall clock fails a task whose turn is in flight, without a restart.
  pure def wallClockFailsWithoutARestartIn(step: Step): bool =
    (step.kind == WallClockStep and step.before.promptInFlight and not(step.before.paused) and not(isFinished(step.before.status))) implies
      (step.after.status == Failed and step.after.restarts == step.before.restarts)

  /// PROPOSED, T50. A bridge connects only with the task's current token, and its socket is then
  /// the only one the task lists.
  pure def aBridgeConnectsOnlyWithTheCurrentTokenIn(step: Step): bool =
    openedASocket(step) implies and {
      step.after.sockets.length() > 0,
      step.after.bridges[step.after.sockets[step.after.sockets.length() - 1].bridge].token == step.before.token,
      listedSockets(step.after) <= 1,
    }

  /// PROPOSED, T26. A turn outcome does not restart or fail the author while a prompt sent after
  /// that turn ended is in flight.
  pure def aLaterPromptSurvivesTheOutcomeOfAnEarlierTurnIn(step: Step): bool =
    step.kind == OutcomeStep({ laterPromptInFlight: true }) implies and {
      step.after.restarts == step.before.restarts,
      step.after.status != Failed,
      not(issued(step.before, step.after)),
    }

  /// Whether one step kept each before-and-after rule.
  pure def rulesKeptIn(step: Step): RulesKept = {
    finishedTaskKeepsItsStatus: finishedTaskKeepsItsStatusIn(step),
    pausedAuthorGetsNoPrompt: pausedAuthorGetsNoPromptIn(step),
    staleAlarmIsIgnored: staleAlarmIsIgnoredIn(step),
    stopEndsTheAuthorsTurn: stopEndsTheAuthorsTurnIn(step),
    aSandboxStartBeginsAFreshGeneration: aSandboxStartBeginsAFreshGenerationIn(step),
    aStartingTaskWorksOnlyAfterItsHello: aStartingTaskWorksOnlyAfterItsHelloIn(step),
    anAuthorInReviewWorksOnlyWithAPrompt: anAuthorInReviewWorksOnlyWithAPromptIn(step),
    aLostTurnIsRecoveredWithoutARestart: aLostTurnIsRecoveredWithoutARestartIn(step),
    aHarnessExitCountsOneRestart: aHarnessExitCountsOneRestartIn(step),
    aFailedSandboxStartRestartsOrFails: aFailedSandboxStartRestartsOrFailsIn(step),
    aRefusedPromptLeavesTheTurn: aRefusedPromptLeavesTheTurnIn(step),
    provisionStartsOnlyAQueuedTask: provisionStartsOnlyAQueuedTaskIn(step),
    wallClockFailsWithoutARestart: wallClockFailsWithoutARestartIn(step),
    aBridgeConnectsOnlyWithTheCurrentToken: aBridgeConnectsOnlyWithTheCurrentTokenIn(step),
    aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn: aLaterPromptSurvivesTheOutcomeOfAnEarlierTurnIn(step),
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
    aLostTurnIsRecovered: recoveredALostTurn(step),
    aHarnessExitRestartsTheTask:
      step.kind == ExitStep and not(isFinished(step.before.status)) and step.before.restarts < MAX_RESTARTS,
    aSandboxStartFails: match step.kind {
      | StartFailedStep(generation) => generation == step.before.generation and not(isFinished(step.before.status))
      | _ => false
    },
    aStaleSandboxStartFails: match step.kind {
      | StartFailedStep(generation) => generation != step.before.generation and not(isFinished(step.before.status))
      | _ => false
    },
    aStaleRestartIsDropped: and {
      step.kind == OtherStep,
      not(isFinished(step.before.status)),
      step.before.calls.select(call => and {
        call.state == Out,
        isDestroy(call.kind),
        staleRestartAfter(step.before, call),
        step.after.calls.select(kept => kept.id == call.id).length() == 0,
      }).length() > 0,
    },
    aStaleOutcomeCheckIsDropped: match step.kind {
      | OutcomeStep(_) =>
        step.before.calls.select(call => and {
          isOutcomeCheck(call.kind),
          generationOfCall(step.before, call.id) != step.before.generation,
          step.after.calls.select(kept => kept.id == call.id).length() == 0,
        }).length() > 0
      | _ => false
    },
    theHarnessRefusesAPrompt: step.kind == PromptRefusedStep,
    theProvisionAlarmFires: step.kind == ProvisionStep,
    theWallClockFailsATurn:
      step.kind == WallClockStep and step.before.promptInFlight and step.after.status == Failed,
    theKeepAliveFiresOnATurn: step.kind == KeepAliveStep and step.before.promptInFlight,
    aDialIsRefused: step.kind == DialStep,
    aSocketIsReplaced: step.kind == HelloStep and listedSockets(step.before) > 0,
    aResumeLandsDuringACancelledTurn:
      step.before.paused and not(step.after.paused) and turnRunning(step.before),
    aPromptGoesOutDuringAnOutcomeCheck:
      sentPrompt(step) and outCalls(step.after, isOutcomeCheck).size() > 0,
    anAnswerArrivesAfterItsRowWasCleared: match step.kind {
      | AnswerStep(answer) => not(answer.reachedItsOwnRow)
      | _ => false
    },
    theEffortIsSet:
      step.kind == AnswerStep({ reachedItsOwnRow: true, purpose: SetEffort }) and sentPrompt(step),
    aCallWasDropped: step.kind == DurableObjectRestartStep,
    anAlarmRunsAgainAfterARestart:
      step.kind == DurableObjectRestartStep and step.after.alarms.length() > step.before.alarms.length(),
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
  action init: bool = recordStep({ before: INITIAL_WORLD, after: INITIAL_WORLD, kind: OtherStep })

  /// A person writes to the author: a reply in its job session or the agent's `prompt_task`.
  action personPrompts: bool = all {
    world.personPrompts < MAX_PERSON_PROMPTS,
    move(promptTask({ ...world, personPrompts: world.personPrompts + 1 }, PersonPrompt, List()), OtherStep),
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

  /// The agent calls `resume_task` without a text. The tool refuses a finished task.
  action agentResumesAuthor: bool = all {
    not(isFinished(world.status)),
    if (not(world.paused)) move(world, OtherStep)
    else move(promptTask({ ...world, paused: false, promptInFlight: false }, ContinuePrompt, List()), OtherStep),
  }

  /// `endResumingTurn`: the stopped state is written before the container goes.
  pure def endStoppedTurn(w: World): World =
    { ...w, rpcs: List(), promptInFlight: false, status: Working, stopsEnded: w.stopsEnded + 1 }

  /// A person presses Stop in the job session of the author.
  action personStops: bool = {
    val cleared = { ...world, queue: List(), stoppedEarly: false }
    if (connected(cleared) and cleared.session and cleared.promptInFlight) move(sendCancel(cleared), StopStep)
    else if (not(isFinished(cleared.status)) and atWork(cleared))
      move(closeContainer(endStoppedTurn(clearTaskTimers(cleared)), List()), StopStep)
    else move(cleared, StopStep)
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
    | BridgeLost(generation) => generation != w.generation
  }

  pure def onAlarm(w: World, kind: AlarmKind): World = match kind {
    | Provision => if (w.status == Queued) startSandbox(w, List()) else w
    | HelloTimeout(_) =>
      if (w.status != Provisioning) w
      else if (w.startTracked) { ...arm(w, HelloTimeout(w.generation)), helloSlot: Armed(w.nextAlarm) }
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
    | BridgeLost(_) => onBridgeLostNow(w)
  }

  pure def alarmStep(w: World, kind: AlarmKind): StepKind =
    if (isStale(w, kind)) StaleAlarmStep
    else match kind {
      | Provision => ProvisionStep
      | WallClock => WallClockStep
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
      | RestartAfterClose(began) => began.generation != w.generation or began.restarts != w.restarts
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

  /// The Durable Object restarts while a call is out. The calls are lost with the isolate. A destroy
  /// that was out still takes the container. A start that was out may still bring its container up.
  /// An alarm whose handler awaited a lost call is scheduled again, because its row is deleted only
  /// when the handler ends.
  action durableObjectRestarts: bool = all {
    world.faults < MAX_FAULTS,
    world.calls.select(call => call.state == Out).length() > 0,
    val lost = world.calls.foldl({ ...world, calls: List(), startTracked: false, faults: world.faults + 1 }, (restarted, call) =>
      if (call.state != Out) { ...restarted, calls: restarted.calls.append(call) }
      else {
        val rescheduled = { ...restarted, alarms: restarted.alarms.concat(alarmsAwaiting(call)) }
        match call.kind {
          | SandboxDestroy(generation) => containerGoes(rescheduled, generation)
          | SandboxStart(start) =>
            if (start.launched) rescheduled
            else { ...rescheduled, calls: rescheduled.calls.append({ ...call, state: Dropped, rest: List() }) }
          | OutcomeCheck(_) => rescheduled
        }
      })
    move(lost, DurableObjectRestartStep),
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
        move(goOn(failed, handled, rest), StartFailedStep(generation))
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

  pure def onOutcome(w: World, outcome: Outcome): World = {
    val recorded = { ...w, stoppedEarly: outcome == StoppedEarly }
    match outcome {
      | Blocked =>
        if (isFinished(recorded.status)) recorded
        else restartOrFailTask({ ...recorded, queue: recorded.queue.append(GaveUpWake) }, List())
      | StoppedEarly =>
        if (isFinished(recorded.status) or recorded.promptInFlight or recorded.queue.length() > 0)
          settleAndResumeAuthor(recorded, List())
        else if (recorded.nudged) restartOrFailTask(recorded, List())
        else settleAndResumeAuthor(nudgeOrRestartStalledTask(recorded, List()), List())
      | _ => settleAndResumeAuthor(recorded, List())
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
    move(if (current) onOutcome(checked, outcome) else checked, OutcomeStep({ laterPromptInFlight: later })),
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

  pure def answerable(w: World, bridge: int): bool = and {
    w.bridges[bridge].alive,
    connectedSocketsOf(w, bridge).length() > 0,
    w.bridges[bridge].requests.length() > 0,
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
    })

  /// The harness answers its oldest request. A prompt ends its turn, cancelled when a cancel
  /// reached it.
  action harnessAnswers: bool = all {
    world.bridges.indices().exists(bridge => answerable(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => answerable(world, index)).oneOf()
    nondet finished = Set(EndTurn, MaxTokens).oneOf()
    val request = world.bridges[bridge].requests[0]
    val stop = if (request.cancelled) CancelledTurn else finished
    val answered = withoutFirstRequest(world, bridge)
    val ownRow = served(world, bridge) and world.rpcs.select(row => row.serial == request.serial).length() > 0
    move(
      if (served(world, bridge)) onAnswer(answered, request, stop) else answered,
      AnswerStep({ reachedItsOwnRow: ownRow, purpose: request.purpose }),
    ),
  }

  /// The harness answers its oldest request with an error.
  action harnessRefuses: bool = all {
    world.faults < MAX_FAULTS,
    world.bridges.indices().exists(bridge => answerable(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => answerable(world, index)).oneOf()
    val request = world.bridges[bridge].requests[0]
    val answered = { ...withoutFirstRequest(world, bridge), faults: world.faults + 1 }
    val refused =
      if (not(served(world, bridge))) answered
      else rowsWith(answered, request.id).foldl(takeRow(answered, request), (taken, row) => onRpcError(taken, row.purpose))
    val promptRefused = served(world, bridge) and rowsWith(world, request.id).select(row => row.purpose == Prompt).length() > 0
    move(refused, if (promptRefused) PromptRefusedStep else OtherStep),
  }

  /// The harness reports a tool call or a todo list change during its turn.
  action harnessShowsProgress: bool = all {
    world.bridges.indices().exists(bridge => runsATurn(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => runsATurn(world, index)).oneOf()
    move(if (served(world, bridge)) touchProgress(world) else world, OtherStep),
  }

  /// The harness writes the page and prints its link during its turn. `recordArtifact` stores it
  /// and moves an author without a prompt in flight to review.
  action harnessWritesThePage: bool = all {
    not(world.artifact),
    world.bridges.indices().exists(bridge => runsATurn(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => runsATurn(world, index)).oneOf()
    move(
      if (served(world, bridge) and not(isFinished(world.status))) markAuthorInReview({ ...world, artifact: true })
      else world,
      OtherStep,
    ),
  }

  /// The harness asks permission for a tool call during its turn. The orchestrator answers on the
  /// socket the request came on.
  action harnessAsksPermission: bool = all {
    world.bridges.indices().exists(bridge => runsATurn(world, bridge)),
    nondet bridge = world.bridges.indices().filter(index => runsATurn(world, index)).oneOf()
    move(
      if (served(world, bridge))
        { ...world, permissionsAsked: world.permissionsAsked + 1, permissionsAllowed: world.permissionsAllowed + 1 }
      else world,
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

  /// A step picks a prompt, the clock, an interruption and a report of the harness each as often
  /// as one event of a call, a socket or the harness, so a random walk of 25 steps reaches the end
  /// of a turn.
  action step: bool = any {
    personPrompts,
    timeMoves,
    theWorkIsInterrupted,
    sandboxStartLaunchesBridge,
    sandboxStartReturns,
    sandboxDestroyReturns,
    outcomeCheckReturns,
    bridgeDials,
    socketCloseLands,
    harnessAnswers,
    harnessWritesThePage,
    theHarnessReportsItsWork,
    theAgentPausesARunningTurn,
  }

  pure def noCallOut(w: World): bool = w.calls.select(call => call.state == Out).length() == 0

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
  /// in flight, or it is restarting, or its task finished. The world checks it only between steps
  /// that ran to their end, so a state with a call out is not checked.
  val anIdleAuthorWithUnfinishedWorkIsNeverLeftAlone: bool =
    (noCallOut(world) and world.stoppedEarly and not(isFinished(world.status)) and not(world.promptInFlight)) implies
      (world.queue.length() > 0 or world.status == Provisioning or handshakePending(world))

  /// A stop drops the queued prompts. It cancels a running turn. Once its work ran to the end, the
  /// author does not resume unless its task finished.
  val stopEndsTheAuthorsTurn: bool = rulesKept.stopEndsTheAuthorsTurn

  /// PROPOSED, T4. A sandbox start moves the task to provisioning in the next generation with a
  /// new bridge token. The harness session, the prompt in flight, the rpc rows, the nudge, the keep
  /// alive and the time of the last bridge close are cleared, and the hello timeout of the new
  /// generation is armed.
  val aSandboxStartBeginsAFreshGeneration: bool = rulesKept.aSandboxStartBeginsAFreshGeneration

  /// PROPOSED, T5. A provisioning task becomes working only when its bridge says hello, or when a
  /// stop ends the turn it was starting.
  val aStartingTaskWorksOnlyAfterItsHello: bool = rulesKept.aStartingTaskWorksOnlyAfterItsHello

  /// PROPOSED, T19. An author in review becomes working only in a step that sends it a prompt.
  val anAuthorInReviewWorksOnlyWithAPrompt: bool = rulesKept.anAuthorInReviewWorksOnlyWithAPrompt

  /// PROPOSED, T21. The recovery of a lost turn does not count a restart.
  val aLostTurnIsRecoveredWithoutARestart: bool = rulesKept.aLostTurnIsRecoveredWithoutARestart

  /// PROPOSED, T22. A harness exit on an unfinished task with restarts left counts one restart and
  /// starts the next generation. The orchestrator does not close a socket for it.
  val aHarnessExitCountsOneRestart: bool = rulesKept.aHarnessExitCountsOneRestart

  /// PROPOSED, T23. A sandbox start of the current generation that throws on an unfinished task
  /// fails it, or closes its container to restart it. One of an older generation changes nothing.
  val aFailedSandboxStartRestartsOrFails: bool = rulesKept.aFailedSandboxStartRestartsOrFails

  /// A bridge of the current generation that can still move the task: it can dial in, or it holds
  /// a request to answer.
  pure def bridgeCanMoveTheTask(w: World): bool =
    w.bridges.indices().exists(bridge => and {
      w.bridges[bridge].alive,
      w.bridges[bridge].generation == w.generation,
      w.bridges[bridge].token == w.token,
      canDial(w, bridge) or (connectedSocketsOf(w, bridge).length() > 0 and w.bridges[bridge].requests.length() > 0),
    })

  /// An alarm whose handler moves the task in the state it would fire in now.
  pure def alarmMovesTheTask(w: World): bool =
    w.alarms.select(alarm => match alarm.kind {
      | Provision => w.status == Queued
      | HelloTimeout(generation) => generation == w.generation and w.status == Provisioning
      | NoProgress(generation) => generation == w.generation and w.promptInFlight
      | BridgeLost(generation) => generation == w.generation and w.promptInFlight
      | RetryQueue(generation) => generation == w.generation
      | WallClock => w.promptInFlight
      | KeepAlive(_) => false
    }).length() > 0

  /// PROPOSED, T24 and T45. An unpaused task with work to do always has a way forward: a call out,
  /// an alarm that acts on it, a bridge of its generation that can answer or dial in, or the close
  /// of a socket under a prompt in flight.
  val anUnpausedTaskWithWorkIsNeverStranded: bool =
    (not(isFinished(world.status)) and not(world.paused) and (world.queue.length() > 0 or atWork(world))) implies or {
      not(noCallOut(world)),
      alarmMovesTheTask(world),
      bridgeCanMoveTheTask(world),
      world.promptInFlight and world.sockets.length() > 0,
    }

  /// PROPOSED, T29. A prompt the harness refuses is no longer in flight, unless the next prompt
  /// went out in the same step.
  val aRefusedPromptLeavesTheTurn: bool = rulesKept.aRefusedPromptLeavesTheTurn

  /// PROPOSED, T40. The provision alarm starts a sandbox only for a queued task.
  val provisionStartsOnlyAQueuedTask: bool = rulesKept.provisionStartsOnlyAQueuedTask

  /// PROPOSED, T42. The wall clock fails a task whose turn is in flight, without a restart.
  val wallClockFailsWithoutARestart: bool = rulesKept.wallClockFailsWithoutARestart

  /// PROPOSED, T44. While a turn of an unfinished task is in flight in a harness session, the keep
  /// alive alarm of its generation is armed.
  val aRunningTurnKeepsItsSandboxAwake: bool =
    (world.promptInFlight and world.session and not(isFinished(world.status))) implies match world.keepAliveSlot {
      | Armed(id) => world.alarms.select(alarm => alarm.id == id and alarm.kind == KeepAlive(world.generation)).length() == 1
      | Unarmed => false
    }

  /// PROPOSED, T50. A bridge connects only with the task's current token, and its socket is then
  /// the only one the task lists.
  val aBridgeConnectsOnlyWithTheCurrentToken: bool = rulesKept.aBridgeConnectsOnlyWithTheCurrentToken

  /// PROPOSED, T51. The orchestrator allows every permission request of the current generation.
  val everyPermissionRequestIsAllowed: bool = world.permissionsAllowed == world.permissionsAsked

  /// PROPOSED, T7 and A39. A harness session runs one turn at a time: no bridge holds two prompts.
  val aHarnessSessionRunsOneTurnAtATime: bool =
    world.bridges.select(bridge => bridge.requests.select(request => request.purpose == Prompt).length() > 1).length() == 0

  /// PROPOSED, T7. An author in review runs no turn and no handshake.
  val anAuthorInReviewRunsNoTurn: bool =
    world.status == InReview implies (not(world.promptInFlight) and not(handshakePending(world)))

  /// PROPOSED, T26. A turn outcome does not restart or fail the author while a prompt sent after
  /// that turn ended is in flight.
  val aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn: bool = rulesKept.aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn

  /// PROPOSED. A harness answer reaches only the request it answers, never a later request that
  /// took the same rpc id.
  val anAnswerReachesOnlyItsOwnRequest: bool = world.answersToOtherRequests == 0

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
    aLostTurnIsRecoveredWithoutARestart,
    aHarnessExitCountsOneRestart,
    aFailedSandboxStartRestartsOrFails,
    anUnpausedTaskWithWorkIsNeverStranded,
    aRefusedPromptLeavesTheTurn,
    provisionStartsOnlyAQueuedTask,
    wallClockFailsWithoutARestart,
    aRunningTurnKeepsItsSandboxAwake,
    aBridgeConnectsOnlyWithTheCurrentToken,
    everyPermissionRequestIsAllowed,
    aHarnessSessionRunsOneTurnAtATime,
    anAuthorInReviewRunsNoTurn,
    aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn,
    anAnswerReachesOnlyItsOwnRequest,
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

  /// Witness for `aStartingTaskWorksOnlyAfterItsHello`: a hello moves the task to working.
  val aHelloMovesTheTaskToWorking: bool = stepWitnesses.aHelloMovesTheTaskToWorking

  /// Witness for `anAuthorInReviewWorksOnlyWithAPrompt`: an author in review takes a prompt.
  val anAuthorInReviewTakesAPrompt: bool = stepWitnesses.anAuthorInReviewTakesAPrompt

  /// Witness for `aLostTurnIsRecoveredWithoutARestart`: a lost turn is recovered.
  val aLostTurnIsRecovered: bool = stepWitnesses.aLostTurnIsRecovered

  /// Witness for `aHarnessExitCountsOneRestart`: the harness exits on a task with restarts left.
  val aHarnessExitRestartsTheTask: bool = stepWitnesses.aHarnessExitRestartsTheTask

  /// Witness for `aFailedSandboxStartRestartsOrFails`: a sandbox start throws.
  val aSandboxStartFails: bool = stepWitnesses.aSandboxStartFails

  /// Witness for `taskRestartsAtMostTwice`: the start of an older generation throws.
  val aStaleSandboxStartFails: bool = stepWitnesses.aStaleSandboxStartFails

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

  /// Witness for `aRunningTurnKeepsItsSandboxAwake`: the keep alive alarm fires on a turn in flight.
  val theKeepAliveFiresOnATurn: bool = stepWitnesses.theKeepAliveFiresOnATurn

  /// Witness for `aBridgeConnectsOnlyWithTheCurrentToken`: a dial with an old token is refused.
  val aDialIsRefused: bool = stepWitnesses.aDialIsRefused

  /// Witness for `aBridgeConnectsOnlyWithTheCurrentToken`: a new socket replaces a listed one.
  val aSocketIsReplaced: bool = stepWitnesses.aSocketIsReplaced

  /// Witness for `everyPermissionRequestIsAllowed`: a permission request is allowed.
  val aPermissionIsAllowed: bool = world.permissionsAllowed > 0

  /// Witness for `aHarnessSessionRunsOneTurnAtATime`: a harness turn runs.
  val aTurnRuns: bool = turnRunning(world)

  /// Witness for `anAuthorInReviewRunsNoTurn`: a resume while the harness still runs the turn the
  /// pause cancelled.
  val aResumeLandsDuringACancelledTurn: bool = stepWitnesses.aResumeLandsDuringACancelledTurn

  /// Witness for `aLaterPromptSurvivesTheOutcomeOfAnEarlierTurn`: a prompt goes out while an
  /// outcome check is out.
  val aPromptGoesOutDuringAnOutcomeCheck: bool = stepWitnesses.aPromptGoesOutDuringAnOutcomeCheck

  /// Witness for `anAnswerReachesOnlyItsOwnRequest`: the harness answers a request after the
  /// orchestrator cleared its rpc row.
  val anAnswerArrivesAfterItsRowWasCleared: bool = stepWitnesses.anAnswerArrivesAfterItsRowWasCleared

  /// The stage asked for an effort and the harness session took it before its first prompt.
  val theEffortIsSet: bool = stepWitnesses.theEffortIsSet

  /// A restart of the Durable Object dropped a call.
  val aCallWasDropped: bool = stepWitnesses.aCallWasDropped

  /// A restart of the Durable Object cut an alarm's handler, and the alarm runs again.
  val anAlarmRunsAgainAfterARestart: bool = stepWitnesses.anAlarmRunsAgainAfterARestart

  /// The author was nudged.
  val theAuthorWasNudged: bool = world.nudged

  /// The agent cancelled the task.
  val theTaskWasCancelled: bool = world.status == Cancelled
}
