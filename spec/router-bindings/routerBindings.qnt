/// How the router routes chat, tracker and code host events to conversations, and how each
/// conversation's workflows write their rows and bindings in the router's tables.
/// Each action is one stretch of code between two awaits. A D1 statement and a Durable Object
/// call each end a stretch. The statement lands when the next stretch of its caller runs. An await
/// that does not touch the router's tables or another conversation stays inside its stretch.
/// An event goes to the conversation a binding of it leads to, through a workflow whose row has not
/// ended. Else it goes to its place's conversation, which a start records and any other event
/// needs recorded. Else the router drops it. A push to the repository's base branch fans out to
/// every conversation with a pull request bound in the repository, one call at a time. An event on
/// a watched pull request goes to its routed conversation and to every watcher's conversation, one
/// call at a time. A firing on the pull request opens the conversation of the pull request and its
/// definition, and its workflow keeps the watch while it is active.
module routerBindingsTypes {
  /// What a conversation belongs to: a chat thread, a tracker issue with every session on it, a
  /// tracker session without an issue, or the watched pull request with one workflow definition.
  type Place = Thread | IssuePlace | LooseSession | PullRequestPlace(int)

  /// An external object a workflow binds: the issue its job claims, and two pull requests in one
  /// repository.
  type Key = Issue | Pull | SecondPull

  /// Where an event comes from. A tracker session on the issue carries the issue's binding and the
  /// issue's place. A pull request carries its binding and no place. The base branch carries
  /// neither.
  type Surface = ThreadSurface | SessionSurface | LooseSessionSurface | PullSurface | BaseSurface

  /// The place of a surface, or none.
  type PlaceOf = NoPlace | AtPlace(Place)

  /// A start opens its place's conversation. A reply is any other event: a person's message, a
  /// status question, or a code host event. A base move is a push to the base branch. A close is a
  /// merge or a close of the pull request.
  type EventKind = Start | Reply | BaseMoved | Closed

  /// What one binding pointed at when a job start read it: no workflow, or one workflow.
  type Bound = Unbound | BoundTo(int)

  /// The status of a workflow's row in D1.
  type RowStatus = Live | Ended

  /// The status of a workflow in its conversation's store. `Ending` holds from the start of the
  /// end until its bindings are gone.
  type WorkflowStatus = Running | Ending | Done

  /// Where a delivery stands. It reads the binding at an index of its surface's bindings, records
  /// or checks its place, or hands the event to a conversation. A base move reads the
  /// conversations with a pull request bound, then hands the event to each one left in turn. An
  /// event on the pull request reads its watchers once its route is found, with the conversation
  /// the route leads to or none, then hands the event to that conversation and each watcher in turn.
  type DeliveryPhase =
    | ReadingBinding(int)
    | RecordingConversation
    | CheckingConversation
    | Handling(Place)
    | ReadingPulls
    | ReadingWatchers(PlaceOf)
    | FanningOut({ conversation: Place, left: Set[Place] })

  /// One event in the router. `handed` lists each conversation it called, in order, and `returned`
  /// holds those whose call returned. `watchersRunning` holds the running workflows of the watchers
  /// it read.
  type Delivery = {
    surface: Surface,
    kind: EventKind,
    phase: DeliveryPhase,
    handed: List[Place],
    returned: Set[Place],
    watchersRunning: Set[int],
  }

  /// Where a workflow's own D1 work stands. The plan writes the row of the workflow it creates, and
  /// a firing on the pull request writes the row of the workflow it creates. A row write with a live
  /// status in a pull request's conversation keeps its watch in the same batch. A restarted
  /// instance writes the row of its active workflow with the status it read, then goes on with an
  /// end it stored. The end writes the row, then deletes every binding and the watch of the workflow.
  /// A job start on the issue reads the issue's binding, may read the row of the workflow it points
  /// at, then claims it. A pull request is bound before it is recorded.
  type OperationPhase =
    | PlanWritesRow
    | FireWritesRow
    | RestartWritesRow(RowStatus)
    | EndWritesStatus
    | EndUnbinds
    | JobReadsIssueBinding
    | JobReadsBoundWorkflow(int)
    | JobBindsIssue(Bound)
    | PullBinds(Key)

  /// One stretch of work a workflow does against the router's tables.
  type WorkflowOperation = { workflow: int, phase: OperationPhase }

  /// One workflow in its conversation's store. `hasIssueJob` is true while it has an unfinished
  /// job on the issue. `recordedPulls` holds the pull requests it recorded once their bind returned.
  type Workflow = {
    conversation: Place,
    status: WorkflowStatus,
    hasIssueJob: bool,
    recordedPulls: Set[Key],
  }

  /// The router's tables, the conversations, and every delivery and workflow operation in flight.
  /// `recorded` holds the places the router recorded a conversation for. `opened` holds the places
  /// whose conversation took its first event or firing. `watches` holds the definitions that watch
  /// the pull request.
  type World = {
    bindings: Key -> int,
    watches: Set[int],
    rows: int -> RowStatus,
    recorded: Set[Place],
    opened: Set[Place],
    workflows: int -> Workflow,
    deliveries: int -> Delivery,
    operations: int -> WorkflowOperation,
    nextWorkflow: int,
    nextDelivery: int,
    nextOperation: int,
  }

  /// Where one binding led in one state: to no conversation, or to the conversation of a workflow
  /// whose row has not ended.
  type Led = NotLed | LedTo(Place)

  /// What a delivery saw over its life: where each binding of its surface led, whether its place
  /// was recorded, and which definitions watched the pull request, in every state from its arrival.
  type Observation = { led: List[Set[Led]], recorded: Set[bool], watching: Set[Set[int]] }

  /// How a delivery ended: handed to a conversation, or dropped.
  type Outcome = Delivered(Place) | Dropped

  /// Whether the last step kept each rule that compares two states.
  type StepKept = {
    aDeliveryNeverCreatesAWorkflow: bool,
    anEventReachesItsBoundOrPlaceConversation: bool,
    aWatchedObjectsEventReachesEveryWatcher: bool,
    aClosedPullRequestEndsItsWatchers: bool,
  }

  /// What the last step showed that its end state does not.
  type StepWitnesses = {
    bindingLedAway: bool,
    replyReachedItsPlace: bool,
    replyDropped: bool,
    routerEndedBeforeTheFirstCall: bool,
    fanOutWentOnPastAFailure: bool,
    endRemovedAnIssueBinding: bool,
    claimLandedAfterTheEnd: bool,
    lateRowWriteFoundTheEnd: bool,
    restartCutTheEndStatusWrite: bool,
    restartCutTheDeletes: bool,
    restartCutThePullRequestBind: bool,
    mergeEndedTwoWatchers: bool,
    commentReachedTheOwnerAndTheWatcher: bool,
    lateWatchWriteFoundTheEnd: bool,
  }
}

/// The router and the conversations on the surfaces of one setup.
module routerBindings {
  import routerBindingsTypes.*

  /// The surfaces events come from.
  const SURFACES: Set[Surface]

  /// How many deliveries run at once.
  const MAX_DELIVERIES: int

  /// The pull requests the workflows may open.
  const PULLS: Set[Key]

  /// The workflow definitions whose triggers fire on the pull request's events.
  const DEFINITIONS: Set[int]

  /// The kinds the pull request's events take.
  const PULL_EVENT_KINDS: Set[EventKind]

  /// How many workflow operations run at once.
  pure val MAX_OPERATIONS: int = 2

  pure val ALL_PLACES: Set[Place] =
    Set(Thread, IssuePlace, LooseSession).union(DEFINITIONS.map(definition => PullRequestPlace(definition)))

  pure val NO_STEP_WITNESSES: StepWitnesses = {
    bindingLedAway: false,
    replyReachedItsPlace: false,
    replyDropped: false,
    routerEndedBeforeTheFirstCall: false,
    fanOutWentOnPastAFailure: false,
    endRemovedAnIssueBinding: false,
    claimLandedAfterTheEnd: false,
    lateRowWriteFoundTheEnd: false,
    restartCutTheEndStatusWrite: false,
    restartCutTheDeletes: false,
    restartCutThePullRequestBind: false,
    mergeEndedTwoWatchers: false,
    commentReachedTheOwnerAndTheWatcher: false,
    lateWatchWriteFoundTheEnd: false,
  }

  pure val ALL_KEPT: StepKept = {
    aDeliveryNeverCreatesAWorkflow: true,
    anEventReachesItsBoundOrPlaceConversation: true,
    aWatchedObjectsEventReachesEveryWatcher: true,
    aClosedPullRequestEndsItsWatchers: true,
  }

  pure val INITIAL_WORLD: World = {
    bindings: Map(),
    watches: Set(),
    rows: Map(),
    recorded: Set(),
    opened: Set(),
    workflows: Map(),
    deliveries: Map(),
    operations: Map(),
    nextWorkflow: 0,
    nextDelivery: 0,
    nextOperation: 0,
  }

  var world: World
  var observations: int -> Observation
  var stepKept: StepKept
  var stepWitnesses: StepWitnesses

  pure def keysOf(surface: Surface): List[Key] = match surface {
    | SessionSurface => List(Issue)
    | PullSurface => List(Pull)
    | _ => List()
  }

  pure def placeOf(surface: Surface): PlaceOf = match surface {
    | ThreadSurface => AtPlace(Thread)
    | SessionSurface => AtPlace(IssuePlace)
    | LooseSessionSurface => AtPlace(LooseSession)
    | _ => NoPlace
  }

  pure def kindsOf(surface: Surface): Set[EventKind] = match surface {
    | PullSurface => PULL_EVENT_KINDS
    | BaseSurface => Set(BaseMoved)
    | _ => Set(Start, Reply)
  }

  pure def isPull(key: Key): bool = key == Pull or key == SecondPull

  /// The order a fan-out hands the event to conversations in. A routed conversation comes before
  /// the watchers.
  pure def placeRank(place: Place): int = match place {
    | Thread => 0
    | IssuePlace => 1
    | LooseSession => 2
    | PullRequestPlace(definition) => 3 + definition
  }

  pure def firstPlace(places: Set[Place]): Place =
    places
      .filter(place => places.forall(other => placeRank(place) <= placeRank(other)))
      .fold(Thread, (found, place) => place)

  pure def isWatcherPlace(place: Place): bool = match place {
    | PullRequestPlace(_) => true
    | _ => false
  }

  /// The conversations of the definitions that watch the pull request.
  pure def watcherPlaces(state: World): Set[Place] =
    state.watches.map(definition => PullRequestPlace(definition))

  pure def keySet(list: List[Key]): Set[Key] = list.foldl(Set(), (found, key) => found.union(Set(key)))

  pure val SETUP_KEYS: Set[Key] = SURFACES.fold(Set(), (found, surface) => found.union(keySet(keysOf(surface))))

  pure def without(entries: int -> a, id: int): int -> a = entries.keys().exclude(Set(id)).mapBy(key => entries.get(key))

  pure def boundOf(state: World, key: Key): Bound =
    if (state.bindings.keys().contains(key)) BoundTo(state.bindings.get(key)) else Unbound

  pure def rowEnded(state: World, workflow: int): bool =
    state.rows.keys().contains(workflow) and state.rows.get(workflow) == Ended

  pure def rowLive(state: World, workflow: int): bool =
    state.rows.keys().contains(workflow) and state.rows.get(workflow) == Live

  pure def statusOf(state: World, workflow: int): WorkflowStatus = state.workflows.get(workflow).status

  pure def isRunning(state: World, workflow: int): bool =
    state.workflows.keys().contains(workflow) and statusOf(state, workflow) == Running

  pure def conversationOf(state: World, workflow: int): Place = state.workflows.get(workflow).conversation

  /// The workflow of a conversation that has not ended, if any.
  pure def activeWorkflowsOf(state: World, place: Place): Set[int] =
    state.workflows.keys().filter(workflow => and {
      conversationOf(state, workflow) == place,
      statusOf(state, workflow) != Done,
    })

  /// The running workflows of the conversations that watch the pull request.
  pure def runningWatchers(state: World): Set[int] =
    state.workflows.keys().filter(workflow =>
      isRunning(state, workflow) and state.watches.exists(definition => conversationOf(state, workflow) == PullRequestPlace(definition)))

  pure def withWorkflow(state: World, workflow: int, change: Workflow => Workflow): World =
    { ...state, workflows: state.workflows.put(workflow, change(state.workflows.get(workflow))) }

  /// Where a binding leads now: the conversation of its workflow while that workflow's row is live.
  pure def ledBy(state: World, key: Key): Led = match boundOf(state, key) {
    | BoundTo(workflow) => if (rowLive(state, workflow)) LedTo(conversationOf(state, workflow)) else NotLed
    | Unbound => NotLed
  }

  /// A row write sets the status unless the row already ended. An ended row stays ended.
  pure def writeRow(state: World, workflow: int, status: RowStatus): World =
    if (rowEnded(state, workflow)) state else { ...state, rows: state.rows.put(workflow, status) }

  /// A claim points the binding at `workflow` only if it still points where the claimer read it,
  /// and the claimer's row is live. A claim on a binding read as unbound inserts it.
  pure def claimWins(state: World, key: Key, previous: Bound, workflow: int): bool =
    boundOf(state, key) == previous and rowLive(state, workflow)

  pure def claim(state: World, key: Key, previous: Bound, workflow: int): World =
    if (claimWins(state, key, previous, workflow)) { ...state, bindings: state.bindings.put(key, workflow) }
    else state

  /// A workflow's own binding write points the binding at it while its row is live.
  pure def bindWhileLive(state: World, key: Key, workflow: int): World =
    if (rowLive(state, workflow)) { ...state, bindings: state.bindings.put(key, workflow) } else state

  /// The end deletes every binding of the workflow, and the watch of its pull request's
  /// conversation.
  pure def unbindAll(state: World, workflow: int): World = {
    val unbound = {
      ...state,
      bindings: state.bindings.keys()
        .filter(key => state.bindings.get(key) != workflow)
        .mapBy(key => state.bindings.get(key)),
    }
    match conversationOf(state, workflow) {
      | PullRequestPlace(definition) => { ...unbound, watches: unbound.watches.exclude(Set(definition)) }
      | _ => unbound
    }
  }

  /// A row write sets the row's status. A live status in a pull request's conversation keeps the
  /// watch in the same batch, which inserts it only while the workflow's row is live.
  pure def writeRowAndWatch(state: World, workflow: int, status: RowStatus): World = {
    val written = writeRow(state, workflow, status)
    match conversationOf(state, workflow) {
      | PullRequestPlace(definition) =>
          if (status == Live and rowLive(written, workflow)) { ...written, watches: written.watches.union(Set(definition)) }
          else written
      | _ => written
    }
  }

  pure def withDelivery(state: World, id: int, delivery: Delivery): World =
    { ...state, deliveries: state.deliveries.put(id, delivery) }

  pure def withPhase(state: World, id: int, phase: DeliveryPhase): World =
    withDelivery(state, id, { ...state.deliveries.get(id), phase: phase })

  pure def finishDelivery(state: World, id: int): World = { ...state, deliveries: without(state.deliveries, id) }

  pure def withOperation(state: World, id: int, phase: OperationPhase): World =
    { ...state, operations: state.operations.put(id, { ...state.operations.get(id), phase: phase }) }

  pure def finishOperation(state: World, id: int): World = { ...state, operations: without(state.operations, id) }

  pure def startOperation(state: World, workflow: int, phase: OperationPhase): World = {
    ...state,
    operations: state.operations.put(state.nextOperation, { workflow: workflow, phase: phase }),
    nextOperation: state.nextOperation + 1,
  }

  /// A route found: to a conversation, or none. The event follows it.
  pure def follow(state: World, id: int, route: PlaceOf): World = match route {
    | AtPlace(place) => withPhase(state, id, Handling(place))
    | NoPlace => finishDelivery(state, id)
  }

  /// An event on the pull request reads its watchers once its route is found. Any other event
  /// follows its route.
  pure def routeTo(state: World, id: int, route: PlaceOf): World =
    if (state.deliveries.get(id).surface == PullSurface) withPhase(state, id, ReadingWatchers(route))
    else follow(state, id, route)

  /// No binding of the surface led anywhere. The event goes to its place: a start records it, any
  /// other event checks it. An event without a place has no route.
  pure def afterBindings(state: World, id: int): World = {
    val delivery = state.deliveries.get(id)
    match placeOf(delivery.surface) {
      | NoPlace => routeTo(state, id, NoPlace)
      | AtPlace(_) => withPhase(state, id, if (delivery.kind == Start) RecordingConversation else CheckingConversation)
    }
  }

  pure def placeOfDelivery(delivery: Delivery): Place = match placeOf(delivery.surface) {
    | AtPlace(place) => place
    | NoPlace => Thread
  }

  /// The conversations whose workflow has a live row and a pull request bound.
  pure def pullConversations(state: World): Set[Place] =
    state.bindings.keys()
      .filter(key => isPull(key) and rowLive(state, state.bindings.get(key)))
      .map(key => conversationOf(state, state.bindings.get(key)))

  /// Hand the event to the first conversation in `left`, or end the fan-out once none is left.
  pure def fanOutTo(state: World, id: int, left: Set[Place]): World =
    if (left.size() == 0) finishDelivery(state, id)
    else withPhase(state, id, FanningOut({ conversation: firstPlace(left), left: left }))

  /// The call to the current conversation of a fan-out returned or threw. The fan-out goes on.
  pure def fanOutNext(state: World, id: int): World = match state.deliveries.get(id).phase {
    | FanningOut(fanOut) => fanOutTo(state, id, fanOut.left.exclude(Set(fanOut.conversation)))
    | _ => state
  }

  pure def routedPlaces(route: PlaceOf): Set[Place] = match route {
    | AtPlace(place) => Set(place)
    | NoPlace => Set()
  }

  /// The watchers read returns. Without a watcher the event follows its route. Else it fans out to
  /// its routed conversation and every watcher's, and keeps the watchers' running workflows.
  pure def afterWatchers(state: World, id: int, route: PlaceOf): World = {
    val watchers = watcherPlaces(state)
    if (watchers.size() == 0) follow(state, id, route)
    else fanOutTo(
      withDelivery(state, id, { ...state.deliveries.get(id), watchersRunning: runningWatchers(state) }),
      id,
      routedPlaces(route).union(watchers),
    )
  }

  /// Start the end of a running workflow: its store moves it to ending, then it writes its row.
  pure def startEnd(state: World, workflow: int): World =
    startOperation(withWorkflow(state, workflow, flow => { ...flow, status: Ending, hasIssueJob: false }), workflow, EndWritesStatus)

  /// The conversation takes the event. Its first event opens it. It does not refuse any. A close
  /// starts the end of a watcher's running workflow and arms the alarm that goes on with it, so the
  /// call returns once the end started and the end's calls go out from the workflow.
  pure def handOver(state: World, place: Place, kind: EventKind): World = {
    val opened = { ...state, opened: state.opened.union(Set(place)) }
    if (kind == Closed and isWatcherPlace(place))
      activeWorkflowsOf(opened, place)
        .filter(workflow => isRunning(opened, workflow))
        .fold(opened, (ending, workflow) => startEnd(ending, workflow))
    else opened
  }

  /// The conversation a delivery's call goes to, if it waits on one.
  pure def calledPlace(phase: DeliveryPhase): PlaceOf = match phase {
    | Handling(place) => AtPlace(place)
    | FanningOut(fanOut) => AtPlace(fanOut.conversation)
    | _ => NoPlace
  }

  /// The start step of the conversation's restarted instance has its row write out. Every event
  /// and alarm of the conversation waits until the start step returns.
  pure def startStepOut(state: World, place: Place): bool =
    state.operations.keys().exists(id => {
      val operation = state.operations.get(id)
      and {
        conversationOf(state, operation.workflow) == place,
        match operation.phase {
          | RestartWritesRow(_) => true
          | _ => false
        },
      }
    })

  /// The call a delivery waits on goes to a conversation whose start step is out, so it cannot
  /// land yet.
  pure def callWaitsOnAStartStep(state: World, delivery: Delivery): bool = match calledPlace(delivery.phase) {
    | AtPlace(place) => startStepOut(state, place)
    | NoPlace => false
  }

  /// The delivery once the call it waits on returned or threw. A D1 call leaves it as it is.
  pure def afterCall(delivery: Delivery, returned: bool): Delivery = match calledPlace(delivery.phase) {
    | AtPlace(place) => {
        ...delivery,
        handed: delivery.handed.append(place),
        returned: if (returned) delivery.returned.union(Set(place)) else delivery.returned,
      }
    | NoPlace => delivery
  }

  /// The call a delivery waits on returns, and the delivery runs to its next call or its end.
  pure def resumeDelivery(state: World, id: int): World = {
    val delivery = state.deliveries.get(id)
    val surfaceKeys = keysOf(delivery.surface)
    match delivery.phase {
      | ReadingBinding(index) => match ledBy(state, surfaceKeys[index]) {
          | LedTo(place) => routeTo(state, id, AtPlace(place))
          | NotLed => if (index + 1 < surfaceKeys.length()) withPhase(state, id, ReadingBinding(index + 1)) else afterBindings(state, id)
        }
      | RecordingConversation => {
          val place = placeOfDelivery(delivery)
          withPhase({ ...state, recorded: state.recorded.union(Set(place)) }, id, Handling(place))
        }
      | CheckingConversation => {
          val place = placeOfDelivery(delivery)
          if (state.recorded.contains(place)) withPhase(state, id, Handling(place)) else finishDelivery(state, id)
        }
      | Handling(place) => finishDelivery(handOver(state, place, delivery.kind), id)
      | ReadingPulls => fanOutTo(state, id, pullConversations(state))
      | ReadingWatchers(route) => afterWatchers(state, id, route)
      | FanningOut(fanOut) =>
          fanOutNext(handOver(withDelivery(state, id, afterCall(delivery, true)), fanOut.conversation, delivery.kind), id)
    }
  }

  /// The first phase of a delivery that reads the route.
  pure def firstPhase(surface: Surface, kind: EventKind): DeliveryPhase =
    if (kind == BaseMoved) ReadingPulls
    else if (keysOf(surface).length() > 0) ReadingBinding(0)
    else if (kind == Start) RecordingConversation
    else CheckingConversation

  pure def isFanningOut(phase: DeliveryPhase): bool = match phase { | FanningOut(_) => true | _ => false }

  pure def isHandling(phase: DeliveryPhase): bool = match phase { | Handling(_) => true | _ => false }

  /// How a routed delivery ended: handed to the first conversation it called that is not a
  /// watcher, or dropped.
  pure def outcomeOf(delivery: Delivery): Outcome =
    delivery.handed.foldl(Dropped, (found, place) =>
      if (found == Dropped and not(isWatcherPlace(place))) Delivered(place) else found)

  /// What a delivery saw in one state.
  pure def observe(state: World, delivery: Delivery): Observation = {
    led: keysOf(delivery.surface).foldl(List(), (seen, key) => seen.append(Set(ledBy(state, key)))),
    recorded: match placeOf(delivery.surface) {
      | AtPlace(place) => Set(state.recorded.contains(place))
      | NoPlace => Set(false)
    },
    watching: Set(state.watches),
  }

  pure def widen(past: Observation, now: Observation): Observation = {
    led: past.led.indices().fold(past.led, (seen, index) => seen.replaceAt(index, past.led[index].union(now.led[index]))),
    recorded: past.recorded.union(now.recorded),
    watching: past.watching.union(now.watching),
  }

  /// The observations of the deliveries in `after`, widened by what each sees in it.
  pure def observeDeliveries(past: int -> Observation, after: World): int -> Observation =
    after.deliveries.keys().mapBy(id => {
      val now = observe(after, after.deliveries.get(id))
      if (past.keys().contains(id)) widen(past.get(id), now) else now
    })

  pure def onlyLed(seen: Set[Led]): Led = seen.fold(NotLed, (found, led) => led)

  /// Whether the bindings and the place a delivery saw held still over its life.
  pure def routeSteady(observation: Observation, delivery: Delivery): bool = and {
    observation.led.indices().forall(index => observation.led[index].size() == 1),
    delivery.kind == Start or observation.recorded.size() == 1,
  }

  /// Where an event must go when what it saw held still over its life. A binding that led to a
  /// conversation wins, the first in order. Else its place, when the event is a start or the place
  /// was recorded. Else it is dropped.
  pure def expectedOutcome(observation: Observation, delivery: Delivery): Outcome = {
    val led = observation.led.foldl(NotLed, (found, seen) => if (found == NotLed) onlyLed(seen) else found)
    match led {
      | LedTo(place) => Delivered(place)
      | NotLed => match placeOf(delivery.surface) {
          | AtPlace(place) => if (delivery.kind == Start or observation.recorded.contains(true)) Delivered(place) else Dropped
          | NoPlace => Dropped
        }
    }
  }

  pure def routedAsBoundOrPlace(observation: Observation, delivery: Delivery, outcome: Outcome): bool =
    routeSteady(observation, delivery) implies outcome == expectedOutcome(observation, delivery)

  /// A watched event whose route and watchers held still over its life called its expected
  /// conversation and every watcher's, each once, and no other.
  pure def reachedEveryWatcherOnce(observation: Observation, final: Delivery): bool = {
    val watchers = observation.watching
      .fold(Set(), (found, seen) => seen)
      .map(definition => PullRequestPlace(definition))
    val targets = routedPlaces(match expectedOutcome(observation, final) {
      | Delivered(place) => AtPlace(place)
      | Dropped => NoPlace
    }).union(watchers)
    (routeSteady(observation, final) and observation.watching.size() == 1) implies and {
      final.handed.length() == targets.size(),
      targets.forall(place => final.handed.indices().filter(index => final.handed[index] == place).size() == 1),
    }
  }

  /// Every watcher workflow that ran when a close's delivery read the watchers, and whose
  /// conversation's call returned, started its end.
  pure def endedEveryWatcher(after: World, final: Delivery): bool =
    final.watchersRunning.forall(workflow =>
      final.returned.contains(conversationOf(after, workflow)) implies statusOf(after, workflow) != Running)

  /// The rules a delivery step from `before` to `after` keeps. `final` is the delivery once the
  /// step's call returned or threw, and `ended` is true when the step returned the delivery to its
  /// caller. It creates no workflow and writes no workflow row. A routed delivery that ended went
  /// where its bindings or its place say, and a watched one also reached every watcher once. A
  /// close's delivery that ended started the end of every running watcher it reached.
  pure def deliveryStepKept(past: int -> Observation, before: World, after: World, id: int, final: Delivery, ended: bool): StepKept = {
    val delivery = before.deliveries.get(id)
    val checked = ended and past.keys().contains(id)
    {
      aDeliveryNeverCreatesAWorkflow:
        after.workflows.keys() == before.workflows.keys() and after.rows.keys() == before.rows.keys(),
      anEventReachesItsBoundOrPlaceConversation:
        (checked and delivery.kind != BaseMoved) implies routedAsBoundOrPlace(past.get(id), delivery, outcomeOf(final)),
      aWatchedObjectsEventReachesEveryWatcher:
        (checked and delivery.surface == PullSurface) implies reachedEveryWatcherOnce(past.get(id), final),
      aClosedPullRequestEndsItsWatchers:
        (ended and delivery.kind == Closed) implies endedEveryWatcher(after, final),
    }
  }

  /// What a delivery step that removed a routed delivery shows.
  pure def routedWitnesses(final: Delivery, ended: bool, after: World): StepWitnesses = {
    val outcome = outcomeOf(final)
    val routed = ended and final.kind != BaseMoved
    {
      ...NO_STEP_WITNESSES,
      bindingLedAway: routed and (match outcome {
        | Delivered(place) => placeOf(final.surface) != AtPlace(place)
        | Dropped => false
      }),
      replyReachedItsPlace: routed and final.kind == Reply and (match outcome {
        | Delivered(place) => placeOf(final.surface) == AtPlace(place)
        | Dropped => false
      }),
      replyDropped: routed and final.kind == Reply and outcome == Dropped and placeOf(final.surface) != NoPlace,
      mergeEndedTwoWatchers: and {
        ended,
        final.kind == Closed,
        final.watchersRunning.size() == 2,
        final.watchersRunning.forall(workflow =>
          final.returned.contains(conversationOf(after, workflow)) and statusOf(after, workflow) != Running),
      },
      commentReachedTheOwnerAndTheWatcher: and {
        ended,
        final.kind == Reply,
        final.surface == PullSurface,
        final.returned.exists(place => not(isWatcherPlace(place))),
        final.returned.exists(place => isWatcherPlace(place)),
      },
    }
  }

  action advance(after: World, kept: StepKept, witnesses: StepWitnesses): bool = all {
    world' = after,
    observations' = observeDeliveries(observations, after),
    stepKept' = kept,
    stepWitnesses' = witnesses,
  }

  action init: bool = all {
    world' = INITIAL_WORLD,
    observations' = Map(),
    stepKept' = ALL_KEPT,
    stepWitnesses' = NO_STEP_WITNESSES,
  }

  /// An event reaches the router from one surface.
  action eventArrives: bool = {
    nondet surface = SURFACES.oneOf()
    nondet kind = kindsOf(surface).oneOf()
    val delivery = {
      surface: surface,
      kind: kind,
      phase: firstPhase(surface, kind),
      handed: List(),
      returned: Set(),
      watchersRunning: Set(),
    }
    all {
      world.deliveries.keys().size() < MAX_DELIVERIES,
      advance(
        { ...withDelivery(world, world.nextDelivery, delivery), nextDelivery: world.nextDelivery + 1 },
        ALL_KEPT,
        NO_STEP_WITNESSES,
      ),
    }
  }

  /// The call a delivery waits on lands, and the delivery runs to its next call or its end.
  action deliveryResumes: bool = {
    nondet delivery = world.deliveries.keys()
      .filter(id => not(callWaitsOnAStartStep(world, world.deliveries.get(id))))
      .oneOf()
    val final = afterCall(world.deliveries.get(delivery), true)
    val after = resumeDelivery(world, delivery)
    val ended = not(after.deliveries.keys().contains(delivery))
    advance(after, deliveryStepKept(observations, world, after, delivery, final, ended), routedWitnesses(final, ended, after))
  }

  /// The call a fan-out makes throws. The router logs it and goes on to the next conversation.
  action fanOutCallFails: bool = {
    nondet delivery = world.deliveries.keys().filter(id => isFanningOut(world.deliveries.get(id).phase)).oneOf()
    val final = afterCall(world.deliveries.get(delivery), false)
    val after = fanOutNext(withDelivery(world, delivery, final), delivery)
    val ended = not(after.deliveries.keys().contains(delivery))
    advance(after, deliveryStepKept(observations, world, after, delivery, final, ended), {
      ...NO_STEP_WITNESSES,
      fanOutWentOnPastAFailure: not(ended),
    })
  }

  /// The router's invocation ends while a delivery waits on its call, such as on a deploy or a
  /// cancel after the host hung up. The call landed or not. The delivery never resumes, and its
  /// caller gets an error. A call that waits on a start step lands after it, which is the same as
  /// the invocation ending once the start step returned.
  action routerInvocationEnds: bool = {
    nondet delivery = world.deliveries.keys().oneOf()
    nondet landed = (if (callWaitsOnAStartStep(world, world.deliveries.get(delivery))) Set(false) else Set(true, false)).oneOf()
    val phase = world.deliveries.get(delivery).phase
    val written = if (landed) resumeDelivery(world, delivery) else world
    val after = finishDelivery(written, delivery)
    val final = afterCall(world.deliveries.get(delivery), landed)
    advance(after, deliveryStepKept(observations, world, after, delivery, final, false), {
      ...NO_STEP_WITNESSES,
      routerEndedBeforeTheFirstCall: match phase {
        | Handling(place) => not(landed) and not(world.opened.contains(place))
        | _ => false
      },
    })
  }

  action startWorkflowOperation(after: World, workflow: int, phase: OperationPhase): bool = all {
    world.operations.keys().size() < MAX_OPERATIONS,
    advance(startOperation(after, workflow, phase), ALL_KEPT, NO_STEP_WITNESSES),
  }

  /// The agent of an opened conversation without an active workflow sets a plan that names a
  /// workflow definition. The store creates the running workflow, then the plan writes its row. A
  /// pull request's conversation takes events only through its watch, so only a firing starts its
  /// next workflow.
  action conversationPlansAWorkflow: bool = {
    nondet place = world.opened
      .filter(place => not(isWatcherPlace(place)) and activeWorkflowsOf(world, place).size() == 0)
      .oneOf()
    val workflow = world.nextWorkflow
    val created = {
      ...world,
      workflows: world.workflows.put(workflow, {
        conversation: place,
        status: Running,
        hasIssueJob: false,
        recordedPulls: Set(),
      }),
      nextWorkflow: workflow + 1,
    }
    startWorkflowOperation(created, workflow, PlanWritesRow)
  }

  /// A running workflow ends: done, failed or cancelled. Its store moves it to ending, then it
  /// writes its row, then it deletes its bindings, then its store ends it. The event, tool call or
  /// alarm that ends it waits for the start step of its conversation.
  action workflowEnds: bool = {
    nondet workflow = world.workflows.keys()
      .filter(workflow => isRunning(world, workflow) and not(startStepOut(world, conversationOf(world, workflow))))
      .oneOf()
    all {
      world.operations.keys().size() < MAX_OPERATIONS,
      advance(startEnd(world, workflow), ALL_KEPT, NO_STEP_WITNESSES),
    }
  }

  /// A firing of a definition's trigger on the pull request reaches the conversation of the pull
  /// request and that definition. Without an active workflow there, it opens the conversation and
  /// creates the running workflow, then writes the workflow's row and its watch in one batch. A
  /// firing that finds the workflow active prompts it or fails its attempt, which the trigger
  /// firings spec models.
  action aPullRequestFiringLands: bool = {
    nondet definition = DEFINITIONS.oneOf()
    val place = PullRequestPlace(definition)
    val workflow = world.nextWorkflow
    val created = {
      ...world,
      opened: world.opened.union(Set(place)),
      workflows: world.workflows.put(workflow, {
        conversation: place,
        status: Running,
        hasIssueJob: false,
        recordedPulls: Set(),
      }),
      nextWorkflow: workflow + 1,
    }
    all {
      activeWorkflowsOf(world, place).size() == 0,
      startWorkflowOperation(created, workflow, FireWritesRow),
    }
  }

  /// The pull requests a workflow recorded or binds now.
  pure def pullsOf(state: World, workflow: int): Set[Key] =
    state.operations.keys()
      .filter(id => state.operations.get(id).workflow == workflow)
      .fold(state.workflows.get(workflow).recordedPulls, (found, id) => match state.operations.get(id).phase {
        | PullBinds(pull) => found.union(Set(pull))
        | _ => found
      })

  pure def isJobStart(phase: OperationPhase): bool = match phase {
    | JobReadsIssueBinding => true
    | JobReadsBoundWorkflow(_) => true
    | JobBindsIssue(_) => true
    | _ => false
  }

  /// A running workflow starts a job on the issue. It reads where the issue's binding points. A
  /// binding that points at it lets the job start. A binding that points at no workflow, or at one
  /// whose row ended, moves to it before it records the job. Any other binding refuses the job.
  /// A job starts only after its workflow's row write returned, since the plan awaits that write
  /// and every event awaits the start step.
  action workflowStartsAJobOnTheIssue: bool = {
    nondet workflow = world.workflows.keys().filter(workflow => isRunning(world, workflow) and not(rowWriteAhead(world, workflow))).oneOf()
    all {
      SETUP_KEYS.contains(Issue),
      not(world.workflows.get(workflow).hasIssueJob),
      world.operations.keys().forall(id =>
        not(world.operations.get(id).workflow == workflow and isJobStart(world.operations.get(id).phase))),
      startWorkflowOperation(world, workflow, JobReadsIssueBinding),
    }
  }

  /// A running workflow binds the pull request its job opened, then records it. Each workflow opens
  /// at most one, and only one workflow that has not ended opens each pull request. A workflow
  /// fired on the pull request does not open one.
  action workflowOpensThePullRequest: bool = {
    nondet workflow = world.workflows.keys()
      .filter(workflow => and {
        isRunning(world, workflow),
        not(rowWriteAhead(world, workflow)),
        not(isWatcherPlace(conversationOf(world, workflow))),
        pullsOf(world, workflow).size() == 0,
      })
      .oneOf()
    nondet pull = PULLS.filter(pull => world.workflows.keys().forall(other =>
        pullsOf(world, other).contains(pull) implies statusOf(world, other) == Done)).oneOf()
    startWorkflowOperation(world, workflow, PullBinds(pull))
  }

  /// The job start records its job on the issue. A workflow whose end started refuses it.
  pure def recordIssueJob(state: World, id: int, workflow: int): World =
    if (not(isRunning(state, workflow))) finishOperation(state, id)
    else finishOperation(withWorkflow(state, workflow, flow => { ...flow, hasIssueJob: true }), id)

  /// The D1 effect of the call an operation waits on, without the code after it.
  pure def landCall(state: World, operation: WorkflowOperation): World = match operation.phase {
    | PlanWritesRow => writeRowAndWatch(state, operation.workflow, Live)
    | FireWritesRow => writeRowAndWatch(state, operation.workflow, Live)
    | RestartWritesRow(status) => writeRowAndWatch(state, operation.workflow, status)
    | EndWritesStatus => writeRow(state, operation.workflow, Ended)
    | EndUnbinds => unbindAll(state, operation.workflow)
    | JobBindsIssue(previous) => claim(state, Issue, previous, operation.workflow)
    | PullBinds(pull) => bindWhileLive(state, pull, operation.workflow)
    | _ => state
  }

  /// A workflow's own call returns, and its operation runs to its next call or its end.
  pure def resumeOperation(state: World, id: int): World = {
    val operation = state.operations.get(id)
    val workflow = operation.workflow
    val landed = landCall(state, operation)
    match operation.phase {
      | PlanWritesRow => finishOperation(landed, id)
      | FireWritesRow => finishOperation(landed, id)
      | RestartWritesRow(_) =>
          if (statusOf(state, workflow) == Ending) withOperation(landed, id, EndWritesStatus)
          else finishOperation(landed, id)
      | EndWritesStatus => withOperation(landed, id, EndUnbinds)
      | EndUnbinds => finishOperation(withWorkflow(landed, workflow, flow => { ...flow, status: Done }), id)
      | JobReadsIssueBinding => match boundOf(state, Issue) {
          | BoundTo(bound) =>
              if (bound == workflow) recordIssueJob(state, id, workflow)
              else withOperation(state, id, JobReadsBoundWorkflow(bound))
          | Unbound => withOperation(state, id, JobBindsIssue(Unbound))
        }
      | JobReadsBoundWorkflow(bound) =>
          if (rowEnded(state, bound)) withOperation(state, id, JobBindsIssue(BoundTo(bound)))
          else finishOperation(state, id)
      | JobBindsIssue(previous) =>
          if (claimWins(state, Issue, previous, workflow)) recordIssueJob(landed, id, workflow)
          else finishOperation(state, id)
      | PullBinds(pull) =>
          finishOperation(withWorkflow(landed, workflow, flow => { ...flow, recordedPulls: flow.recordedPulls.union(Set(pull)) }), id)
    }
  }

  pure def isRowWrite(phase: OperationPhase): bool = match phase {
    | PlanWritesRow => true
    | FireWritesRow => true
    | RestartWritesRow(_) => true
    | EndWritesStatus => true
    | _ => false
  }

  /// The status a row write carries.
  pure def writtenStatus(phase: OperationPhase): RowStatus = match phase {
    | RestartWritesRow(status) => status
    | EndWritesStatus => Ended
    | _ => Live
  }

  /// The call a workflow operation waits on returns.
  action workflowCallReturns: bool = {
    nondet operation = world.operations.keys().oneOf()
    val waiting = world.operations.get(operation)
    val after = resumeOperation(world, operation)
    advance(after, ALL_KEPT, {
      ...NO_STEP_WITNESSES,
      endRemovedAnIssueBinding: waiting.phase == EndUnbinds and boundOf(world, Issue) == BoundTo(waiting.workflow),
      claimLandedAfterTheEnd: (match waiting.phase { | JobBindsIssue(_) => true | _ => false }) and rowEnded(world, waiting.workflow),
      lateRowWriteFoundTheEnd: isRowWrite(waiting.phase) and writtenStatus(waiting.phase) == Live and rowEnded(world, waiting.workflow),
      lateWatchWriteFoundTheEnd: and {
        waiting.phase == FireWritesRow,
        rowEnded(world, waiting.workflow),
        statusOf(world, waiting.workflow) == Done,
      },
    })
  }

  /// The Durable Object of a conversation restarts while one of its workflows has a call out. That
  /// call landed or not. The restart drops every call the conversation has out. The start step
  /// writes the row of the active workflow with its status, and goes on with an end it stored. The
  /// conversation does not take an event or run an alarm until that row write returns.
  action conversationRestarts: bool = {
    nondet operation = world.operations.keys().oneOf()
    nondet landed = Set(true, false).oneOf()
    val cut = world.operations.get(operation)
    val place = conversationOf(world, cut.workflow)
    val written = if (landed) landCall(world, cut) else world
    val dropped = {
      ...written,
      operations: world.operations.keys()
        .filter(id => conversationOf(world, world.operations.get(id).workflow) != place)
        .mapBy(id => world.operations.get(id)),
    }
    val active = activeWorkflowsOf(world, place)
    val restarted = active.fold(dropped, (state, workflow) =>
      startOperation(state, workflow, RestartWritesRow(if (statusOf(world, workflow) == Ending) Ended else Live)))
    advance(restarted, ALL_KEPT, {
      ...NO_STEP_WITNESSES,
      restartCutTheEndStatusWrite: cut.phase == EndWritesStatus,
      restartCutTheDeletes: cut.phase == EndUnbinds,
      restartCutThePullRequestBind: match cut.phase { | PullBinds(_) => true | _ => false },
    })
  }

  action step: bool = any {
    eventArrives,
    deliveryResumes,
    fanOutCallFails,
    routerInvocationEnds,
    conversationPlansAWorkflow,
    workflowEnds,
    workflowStartsAJobOnTheIssue,
    workflowOpensThePullRequest,
    aPullRequestFiringLands,
    workflowCallReturns,
    conversationRestarts,
  }

  /// A delivery never creates a workflow or writes a workflow's row. Only a conversation's plan does.
  val aDeliveryNeverCreatesAWorkflow: bool = stepKept.aDeliveryNeverCreatesAWorkflow

  /// An event reaches the conversation that a binding of it leads to, through a workflow whose row
  /// has not ended. Else it reaches its place's conversation when the event is a start or the place
  /// was recorded. Else it is dropped. It is checked when the delivery ends, on a delivery whose
  /// bindings and place held still over its life.
  val anEventReachesItsBoundOrPlaceConversation: bool = stepKept.anEventReachesItsBoundOrPlaceConversation

  /// No binding points at a workflow whose end deleted its bindings.
  val anEndedWorkflowKeepsNoBinding: bool =
    world.bindings.keys().forall(key => statusOf(world, world.bindings.get(key)) != Done)

  /// At most one running workflow has an unfinished job on the issue.
  val oneRunningWorkflowHasAJobOnAnIssue: bool =
    world.workflows.keys().filter(workflow => isRunning(world, workflow) and world.workflows.get(workflow).hasIssueJob).size() <= 1

  /// A base move only hands the event to the conversations with a pull request bound. It never
  /// reads a binding of its own, records a place, or opens a conversation of its own.
  val aBaseMoveOnlyHandsTheEventOn: bool =
    world.deliveries.keys().forall(id => {
      val delivery = world.deliveries.get(id)
      delivery.kind == BaseMoved implies (delivery.phase == ReadingPulls or isFanningOut(delivery.phase))
    })

  /// A write to the workflow's row is out or ahead.
  pure def rowWriteAhead(state: World, workflow: int): bool =
    state.operations.keys().exists(id =>
      state.operations.get(id).workflow == workflow and isRowWrite(state.operations.get(id).phase))

  /// Once no write to a workflow's row is out, the row reads ended exactly when the workflow's end
  /// started in its conversation's store.
  val theRouterRowMatchesTheWorkflowEnd: bool =
    world.rows.keys().forall(workflow =>
      not(rowWriteAhead(world, workflow)) implies (rowEnded(world, workflow) == (statusOf(world, workflow) != Running)))

  /// A running workflow's recorded pull request is bound to it.
  val aRecordedPullRequestIsBoundToItsWorkflow: bool =
    world.workflows.keys().forall(workflow =>
      isRunning(world, workflow) implies
        world.workflows.get(workflow).recordedPulls.forall(pull => boundOf(world, pull) == BoundTo(workflow)))

  /// An event on a watched pull request reaches every watcher's conversation once, in addition to
  /// the conversation its binding leads to. It is checked when the delivery returns, on a delivery
  /// whose route and watchers held still over its life.
  val aWatchedObjectsEventReachesEveryWatcher: bool = stepKept.aWatchedObjectsEventReachesEveryWatcher

  /// No watch outlives its workflow: the conversation of each definition that watches the pull
  /// request has an active workflow.
  val anEndedWorkflowKeepsNoWatch: bool =
    world.watches.forall(definition => activeWorkflowsOf(world, PullRequestPlace(definition)).size() > 0)

  /// The pull request has at most one active workflow per definition.
  val oneActiveWatcherPerPullRequestAndDefinition: bool =
    DEFINITIONS.forall(definition => activeWorkflowsOf(world, PullRequestPlace(definition)).size() <= 1)

  /// A merge or close of the pull request starts the end of every running watcher it reached before
  /// the router returns, so before ingress queues the event's firings. A call that threw is not
  /// counted. It is checked when the delivery returns.
  val aClosedPullRequestEndsItsWatchers: bool = stepKept.aClosedPullRequestEndsItsWatchers

  /// The events that reached the router, which model checking bounds.
  val eventsArrived: int = world.nextDelivery

  /// The workflows the conversations created, which model checking bounds.
  val workflowsCreated: int = world.nextWorkflow

  /// The workflow operations that started, which model checking bounds.
  val operationsStarted: int = world.nextOperation

  /// Witness for `aDeliveryNeverCreatesAWorkflow`: a conversation is open and has no workflow.
  val aConversationWithoutAWorkflowIsOpen: bool =
    world.opened.exists(place => world.workflows.keys().forall(workflow => conversationOf(world, workflow) != place))

  /// Witness for `aDeliveryNeverCreatesAWorkflow`: a conversation ran a second workflow after its
  /// first one ended.
  val aConversationRanTwoWorkflows: bool =
    ALL_PLACES.exists(place => world.workflows.keys().filter(workflow => conversationOf(world, workflow) == place).size() >= 2)

  /// Witness for `anEventReachesItsBoundOrPlaceConversation`: a binding led an event to a
  /// conversation other than its place's.
  val aBindingLedAnEventAway: bool = stepWitnesses.bindingLedAway

  /// Witness for `anEventReachesItsBoundOrPlaceConversation`: a reply reached its place's conversation.
  val aReplyReachedItsPlace: bool = stepWitnesses.replyReachedItsPlace

  /// Witness for `anEventReachesItsBoundOrPlaceConversation`: a reply in a place without a
  /// conversation was dropped.
  val aReplyWasDropped: bool = stepWitnesses.replyDropped

  /// Witness for `anEventReachesItsBoundOrPlaceConversation`: the router's invocation ended between
  /// the record of a place and the first call to its conversation.
  val aRouterDeathCutTheFirstCall: bool = stepWitnesses.routerEndedBeforeTheFirstCall

  /// Witness for `anEndedWorkflowKeepsNoBinding`: an end deleted the issue's binding.
  val anEndRemovedAnIssueBinding: bool = stepWitnesses.endRemovedAnIssueBinding

  /// Witness for `anEndedWorkflowKeepsNoBinding`: an instance restart cut off the deletes of an end.
  val aRestartCutTheDeletes: bool = stepWitnesses.restartCutTheDeletes

  /// Witness for `anEndedWorkflowKeepsNoBinding`: a job start's claim on the issue landed after its
  /// workflow's row ended.
  val aClaimLandedAfterTheEnd: bool = stepWitnesses.claimLandedAfterTheEnd

  /// Witness for `oneRunningWorkflowHasAJobOnAnIssue`: a running workflow has a job on the issue.
  val aRunningWorkflowHasAJobOnTheIssue: bool =
    world.workflows.keys().exists(workflow => isRunning(world, workflow) and world.workflows.get(workflow).hasIssueJob)

  /// Witness for `oneRunningWorkflowHasAJobOnAnIssue`: the next workflow of a conversation has a job
  /// on the issue after the first one ended.
  val aNextWorkflowHasAJobOnTheIssue: bool =
    world.workflows.keys().exists(workflow => and {
      isRunning(world, workflow),
      world.workflows.get(workflow).hasIssueJob,
      world.workflows.keys().exists(earlier => earlier < workflow and conversationOf(world, earlier) == conversationOf(world, workflow)),
    })

  /// Witness for `oneRunningWorkflowHasAJobOnAnIssue`: a job start found the issue's binding
  /// pointing at another workflow and reads that workflow's row.
  val aJobStartFindsTheIssueBoundElsewhere: bool =
    world.operations.keys().exists(id => match world.operations.get(id).phase {
      | JobReadsBoundWorkflow(_) => true
      | _ => false
    })

  /// Witness for `oneRunningWorkflowHasAJobOnAnIssue`: a job start claims the issue after the
  /// binding moved since it read it.
  val aJobStartFindsTheIssueBindingMoved: bool =
    world.operations.keys().exists(id => match world.operations.get(id).phase {
      | JobBindsIssue(previous) => boundOf(world, Issue) != previous
      | _ => false
    })

  /// Witness for `aBaseMoveOnlyHandsTheEventOn`: a base move has two conversations left to hand
  /// the event to.
  val aBaseMoveFansOutToTwoConversations: bool =
    world.deliveries.keys().exists(id => match world.deliveries.get(id).phase {
      | FanningOut(fanOut) => fanOut.left.size() == 2
      | _ => false
    })

  /// Witness for `aBaseMoveOnlyHandsTheEventOn`: a fanned-out call threw and the base move went on
  /// to the next conversation.
  val aBaseMoveGoesOnPastAFailedCall: bool = stepWitnesses.fanOutWentOnPastAFailure

  /// Witness for `theRouterRowMatchesTheWorkflowEnd`: an instance restart cut off the status write
  /// of a workflow end, and the new instance writes it again.
  val aRestartCutTheEndStatusWrite: bool = stepWitnesses.restartCutTheEndStatusWrite

  /// Witness for `theRouterRowMatchesTheWorkflowEnd`: a write of a live row landed after the row ended.
  val aLateRowWriteFoundTheEnd: bool = stepWitnesses.lateRowWriteFoundTheEnd

  /// Witness for `aRecordedPullRequestIsBoundToItsWorkflow`: a workflow bound the pull request.
  val thePullRequestIsBound: bool = world.bindings.keys().contains(Pull)

  /// Witness for `aRecordedPullRequestIsBoundToItsWorkflow`: an instance restart cut off the bind
  /// of a pull request the workflow found.
  val aRestartCutThePullRequestBind: bool = stepWitnesses.restartCutThePullRequestBind

  /// Witness for `anEndedWorkflowKeepsNoWatch`, `oneActiveWatcherPerPullRequestAndDefinition`:
  /// two definitions watch the pull request.
  val twoDefinitionsWatchOnePullRequest: bool = world.watches.size() == 2

  /// Witness for `aClosedPullRequestEndsItsWatchers`: a merge or close started the end of two
  /// running watchers before the router returned.
  val aMergeEndsTwoWatchers: bool = stepWitnesses.mergeEndedTwoWatchers

  /// Witness for `aWatchedObjectsEventReachesEveryWatcher`: an event on the pull request reached
  /// the conversation of the workflow that owns it and a watcher's.
  val aCommentReachesTheOwnerAndTheWatcher: bool = stepWitnesses.commentReachedTheOwnerAndTheWatcher

  /// Witness for `oneActiveWatcherPerPullRequestAndDefinition`, `anEndedWorkflowKeepsNoWatch`: a
  /// firing after a watcher ended started the next workflow in the conversation of the pull request
  /// and its definition.
  val aCloseThenReopenStartsANewReview: bool =
    DEFINITIONS.exists(definition => {
      val place = PullRequestPlace(definition)
      world.workflows.keys().exists(workflow => and {
        conversationOf(world, workflow) == place,
        isRunning(world, workflow),
        world.workflows.keys().exists(earlier => earlier < workflow and conversationOf(world, earlier) == place),
      })
    })

  /// Witness for `anEndedWorkflowKeepsNoWatch`: the row and watch write of a fired workflow landed
  /// after its end removed the watch.
  val aLateWatchWriteFoundTheEnd: bool = stepWitnesses.lateWatchWriteFoundTheEnd
}
