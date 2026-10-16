/// How the router binds chat, tracker and code host events to workflows, and how a workflow's own
/// binding writes race with it.
/// Each action is one stretch of code between two awaits. A D1 statement and a Durable Object
/// create or handle each end a stretch. The statement lands when the next
/// stretch of its caller runs. An await that does not touch the router's tables or another
/// workflow, such as a tracker read, stays inside its stretch.
module routerBindingsTypes {
  /// One external object that routes events: a chat thread, two tracker sessions on one issue,
  /// the issue, and a pull request.
  type Key = Thread | SessionA | SessionB | Issue | Pull

  /// The kind of an external object. A workflow's end and an abandoned create delete bindings by it.
  type Source = ChatThread | TrackerSession | TrackerIssue | CodePull

  /// Where an event comes from. It names the bindings the event carries.
  type Surface = ThreadSurface | SessionASurface | SessionBSurface | PullSurface

  /// A start and a person's message come from a person. Every other event does not.
  type EventKind = Start | PersonsMessage | OtherEvent

  /// What one binding pointed at when a delivery or a job start read it: no workflow, or one workflow.
  type Bound = Unbound | BoundTo(int)

  /// The status of a workflow row in D1. A missing row reads as not ended.
  type RowStatus = Live | Ended

  /// The call a delivery or a workflow waits on.
  type Call =
    | FindBinding(Key)
    | FindWorkflow(int)
    | ClaimBinding(Key)
    | InsertWorkflow(int)
    | BindWorkflow({ key: Key, workflow: int })
    | DeleteBindings(int)
    | SetStatus(int)
    | CreateWorkflow(int)
    | HandleEvent(int)

  /// Where a delivery stands: reading the route, joining a running workflow, or starting the next one.
  type DeliveryPhase =
    | Reading
    | Checking
    | Handling
    | Rebinding
    | Claiming
    | Inserting
    | Binding
    | Creating
    | Unbinding
    | Restoring
    | MarkingFailed

  /// The workflow a delivery joins or creates, once its route is known.
  type Target = NoTarget | TargetWorkflow(int)

  /// The first binding whose workflow ended, by its place in the event's bindings.
  type Replaced = NothingReplaced | ReplacedAt(int)

  /// One event in the router. `found` is what each binding pointed at when the route was read.
  /// `joined` is the place of the binding whose workflow the delivery joins. `won` lists the
  /// places of the bindings a new workflow claimed, in the order it claimed them.
  type Delivery = {
    surface: Surface,
    kind: EventKind,
    phase: DeliveryPhase,
    found: List[Bound],
    index: int,
    joined: int,
    replaced: Replaced,
    target: Target,
    won: List[int],
  }

  /// Where a workflow's own D1 work stands: its end, a job start on the issue, or a pull request it records.
  type OperationPhase =
    | EndWritesStatus
    | EndUnbindsCodeHost
    | JobReadsIssueBinding
    | JobReadsBoundWorkflow(int)
    | JobBindsIssue(Bound)
    | PullBinds

  /// One stretch of work a workflow does against the router's tables.
  type WorkflowOperation = { workflow: int, phase: OperationPhase }

  /// What the Durable Object of one workflow knows. `hasIssueJob` is true while it has an
  /// unfinished job on the issue. `unbound` is true once its end removed its code host bindings.
  type WorkflowObject = {
    created: bool,
    ended: bool,
    hasIssueJob: bool,
    openedPull: bool,
    unbound: bool,
  }

  /// The router's tables, the Durable Objects, and every delivery and workflow operation in flight.
  type World = {
    bindings: Key -> int,
    rows: int -> RowStatus,
    objects: int -> WorkflowObject,
    deliveries: int -> Delivery,
    operations: int -> WorkflowOperation,
    nextWorkflow: int,
    nextDelivery: int,
    nextOperation: int,
  }

  /// What a binding pointed at and whether that workflow's row ended.
  type Observed = { bound: Bound, ended: bool }

  /// Deliveries that overlapped in time, as the router property test sees them.
  type Batch = {
    open: bool,
    surfaces: Set[Surface],
    personWrote: bool,
    quiet: bool,
    createFailed: bool,
    before: Key -> Observed,
    created: Set[int],
    after: Key -> Observed,
  }

  /// What observers saw over the trace.
  type History = {
    movedBindings: Set[{ key: Key, from: int }],
    eventsBeforeCreate: Set[int],
    messagesOnEndedWorkflows: Set[int],
    batch: Batch,
    lastBatch: Batch,
  }
}

/// The router and the workflows on the surfaces of one setup.
module routerBindings {
  import routerBindingsTypes.*

  /// The surfaces events come from.
  const SURFACES: Set[Surface]

  /// How many deliveries run at once.
  pure val MAX_DELIVERIES: int = 2

  /// How many workflow operations run at once.
  pure val MAX_OPERATIONS: int = 2

  pure val ALL_KEYS: Set[Key] = Set(Thread, SessionA, SessionB, Issue, Pull)

  pure val CODE_SOURCES: Set[Source] = Set(CodePull)

  pure val NEW_OBJECT: WorkflowObject =
    { created: false, ended: false, hasIssueJob: false, openedPull: false, unbound: false }

  pure val EMPTY_BATCH: Batch = {
    open: false,
    surfaces: Set(),
    personWrote: false,
    quiet: true,
    createFailed: false,
    before: Map(),
    created: Set(),
    after: Map(),
  }

  pure val INITIAL_WORLD: World = {
    bindings: Map(),
    rows: Map(),
    objects: Map(),
    deliveries: Map(),
    operations: Map(),
    nextWorkflow: 0,
    nextDelivery: 0,
    nextOperation: 0,
  }

  pure val INITIAL_HISTORY: History = {
    movedBindings: Set(),
    eventsBeforeCreate: Set(),
    messagesOnEndedWorkflows: Set(),
    batch: EMPTY_BATCH,
    lastBatch: EMPTY_BATCH,
  }

  var world: World
  var history: History

  pure def keysOf(surface: Surface): List[Key] = match surface {
    | ThreadSurface => List(Thread)
    | SessionASurface => List(SessionA, Issue)
    | SessionBSurface => List(SessionB, Issue)
    | PullSurface => List(Pull)
  }

  pure def kindsOf(surface: Surface): Set[EventKind] = match surface {
    | PullSurface => Set(OtherEvent)
    | _ => Set(Start, PersonsMessage, OtherEvent)
  }

  pure def sourceOf(key: Key): Source = match key {
    | Thread => ChatThread
    | SessionA => TrackerSession
    | SessionB => TrackerSession
    | Issue => TrackerIssue
    | Pull => CodePull
  }

  pure def keySet(list: List[Key]): Set[Key] = list.foldl(Set(), (found, key) => found.union(Set(key)))

  pure val SETUP_KEYS: Set[Key] = SURFACES.fold(Set(), (found, surface) => found.union(keySet(keysOf(surface))))

  pure def without(entries: int -> a, id: int): int -> a = entries.keys().exclude(Set(id)).mapBy(key => entries.get(key))

  pure def smallest(numbers: Set[int], ceiling: int): int =
    numbers.fold(ceiling, (least, number) => if (number < least) number else least)

  pure def isBound(bound: Bound): bool = bound != Unbound

  pure def workflowOf(bound: Bound): int = match bound { | BoundTo(workflow) => workflow | Unbound => -1 }

  pure def targetOf(delivery: Delivery): int = match delivery.target { | TargetWorkflow(workflow) => workflow | NoTarget => -1 }

  pure def replacedIndex(delivery: Delivery): int = match delivery.replaced { | ReplacedAt(index) => index | NothingReplaced => 0 }

  pure def boundOf(state: World, key: Key): Bound =
    if (state.bindings.keys().contains(key)) BoundTo(state.bindings.get(key)) else Unbound

  pure def rowEnded(state: World, workflow: int): bool =
    state.rows.keys().contains(workflow) and state.rows.get(workflow) == Ended

  pure def rowLive(state: World, workflow: int): bool =
    state.rows.keys().contains(workflow) and state.rows.get(workflow) == Live

  pure def objectOf(state: World, workflow: int): WorkflowObject =
    if (state.objects.keys().contains(workflow)) state.objects.get(workflow) else NEW_OBJECT

  pure def isRunning(state: World, workflow: int): bool =
    objectOf(state, workflow).created and not(objectOf(state, workflow).ended)

  pure def isAbandoned(state: World, workflow: int): bool =
    rowEnded(state, workflow) and not(objectOf(state, workflow).created)

  pure def withObject(state: World, workflow: int, change: WorkflowObject => WorkflowObject): World =
    { ...state, objects: state.objects.put(workflow, change(objectOf(state, workflow))) }

  /// A claim points the binding at `workflow` only if it still points where the claimer read it.
  /// A claim on a binding read as unbound inserts it.
  pure def claimWins(state: World, key: Key, previous: Bound): bool = boundOf(state, key) == previous

  pure def claim(state: World, key: Key, previous: Bound, workflow: int): World =
    if (claimWins(state, key, previous)) { ...state, bindings: state.bindings.put(key, workflow) }
    else state

  /// A workflow's own binding write points the binding at it while its row has not ended.
  pure def bindWhileLive(state: World, key: Key, workflow: int): World =
    if (rowLive(state, workflow)) { ...state, bindings: state.bindings.put(key, workflow) }
    else state

  pure def unbind(state: World, workflow: int, sources: Set[Source]): World = {
    ...state,
    bindings: state.bindings.keys()
      .filter(key => not(state.bindings.get(key) == workflow and sources.contains(sourceOf(key))))
      .mapBy(key => state.bindings.get(key)),
  }

  pure def withDelivery(state: World, id: int, delivery: Delivery): World =
    { ...state, deliveries: state.deliveries.put(id, delivery) }

  pure def finishDelivery(state: World, id: int): World = { ...state, deliveries: without(state.deliveries, id) }

  pure def withOperation(state: World, id: int, phase: OperationPhase): World =
    { ...state, operations: state.operations.put(id, { ...state.operations.get(id), phase: phase }) }

  pure def finishOperation(state: World, id: int): World = { ...state, operations: without(state.operations, id) }

  /// The call a delivery waits on.
  pure def callOf(delivery: Delivery): Call = {
    val surfaceKeys = keysOf(delivery.surface)
    match delivery.phase {
      | Reading => FindBinding(surfaceKeys[delivery.found.length()])
      | Checking => FindWorkflow(workflowOf(delivery.found[delivery.index]))
      | Handling => HandleEvent(targetOf(delivery))
      | Rebinding => ClaimBinding(surfaceKeys[delivery.index])
      | Claiming => ClaimBinding(surfaceKeys[delivery.index])
      | Inserting => InsertWorkflow(targetOf(delivery))
      | Binding => ClaimBinding(surfaceKeys[delivery.index])
      | Creating => CreateWorkflow(targetOf(delivery))
      | Unbinding => DeleteBindings(targetOf(delivery))
      | Restoring => ClaimBinding(surfaceKeys[delivery.index])
      | MarkingFailed => SetStatus(targetOf(delivery))
    }
  }

  /// The call a workflow operation waits on.
  pure def operationCallOf(operation: WorkflowOperation): Call = match operation.phase {
    | EndWritesStatus => SetStatus(operation.workflow)
    | EndUnbindsCodeHost => DeleteBindings(operation.workflow)
    | JobReadsIssueBinding => FindBinding(Issue)
    | JobReadsBoundWorkflow(bound) => FindWorkflow(bound)
    | JobBindsIssue(_) => ClaimBinding(Issue)
    | PullBinds => BindWorkflow({ key: Pull, workflow: operation.workflow })
  }

  /// The route is read. A start, or a person's message on a binding whose workflow ended, starts
  /// the next workflow by claiming the binding whose workflow ended, else the first binding.
  /// Every other event is dropped.
  pure def decideRoute(state: World, id: int, delivery: Delivery): World = {
    val startsNext = delivery.kind == Start or (delivery.kind == PersonsMessage and delivery.replaced != NothingReplaced)
    if (not(startsNext)) finishDelivery(state, id)
    else {
      val workflow = state.nextWorkflow
      val claiming = { ...delivery, phase: Claiming, index: replacedIndex(delivery), target: TargetWorkflow(workflow), won: List() }
      withDelivery({ ...state, nextWorkflow: workflow + 1 }, id, claiming)
    }
  }

  /// Check the status of the next bound workflow from `from`, or decide the route once none is left.
  pure def checkFrom(state: World, id: int, delivery: Delivery, from: int): World = {
    val left = delivery.found.indices().filter(index => index >= from and isBound(delivery.found[index]))
    if (left.size() == 0) decideRoute(state, id, delivery)
    else withDelivery(state, id, { ...delivery, phase: Checking, index: smallest(left, delivery.found.length()) })
  }

  pure def afterRead(state: World, id: int, delivery: Delivery): World = {
    val found = delivery.found.append(boundOf(state, keysOf(delivery.surface)[delivery.found.length()]))
    val read = { ...delivery, found: found }
    if (found.length() < keysOf(delivery.surface).length()) withDelivery(state, id, read)
    else checkFrom(state, id, read, 0)
  }

  /// The first bound workflow whose row has not ended is joined. It gets the event first.
  pure def afterCheck(state: World, id: int, delivery: Delivery): World = {
    val workflow = workflowOf(delivery.found[delivery.index])
    if (not(rowEnded(state, workflow))) {
      withDelivery(state, id, { ...delivery, phase: Handling, joined: delivery.index, target: TargetWorkflow(workflow) })
    } else {
      val replaced = if (delivery.replaced == NothingReplaced) ReplacedAt(delivery.index) else delivery.replaced
      checkFrom(state, id, { ...delivery, replaced: replaced }, delivery.index + 1)
    }
  }

  /// A start the joined workflow took points at it, from `from`, each binding that was unbound or whose
  /// workflow ended when the route read it.
  pure def rebindFrom(state: World, id: int, delivery: Delivery, from: int): World = {
    val left = delivery.found.indices().filter(index =>
      index >= from and (index < delivery.joined or delivery.found[index] == Unbound))
    if (left.size() == 0) finishDelivery(state, id)
    else withDelivery(state, id, { ...delivery, phase: Rebinding, index: smallest(left, delivery.found.length()) })
  }

  /// What the Durable Object of the joined workflow answers. It refuses every event before its
  /// create returned, and a person's event once it ended.
  pure def tookEvent(state: World, delivery: Delivery): bool = {
    val object = objectOf(state, targetOf(delivery))
    object.created and not(object.ended and delivery.kind != OtherEvent)
  }

  /// A workflow not created yet refuses the event, and the delivery drops it. A workflow that
  /// ended refuses a person's event, and the route goes on from the next binding.
  pure def afterHandle(state: World, id: int, delivery: Delivery): World = {
    val object = objectOf(state, targetOf(delivery))
    if (not(object.created)) finishDelivery(state, id)
    else if (not(tookEvent(state, delivery))) {
      val replaced = if (delivery.replaced == NothingReplaced) ReplacedAt(delivery.joined) else delivery.replaced
      checkFrom(state, id, { ...delivery, replaced: replaced }, delivery.joined + 1)
    } else if (delivery.kind == Start) rebindFrom(state, id, delivery, 0)
    else finishDelivery(state, id)
  }

  pure def afterRebind(state: World, id: int, delivery: Delivery): World = {
    val key = keysOf(delivery.surface)[delivery.index]
    val claimed = claim(state, key, delivery.found[delivery.index], targetOf(delivery))
    rebindFrom(claimed, id, delivery, delivery.index + 1)
  }

  /// A lost claim on the binding the next workflow starts from reads the route again.
  pure def afterClaim(state: World, id: int, delivery: Delivery): World = {
    val key = keysOf(delivery.surface)[delivery.index]
    val previous = delivery.found[delivery.index]
    if (claimWins(state, key, previous))
      withDelivery(claim(state, key, previous, targetOf(delivery)), id, { ...delivery, phase: Inserting, won: List(delivery.index) })
    else withDelivery(state, id, { ...delivery, phase: Reading, found: List(), index: 0, replaced: NothingReplaced, target: NoTarget })
  }

  /// Claim, from `from`, each other binding for the next workflow, then create it.
  pure def bindFrom(state: World, id: int, delivery: Delivery, from: int): World = {
    val left = delivery.found.indices().filter(index => index >= from and index != replacedIndex(delivery))
    if (left.size() == 0) withDelivery(state, id, { ...delivery, phase: Creating })
    else withDelivery(state, id, { ...delivery, phase: Binding, index: smallest(left, delivery.found.length()) })
  }

  pure def afterInsert(state: World, id: int, delivery: Delivery): World = {
    val inserted = { ...state, rows: state.rows.put(targetOf(delivery), Live) }
    bindFrom(inserted, id, delivery, 0)
  }

  pure def afterBind(state: World, id: int, delivery: Delivery): World = {
    val key = keysOf(delivery.surface)[delivery.index]
    val previous = delivery.found[delivery.index]
    val won = if (claimWins(state, key, previous)) delivery.won.append(delivery.index) else delivery.won
    bindFrom(claim(state, key, previous, targetOf(delivery)), id, { ...delivery, won: won }, delivery.index + 1)
  }

  /// Point the next binding the abandoned workflow claimed back at the workflow it pointed at,
  /// unless another delivery bound it since. Then mark the abandoned workflow failed.
  pure def restoreNext(state: World, id: int, delivery: Delivery): World = {
    val left = delivery.won.select(index => isBound(delivery.found[index]))
    if (left.length() == 0) withDelivery(state, id, { ...delivery, phase: MarkingFailed, won: List() })
    else withDelivery(state, id, { ...delivery, phase: Restoring, index: left[0], won: left.slice(1, left.length()) })
  }

  pure def afterUnbind(state: World, id: int, delivery: Delivery): World = {
    val surfaceKeys = keysOf(delivery.surface)
    val sources = delivery.won.foldl(Set(), (found, index) => found.union(Set(sourceOf(surfaceKeys[index]))))
    restoreNext(unbind(state, targetOf(delivery), sources), id, delivery)
  }

  pure def afterRestore(state: World, id: int, delivery: Delivery): World = {
    val key = keysOf(delivery.surface)[delivery.index]
    restoreNext(claim(state, key, Unbound, workflowOf(delivery.found[delivery.index])), id, delivery)
  }

  pure def afterMarkFailed(state: World, id: int, delivery: Delivery): World =
    finishDelivery({ ...state, rows: state.rows.put(targetOf(delivery), Ended) }, id)

  /// The call a delivery waits on returns, and the delivery runs to its next call or its end.
  pure def resumeDelivery(state: World, id: int): World = {
    val delivery = state.deliveries.get(id)
    match delivery.phase {
      | Reading => afterRead(state, id, delivery)
      | Checking => afterCheck(state, id, delivery)
      | Handling => afterHandle(state, id, delivery)
      | Rebinding => afterRebind(state, id, delivery)
      | Claiming => afterClaim(state, id, delivery)
      | Inserting => afterInsert(state, id, delivery)
      | Binding => afterBind(state, id, delivery)
      | Creating => state
      | Unbinding => afterUnbind(state, id, delivery)
      | Restoring => afterRestore(state, id, delivery)
      | MarkingFailed => afterMarkFailed(state, id, delivery)
    }
  }

  /// The Durable Object of a new workflow took its first event.
  pure def createReturned(state: World, id: int): World = {
    val workflow = targetOf(state.deliveries.get(id))
    finishDelivery(withObject(state, workflow, object => { ...object, created: true }), id)
  }

  /// The Durable Object create threw, so the router undoes the new workflow.
  pure def createFailed(state: World, id: int): World =
    withDelivery(state, id, { ...state.deliveries.get(id), phase: Unbinding })

  /// The job start records its job on the issue. A workflow that ended while the job start
  /// waited refuses it.
  pure def recordIssueJob(state: World, id: int, workflow: int): World =
    if (objectOf(state, workflow).ended) finishOperation(state, id)
    else finishOperation(withObject(state, workflow, object => { ...object, hasIssueJob: true }), id)

  /// The job start points the issue's binding at its workflow if the binding still points where
  /// the job start read it. Otherwise it refuses the job.
  pure def afterIssueBind(state: World, id: int, workflow: int, previous: Bound): World =
    if (not(claimWins(state, Issue, previous))) finishOperation(state, id)
    else recordIssueJob(claim(state, Issue, previous, workflow), id, workflow)

  /// A workflow's own call returns, and its operation runs to its next call or its end.
  pure def resumeOperation(state: World, id: int): World = {
    val operation = state.operations.get(id)
    val workflow = operation.workflow
    match operation.phase {
      | EndWritesStatus => withOperation({ ...state, rows: state.rows.put(workflow, Ended) }, id, EndUnbindsCodeHost)
      | EndUnbindsCodeHost => {
          val unbound = withObject(unbind(state, workflow, CODE_SOURCES), workflow, object => { ...object, unbound: true })
          finishOperation(unbound, id)
        }
      | JobReadsIssueBinding => match boundOf(state, Issue) {
          | BoundTo(bound) =>
              if (bound == workflow) recordIssueJob(state, id, workflow)
              else withOperation(state, id, JobReadsBoundWorkflow(bound))
          | Unbound => withOperation(state, id, JobBindsIssue(Unbound))
        }
      | JobReadsBoundWorkflow(bound) =>
          if (rowEnded(state, bound)) withOperation(state, id, JobBindsIssue(BoundTo(bound)))
          else finishOperation(state, id)
      | JobBindsIssue(previous) => afterIssueBind(state, id, workflow, previous)
      | PullBinds => finishOperation(bindWhileLive(state, Pull, workflow), id)
    }
  }

  pure def isJobStart(phase: OperationPhase): bool = match phase {
    | JobReadsIssueBinding => true
    | JobReadsBoundWorkflow(_) => true
    | JobBindsIssue(_) => true
    | _ => false
  }

  pure def startOperation(state: World, workflow: int, phase: OperationPhase): World = {
    ...state,
    operations: state.operations.put(state.nextOperation, { workflow: workflow, phase: phase }),
    nextOperation: state.nextOperation + 1,
  }

  pure def observe(state: World): Key -> Observed =
    ALL_KEYS.mapBy(key => {
      val bound = boundOf(state, key)
      { bound: bound, ended: isBound(bound) and rowEnded(state, workflowOf(bound)) }
    })

  /// The bindings a delivery step pointed at another workflow, or removed, while they pointed at a
  /// running workflow.
  pure def movedFromRunning(before: World, after: World): Set[{ key: Key, from: int }] =
    before.bindings.keys()
      .filter(key => {
        val bound = before.bindings.get(key)
        isRunning(before, bound) and workflowOf(boundOf(after, key)) != bound
      })
      .map(key => { key: key, from: before.bindings.get(key) })

  /// The history after a delivery step from `before` to `after`.
  pure def recordDeliveryStep(past: History, before: World, after: World, id: int): History = {
    val delivery = before.deliveries.get(id)
    val workflow = targetOf(delivery)
    val took = delivery.phase == Handling and tookEvent(before, delivery)
    val closes = after.deliveries.keys().size() == 0
    val batch = past.batch
    {
      ...past,
      movedBindings: past.movedBindings.union(movedFromRunning(before, after)),
      eventsBeforeCreate:
        if (took and not(objectOf(before, workflow).created)) past.eventsBeforeCreate.union(Set(workflow))
        else past.eventsBeforeCreate,
      messagesOnEndedWorkflows:
        if (took and delivery.kind != OtherEvent and objectOf(before, workflow).ended)
          past.messagesOnEndedWorkflows.union(Set(workflow))
        else past.messagesOnEndedWorkflows,
      batch: if (closes) { ...batch, open: false } else batch,
      lastBatch: if (closes) { ...batch, open: false, after: observe(after) } else past.lastBatch,
    }
  }

  pure def withBatch(past: History, batch: Batch): History = { ...past, batch: batch }

  action init: bool = all {
    world' = INITIAL_WORLD,
    history' = INITIAL_HISTORY,
  }

  /// An event reaches the router from one surface.
  action eventArrives: bool = {
    nondet surface = SURFACES.oneOf()
    nondet kind = kindsOf(surface).oneOf()
    val delivery = {
      surface: surface,
      kind: kind,
      phase: Reading,
      found: List(),
      index: 0,
      joined: 0,
      replaced: NothingReplaced,
      target: NoTarget,
      won: List(),
    }
    val batch = if (history.batch.open)
        { ...history.batch, surfaces: history.batch.surfaces.union(Set(surface)), personWrote: history.batch.personWrote or kind != OtherEvent }
      else
        { ...EMPTY_BATCH, open: true, surfaces: Set(surface), personWrote: kind != OtherEvent, before: observe(world) }
    all {
      world.deliveries.keys().size() < MAX_DELIVERIES,
      world' = { ...withDelivery(world, world.nextDelivery, delivery), nextDelivery: world.nextDelivery + 1 },
      history' = withBatch(history, batch),
    }
  }

  /// The call a delivery waits on lands, and the delivery runs to its next call.
  action deliveryResumes: bool = {
    nondet delivery = world.deliveries.keys().filter(id => world.deliveries.get(id).phase != Creating).oneOf()
    val after = resumeDelivery(world, delivery)
    all {
      world' = after,
      history' = recordDeliveryStep(history, world, after, delivery),
    }
  }

  /// The Durable Object create of a new workflow returns.
  action workflowCreateReturns: bool = {
    nondet delivery = world.deliveries.keys().filter(id => world.deliveries.get(id).phase == Creating).oneOf()
    val after = createReturned(world, delivery)
    val recorded = recordDeliveryStep(history, world, after, delivery)
    val created = targetOf(world.deliveries.get(delivery))
    all {
      world' = after,
      history' = {
        ...recorded,
        batch: { ...recorded.batch, created: recorded.batch.created.union(Set(created)) },
        lastBatch:
          if (after.deliveries.keys().size() == 0)
            { ...recorded.lastBatch, created: recorded.lastBatch.created.union(Set(created)) }
          else recorded.lastBatch,
      },
    }
  }

  /// The Durable Object create of a new workflow throws.
  action workflowCreateFails: bool = {
    nondet delivery = world.deliveries.keys().filter(id => world.deliveries.get(id).phase == Creating).oneOf()
    val after = createFailed(world, delivery)
    val recorded = recordDeliveryStep(history, world, after, delivery)
    all {
      world' = after,
      history' = withBatch(recorded, { ...recorded.batch, createFailed: true }),
    }
  }

  action startWorkflowOperation(workflow: int, phase: OperationPhase, change: WorkflowObject => WorkflowObject): bool = all {
    world.operations.keys().size() < MAX_OPERATIONS,
    isRunning(world, workflow),
    world' = withObject(startOperation(world, workflow, phase), workflow, change),
    history' = if (history.batch.open) withBatch(history, { ...history.batch, quiet: false }) else history,
  }

  /// A running workflow ends: done, failed or cancelled. Its Durable Object status changes, then it
  /// writes the status to D1, then it removes its code host bindings.
  action workflowEnds: bool = {
    nondet workflow = world.objects.keys().oneOf()
    startWorkflowOperation(workflow, EndWritesStatus, object => { ...object, ended: true, hasIssueJob: false })
  }

  /// A running workflow starts a job on the issue. It reads where the issue's binding points. A
  /// binding that points at it lets the job start. A binding that points at no workflow, or at one
  /// whose row ended, moves to it before it records the job. Any other binding refuses the job.
  action workflowStartsAJobOnTheIssue: bool = {
    nondet workflow = world.objects.keys().oneOf()
    all {
      SETUP_KEYS.contains(Issue),
      not(objectOf(world, workflow).hasIssueJob),
      world.operations.keys().forall(id =>
        not(world.operations.get(id).workflow == workflow and isJobStart(world.operations.get(id).phase))),
      startWorkflowOperation(workflow, JobReadsIssueBinding, object => object),
    }
  }

  /// A running workflow records the pull request its job opened and binds it. Only one running
  /// workflow opens the pull request.
  action workflowOpensThePullRequest: bool = {
    nondet workflow = world.objects.keys().oneOf()
    all {
      SETUP_KEYS.contains(Pull),
      world.objects.keys().forall(other => objectOf(world, other).openedPull implies objectOf(world, other).ended),
      startWorkflowOperation(workflow, PullBinds, object => { ...object, openedPull: true }),
    }
  }

  /// The call a workflow operation waits on returns.
  action workflowCallReturns: bool = {
    nondet operation = world.operations.keys().oneOf()
    all {
      world' = resumeOperation(world, operation),
      history' = if (history.batch.open) withBatch(history, { ...history.batch, quiet: false }) else history,
    }
  }

  action step: bool = any {
    eventArrives,
    deliveryResumes,
    workflowCreateReturns,
    workflowCreateFails,
    workflowEnds,
    workflowStartsAJobOnTheIssue,
    workflowOpensThePullRequest,
    workflowCallReturns,
  }

  pure def runningBefore(batch: Batch, surfaceKeys: Set[Key]): bool =
    surfaceKeys.exists(key => isBound(batch.before.get(key).bound) and not(batch.before.get(key).ended))

  /// A person's message on a binding whose workflow ended starts exactly one new workflow, and the
  /// binding then points at it. Mirrors the router property test: the deliveries of one surface that
  /// overlap, with no workflow work and no failed create among them.
  val messageAfterEndStartsNextWorkflow: bool = {
    val batch = history.lastBatch
    batch.surfaces.forall(surface => {
      val surfaceKeys = keySet(keysOf(surface))
      val endedKeys = surfaceKeys.filter(key => batch.before.get(key).ended)
      and {
        batch.surfaces.size() == 1,
        batch.quiet,
        not(batch.createFailed),
        batch.personWrote,
        not(runningBefore(batch, surfaceKeys)),
        endedKeys.size() > 0,
      } implies and {
        batch.created.size() == 1,
        batch.created.forall(started => endedKeys.forall(key => workflowOf(batch.after.get(key).bound) == started)),
      }
    })
  }

  /// A delivery never moves or removes a binding that points at a running workflow.
  val aDeliveryLeavesTheBindingsOfARunningWorkflow: bool = history.movedBindings.size() == 0

  /// A workflow takes an event from the router only after its create returned.
  val aWorkflowGetsEventsOnlyOnceCreated: bool = history.eventsBeforeCreate.size() == 0

  /// A workflow whose create failed and that the router marked failed keeps no binding.
  val anAbandonedWorkflowKeepsNoBinding: bool =
    world.bindings.keys().forall(key => not(isAbandoned(world, world.bindings.get(key))))

  /// Once a workflow's end removed its code host bindings, no code host binding points at it.
  val anEndedWorkflowKeepsNoCodeHostBinding: bool =
    world.bindings.keys().forall(key =>
      sourceOf(key) == CodePull implies not(objectOf(world, world.bindings.get(key)).unbound))

  /// At most one running workflow has an unfinished job on the issue.
  val oneRunningWorkflowHasAJobOnAnIssue: bool =
    world.objects.keys().filter(workflow => isRunning(world, workflow) and objectOf(world, workflow).hasIssueJob).size() <= 1

  /// A person's message never reaches a workflow that ended. It starts the next workflow instead.
  val aPersonsMessageNeverReachesAnEndedWorkflow: bool = history.messagesOnEndedWorkflows.size() == 0

  /// Every invariant above, for one check of all of them.
  val invariants: bool = and {
    messageAfterEndStartsNextWorkflow,
    aDeliveryLeavesTheBindingsOfARunningWorkflow,
    aWorkflowGetsEventsOnlyOnceCreated,
    anAbandonedWorkflowKeepsNoBinding,
    anEndedWorkflowKeepsNoCodeHostBinding,
    oneRunningWorkflowHasAJobOnAnIssue,
    aPersonsMessageNeverReachesAnEndedWorkflow,
  }

  /// A delivery started a workflow.
  val aWorkflowStarted: bool = world.objects.keys().exists(workflow => objectOf(world, workflow).created)

  /// A delivery joined a workflow and hands it the event.
  val aDeliveryJoinsAWorkflow: bool =
    world.deliveries.keys().exists(id => world.deliveries.get(id).phase == Handling)

  /// A delivery hands the event to a workflow whose create has not returned.
  val aDeliveryReachesAWorkflowBeforeItsCreate: bool =
    world.deliveries.keys().exists(id => and {
      world.deliveries.get(id).phase == Handling,
      not(objectOf(world, targetOf(world.deliveries.get(id))).created),
    })

  /// A delivery hands a person's event to a workflow that ended.
  val aDeliveryReachesAnEndedWorkflow: bool =
    world.deliveries.keys().exists(id => and {
      world.deliveries.get(id).phase == Handling,
      world.deliveries.get(id).kind != OtherEvent,
      objectOf(world, targetOf(world.deliveries.get(id))).ended,
    })

  /// A start that joined a running workflow points its bindings at it.
  val aStartRebindsItsBindings: bool =
    world.deliveries.keys().exists(id => world.deliveries.get(id).phase == Rebinding)

  /// Witness for `messageAfterEndStartsNextWorkflow`: a person's message on an ended binding started the next workflow.
  val aMessageAfterEndStartedTheNextWorkflow: bool = {
    val batch = history.lastBatch
    and {
      batch.personWrote,
      batch.created.size() == 1,
      batch.surfaces.forall(surface => keySet(keysOf(surface)).exists(key => batch.before.get(key).ended)),
    }
  }

  /// Witness for `anAbandonedWorkflowKeepsNoBinding`: the router abandoned a workflow whose create failed.
  val aWorkflowWasAbandoned: bool = world.rows.keys().exists(workflow => isAbandoned(world, workflow))

  /// Witness for `anEndedWorkflowKeepsNoCodeHostBinding`: a workflow ended and removed its code host bindings.
  val aWorkflowEnded: bool = world.objects.keys().exists(workflow => objectOf(world, workflow).unbound)

  /// Witness for `oneRunningWorkflowHasAJobOnAnIssue`: a running workflow has a job on the issue.
  val aRunningWorkflowHasAJobOnTheIssue: bool =
    world.objects.keys().exists(workflow => isRunning(world, workflow) and objectOf(world, workflow).hasIssueJob)

  /// A job start found the issue's binding pointing at another workflow and reads that workflow's row.
  val aJobStartFindsTheIssueBoundElsewhere: bool =
    world.operations.keys().exists(id => match world.operations.get(id).phase {
      | JobReadsBoundWorkflow(_) => true
      | _ => false
    })

  /// A job start binds the issue after the binding moved since it read it.
  val aJobStartFindsTheIssueBindingMoved: bool =
    world.operations.keys().exists(id => match world.operations.get(id).phase {
      | JobBindsIssue(previous) => boundOf(world, Issue) != previous
      | _ => false
    })

  /// Witness for `anEndedWorkflowKeepsNoCodeHostBinding`: a workflow bound the pull request.
  val thePullRequestIsBound: bool = world.bindings.keys().contains(Pull)

  /// Witness for `aPersonsMessageNeverReachesAnEndedWorkflow`: a person wrote on a binding whose workflow ended.
  val aPersonWroteAfterAnEnd: bool =
    world.deliveries.keys().exists(id => and {
      world.deliveries.get(id).kind == PersonsMessage,
      world.deliveries.get(id).replaced != NothingReplaced,
    })
}
