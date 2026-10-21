/// How the firings of schedule triggers and vendor event triggers reach their conversations
/// through the firing queue. The scheduled run queues a schedule firing's first attempt, and the
/// router queues a vendor event firing's. A vendor event firing reports in a channel like a
/// schedule firing, or on its pull request. Each queue delivery runs the consumer on one
/// message. The consumer reads the firing's start line record. Without one, it posts the start
/// line, records it unless a racing delivery recorded one first, and uses the recorded one. It then
/// records the thread's conversation and hands the firing to it. A failed attempt sends the next
/// one after its delay, and the last failure posts the failure line in the thread.
/// Every pull request firing names one pull request and one definition, so all of them share the
/// conversation of that pull request and definition. The consumer calls it without a start line.
/// The conversation starts a workflow, prompts its active workflow, or refuses the firing while
/// that workflow ends, which fails the attempt. The last failure comments on the pull request. The
/// pull request's merge or close ends the active workflow, and a restart during the end keeps it
/// going. The screen of the payload is the first call the handler awaits. A restart during it
/// fails the call before the handler writes anything, so the model folds it into the call.
/// Each action is one stretch of code between the calls the spec models: the start line post, the
/// conversation call, the send of the next attempt, and the failure line post. The D1 reads and
/// writes and the conversation's awaits after its create answer at once, so the model folds them
/// into the stretch around them.
/// The queue delivers a message at least once. It delivers it again after a consumer dies, as when
/// a call hangs past the consumer's time limit, and to a second consumer while the first works on
/// it. A dead consumer's post or send that was out may still land. Each start line's thread has its
/// own conversation. A conversation keeps its store across a restart, which drops the handler that
/// is out.
module triggerFirings {
  /// Where an attempt calls its conversation: the thread of a start line by its place in the
  /// posts, or the pull request.
  type Place = InThread(int) | OnThePullRequest

  /// The place a failed attempt reached: none, or one.
  type PlaceRef = NoPlace | At(Place)

  /// Where a workflow of the pull request's conversation stands.
  type WorkflowStatus = WorkflowRunning | WorkflowEnding | WorkflowEnded

  /// A firing's prompt that reached a workflow of the pull request's conversation, by the
  /// workflow's place in creation order.
  type Prompt = { firing: int, workflow: int }

  /// How a delivery returned to the queue. `Taken` is an answer that the conversation started the
  /// workflow or saw the firing before. `NextAttemptSent` follows a failed attempt before the last.
  /// `GaveUp` follows the last failed attempt, with the place its failure line went to. A
  /// delivery whose send of the next attempt failed throws, so the queue delivers it again.
  type Ending = Taken | NextAttemptSent | GaveUp(PlaceRef) | Redelivered

  /// Where a delivery stands. `PostOut` waits on the start line post. `CallOut` waits on the
  /// conversation of the place, and `Answering` on a conversation that took the firing.
  /// `SendOut` waits on the send of the next attempt, and `FailureLineOut` on the failure line
  /// post or comment. `Died` is a consumer that stopped mid-work.
  type Phase =
    | PostOut
    | CallOut(Place)
    | Answering(Place)
    | SendOut
    | FailureLineOut(Place)
    | Finished(Ending)
    | Died

  /// One run of the consumer on one message.
  type Delivery = { message: int, phase: Phase }

  /// One attempt of a firing in the queue. `delay` is the wait before the queue delivers it, in
  /// seconds. `acked` is true once a delivery acknowledged it.
  type Message = { firing: int, attempt: int, delay: int, acked: bool }

  /// The queue, the chat, D1 and the conversations. `startLines` holds the firing of each start
  /// line, by its thread. `records` holds the recorded thread of each firing. `failureLines` holds
  /// the failure line posts sent to each thread. The pull request's conversation holds its
  /// workflows in creation order, the pull request firings it saw, and each prompt that reached a
  /// workflow. `failureComments` counts the failure comments on the pull request.
  type World = {
    messages: int -> Message,
    deliveries: int -> Delivery,
    startLines: int -> int,
    records: int -> int,
    recordedConversations: Set[int],
    startedConversations: Set[int],
    failureLines: int -> int,
    pullWorkflows: List[WorkflowStatus],
    pullSeen: Set[int],
    pullPrompts: List[Prompt],
    failureComments: int,
  }

  /// Whether the last step kept each rule that compares the state before and after it.
  type KeptRules = { aFiringNeverLandsOnAnEndingWorkflow: bool }

  /// Witnesses that need the step that reached them.
  type StepWitnesses = { startedOnTheSecondAttempt: bool, lostTheRecordRace: bool }

  /// The scheduled minutes that fire, one firing each. They are firings `0` to `FIRINGS - 1`.
  const FIRINGS: int

  /// The vendor events that fire a trigger with a channel, one firing each. They are the firings
  /// after the scheduled ones, and post their start lines like them.
  const CHANNEL_EVENT_FIRINGS: int

  /// The pull request events that fire one definition, one firing each. They are the firings after
  /// the channel event ones.
  const PULL_FIRINGS: int

  /// The most first attempts the scheduled runs and the router queue, counted over every firing.
  const RUNS: int

  /// The most queue deliveries.
  const DELIVERIES: int

  /// The most conversation restarts.
  const RESTARTS: int

  /// The attempts a firing gets.
  pure val LAST_ATTEMPT: int = 3

  pure val NO_STEP_WITNESSES: StepWitnesses = { startedOnTheSecondAttempt: false, lostTheRecordRace: false }

  pure val ALL_KEPT: KeptRules = { aFiringNeverLandsOnAnEndingWorkflow: true }

  pure val EMPTY_WORLD: World = {
    messages: Map(),
    deliveries: Map(),
    startLines: Map(),
    records: Map(),
    recordedConversations: Set(),
    startedConversations: Set(),
    failureLines: Map(),
    pullWorkflows: List(),
    pullSeen: Set(),
    pullPrompts: List(),
    failureComments: 0,
  }

  var world: World

  var lastStepKept: KeptRules

  /// The conversation restarts so far.
  var conversationRestarts: int

  /// The messages a late scheduled run queued. Only witnesses read it.
  var lateRuns: Set[int]

  var stepWitnesses: StepWitnesses

  /// The wait before the queue delivers an attempt: none for the first, then 30 seconds and 2 minutes.
  pure def delayBefore(attempt: int): int = if (attempt == 2) 30 else if (attempt == 3) 120 else 0

  /// The firings that post a start line in a channel: the scheduled ones, then the channel event ones.
  pure val CHANNEL_FIRINGS: int = FIRINGS + CHANNEL_EVENT_FIRINGS

  pure def isPullFiring(firing: int): bool = firing >= CHANNEL_FIRINGS

  /// The pull request's workflow that has not ended, as a set of at most its place.
  pure def activePullWorkflows(w: World): Set[int] =
    w.pullWorkflows.indices().filter(workflow => w.pullWorkflows[workflow] != WorkflowEnded)

  pure def pullWorkflowIs(w: World, status: WorkflowStatus): bool =
    activePullWorkflows(w).exists(workflow => w.pullWorkflows[workflow] == status)

  pure def withLastPullWorkflow(w: World, status: WorkflowStatus): World =
    { ...w, pullWorkflows: w.pullWorkflows.replaceAt(w.pullWorkflows.length() - 1, status) }

  pure def promptsOf(w: World, firing: int): Set[int] =
    w.pullPrompts.indices().filter(prompt => w.pullPrompts[prompt].firing == firing)

  /// Every prompt this step sent went to a workflow that was running before it, or that it created.
  pure def rulesKeptBy(before: World, after: World): KeptRules = {
    aFiringNeverLandsOnAnEndingWorkflow: after.pullPrompts.indices().forall(prompt => or {
      prompt < before.pullPrompts.length(),
      after.pullPrompts[prompt].workflow >= before.pullWorkflows.length(),
      before.pullWorkflows[after.pullPrompts[prompt].workflow] == WorkflowRunning,
    }),
  }

  pure def messageOf(w: World, delivery: int): Message = w.messages.get(w.deliveries.get(delivery).message)

  pure def withPhase(w: World, delivery: int, phase: Phase): World =
    { ...w, deliveries: w.deliveries.set(delivery, { ...w.deliveries.get(delivery), phase: phase }) }

  pure def isPostOut(phase: Phase): bool = match phase {
    | PostOut => true
    | _ => false
  }

  pure def isSendOut(phase: Phase): bool = match phase {
    | SendOut => true
    | _ => false
  }

  pure def isFinished(phase: Phase): bool = match phase {
    | Finished(_) => true
    | _ => false
  }

  /// True while the consumer of a delivery waits on a call.
  pure def isWorking(phase: Phase): bool = match phase {
    | Finished(_) => false
    | Died => false
    | _ => true
  }

  /// The place a delivery calls or posts the failure line to.
  pure def calledPlace(phase: Phase): PlaceRef = match phase {
    | CallOut(place) => At(place)
    | Answering(place) => At(place)
    | FailureLineOut(place) => At(place)
    | _ => NoPlace
  }

  pure def isCallOut(phase: Phase): bool = match phase {
    | CallOut(_) => true
    | _ => false
  }

  pure def isAnswering(phase: Phase): bool = match phase {
    | Answering(_) => true
    | _ => false
  }

  pure def isAnsweringInAThread(phase: Phase): bool = match phase {
    | Answering(place) => place != OnThePullRequest
    | _ => false
  }

  pure def isOnThePullRequest(phase: Phase): bool = calledPlace(phase) == At(OnThePullRequest)

  pure def isFailureLineOut(phase: Phase): bool = match phase {
    | FailureLineOut(_) => true
    | _ => false
  }

  pure def deliveriesWhere(w: World, inPhase: (Phase) => bool): Set[int] =
    w.deliveries.keys().filter(delivery => inPhase(w.deliveries.get(delivery).phase))

  pure def hasAttempt(w: World, firing: int, attempt: int): bool =
    w.messages.keys().exists(id => w.messages.get(id).firing == firing and w.messages.get(id).attempt == attempt)

  pure def recordedThreadIs(w: World, firing: int, thread: int): bool =
    if (w.records.keys().contains(firing)) w.records.get(firing) == thread else false

  /// True for the thread a firing recorded as its own.
  pure def isRecordedThread(w: World, thread: int): bool =
    recordedThreadIs(w, w.startLines.get(thread), thread)

  /// The threads of a firing whose conversation started its workflow.
  pure def startedThreadsOf(w: World, firing: int): Set[int] =
    w.startedConversations.filter(thread => w.startLines.get(thread) == firing)

  /// The delivery returns to the queue, which acknowledges its message.
  pure def finish(w: World, delivery: int, ending: Ending): World = {
    val id = w.deliveries.get(delivery).message
    val ended = withPhase(w, delivery, Finished(ending))
    { ...ended, messages: ended.messages.set(id, { ...ended.messages.get(id), acked: true }) }
  }

  /// The attempt failed. Before the last attempt the consumer sends the next one. After the last,
  /// it logs the error and posts the failure line in the thread, or comments on the pull request.
  pure def failedAttempt(w: World, delivery: int, place: PlaceRef): World =
    if (messageOf(w, delivery).attempt < LAST_ATTEMPT) withPhase(w, delivery, SendOut)
    else match place {
      | At(reached) => {
        val posting = withPhase(w, delivery, FailureLineOut(reached))
        match reached {
          | InThread(line) => {
            val sent = if (w.failureLines.keys().contains(line)) w.failureLines.get(line) else 0
            { ...posting, failureLines: posting.failureLines.put(line, sent + 1) }
          }
          | OnThePullRequest => { ...posting, failureComments: posting.failureComments + 1 }
        }
      }
      | NoPlace => finish(w, delivery, GaveUp(NoPlace))
    }

  /// The consumer records the thread's conversation and calls it with the firing.
  pure def callTheConversation(w: World, delivery: int, thread: int): World =
    withPhase({ ...w, recordedConversations: w.recordedConversations.union(Set(thread)) }, delivery, CallOut(InThread(thread)))

  /// A queue delivery of a pull request firing calls the pull request's conversation. Another
  /// reads the firing's start line record. It calls the recorded thread's conversation, or posts
  /// the start line when the firing does not have a record.
  pure def delivered(w: World, id: int): World = {
    val firing = w.messages.get(id).firing
    val delivery = w.deliveries.keys().size()
    val started = { ...w, deliveries: w.deliveries.put(delivery, { message: id, phase: PostOut }) }
    if (isPullFiring(firing)) withPhase(started, delivery, CallOut(OnThePullRequest))
    else if (w.records.keys().contains(firing)) callTheConversation(started, delivery, w.records.get(firing))
    else started
  }

  /// The start line posted. The consumer records it unless a racing delivery recorded one first,
  /// and calls the conversation of the recorded one.
  pure def startLinePosted(w: World, delivery: int): World = {
    val firing = messageOf(w, delivery).firing
    val line = w.startLines.keys().size()
    val records = if (w.records.keys().contains(firing)) w.records else w.records.put(firing, line)
    callTheConversation({ ...w, startLines: w.startLines.put(line, firing), records: records }, delivery, records.get(firing))
  }

  /// The next attempt of the delivery's firing, which a failed attempt sends.
  pure def withNextAttempt(w: World, delivery: int): World = {
    val message = messageOf(w, delivery)
    val nextAttempt = { firing: message.firing, attempt: message.attempt + 1, delay: delayBefore(message.attempt + 1), acked: false }
    { ...w, messages: w.messages.put(w.messages.keys().size(), nextAttempt) }
  }

  /// The scheduled runs and vendor events so far, one first attempt each.
  val cronRuns: int = world.messages.keys().filter(id => world.messages.get(id).attempt == 1).size()

  /// The queue deliveries so far.
  val deliveriesMade: int = world.deliveries.keys().size()

  val waitingMessages: Set[int] = world.messages.keys().filter(id => not(world.messages.get(id).acked))

  action init: bool = all {
    world' = EMPTY_WORLD,
    lastStepKept' = ALL_KEPT,
    conversationRestarts' = 0,
    lateRuns' = Set(),
    stepWitnesses' = NO_STEP_WITNESSES,
  }

  /// One step that does not reach a step witness.
  action move(after: World): bool = all {
    world' = after,
    lastStepKept' = rulesKeptBy(world, after),
    conversationRestarts' = conversationRestarts,
    lateRuns' = lateRuns,
    stepWitnesses' = NO_STEP_WITNESSES,
  }

  /// The scheduled run of a minute queues the first attempt of its firing. A late run starts a
  /// minute or more after the minute it was scheduled for. A repeated run queues the firing again.
  action theScheduledRunQueues: bool = all {
    cronRuns < RUNS,
    FIRINGS > 0,
    nondet firing = 0.to(FIRINGS - 1).oneOf()
    nondet late = Set(true, false).oneOf()
    val id = world.messages.keys().size()
    all {
      world' = { ...world, messages: world.messages.put(id, { firing: firing, attempt: 1, delay: 0, acked: false }) },
      lastStepKept' = ALL_KEPT,
      conversationRestarts' = conversationRestarts,
      lateRuns' = if (late) lateRuns.union(Set(id)) else lateRuns,
      stepWitnesses' = NO_STEP_WITNESSES,
    },
  }

  /// The router queues the first attempt of a vendor event firing whose trigger reports in a
  /// channel. A redelivered webhook queues the firing again.
  action aChannelEventFires: bool = all {
    cronRuns < RUNS,
    CHANNEL_EVENT_FIRINGS > 0,
    nondet firing = FIRINGS.to(CHANNEL_FIRINGS - 1).oneOf()
    move({ ...world, messages: world.messages.put(world.messages.keys().size(), { firing: firing, attempt: 1, delay: 0, acked: false }) }),
  }

  /// The router queues the first attempt of a pull request firing. A redelivered webhook queues
  /// the firing again.
  action aPullRequestEventFires: bool = all {
    cronRuns < RUNS,
    PULL_FIRINGS > 0,
    nondet firing = CHANNEL_FIRINGS.to(CHANNEL_FIRINGS + PULL_FIRINGS - 1).oneOf()
    move({ ...world, messages: world.messages.put(world.messages.keys().size(), { firing: firing, attempt: 1, delay: 0, acked: false }) }),
  }

  /// The queue delivers a message it has not seen acknowledged, also while another delivery of it
  /// runs.
  action theQueueDelivers: bool = all {
    deliveriesMade < DELIVERIES,
    waitingMessages.size() > 0,
    nondet id = waitingMessages.oneOf()
    move(delivered(world, id)),
  }

  /// The chat answers the start line post. A refused post fails the attempt without a thread.
  action theStartLinePostReturns: bool = {
    val posting = deliveriesWhere(world, isPostOut)
    all {
      posting.size() > 0,
      nondet delivery = posting.oneOf()
      nondet posted = Set(true, false).oneOf()
      val lostTheRace = world.records.keys().contains(messageOf(world, delivery).firing)
      val after = if (posted) startLinePosted(world, delivery) else failedAttempt(world, delivery, NoPlace)
      all {
        world' = after,
        lastStepKept' = rulesKeptBy(world, after),
        conversationRestarts' = conversationRestarts,
        lateRuns' = lateRuns,
        stepWitnesses' = { ...NO_STEP_WITNESSES, lostTheRecordRace: posted and lostTheRace },
      },
    }
  }

  /// The conversation of the called place takes the firing. A firing it saw before gets the
  /// duplicate answer. Otherwise it records the firing as seen, creates the workflow and queues the
  /// agent's first message in one synchronous block, then awaits the rest of its handler.
  pure def tookTheFiring(w: World, delivery: int): World = match calledPlace(w.deliveries.get(delivery).phase) {
    | At(place) => match place {
      | InThread(thread) =>
        if (w.startedConversations.contains(thread)) finish(w, delivery, Taken)
        else withPhase({ ...w, startedConversations: w.startedConversations.union(Set(thread)) }, delivery, Answering(place))
      | OnThePullRequest => tookThePullRequestFiring(w, delivery)
    }
    | NoPlace => w
  }

  /// The pull request's conversation takes a firing. A firing it saw before gets the duplicate
  /// answer. While its workflow ends, it refuses the firing, which fails the attempt. Otherwise one
  /// synchronous block records the firing as seen and queues its prompt to the running workflow,
  /// or to the workflow it creates when none runs. Then the handler awaits the rest.
  pure def tookThePullRequestFiring(w: World, delivery: int): World = {
    val firing = messageOf(w, delivery).firing
    if (w.pullSeen.contains(firing)) finish(w, delivery, Taken)
    else if (pullWorkflowIs(w, WorkflowEnding)) failedAttempt(w, delivery, At(OnThePullRequest))
    else {
      val workflows = if (pullWorkflowIs(w, WorkflowRunning)) w.pullWorkflows else w.pullWorkflows.append(WorkflowRunning)
      val prompted = {
        ...w,
        pullWorkflows: workflows,
        pullSeen: w.pullSeen.union(Set(firing)),
        pullPrompts: w.pullPrompts.append({ firing: firing, workflow: workflows.length() - 1 }),
      }
      withPhase(prompted, delivery, Answering(OnThePullRequest))
    }
  }

  /// The conversation takes the call.
  action theConversationTakesTheFiring: bool = {
    val calling = deliveriesWhere(world, isCallOut)
    all {
      calling.size() > 0,
      nondet delivery = calling.oneOf()
      val taken = tookTheFiring(world, delivery)
      val creates = taken.startedConversations.size() > world.startedConversations.size()
      all {
        world' = taken,
        lastStepKept' = rulesKeptBy(world, taken),
        conversationRestarts' = conversationRestarts,
        lateRuns' = lateRuns,
        stepWitnesses' = { ...NO_STEP_WITNESSES, startedOnTheSecondAttempt: creates and messageOf(world, delivery).attempt == 2 },
      },
    }
  }

  /// The conversation's handler returns that it started the workflow.
  action theConversationAnswers: bool = {
    val answering = deliveriesWhere(world, isAnswering)
    all {
      answering.size() > 0,
      nondet delivery = answering.oneOf()
      move(finish(world, delivery, Taken)),
    }
  }

  /// The call throws before the conversation takes it, which fails the attempt.
  action theConversationCallFails: bool = {
    val calling = deliveriesWhere(world, isCallOut)
    all {
      calling.size() > 0,
      nondet delivery = calling.oneOf()
      move(failedAttempt(world, delivery, calledPlace(world.deliveries.get(delivery).phase))),
    }
  }

  /// A thread's conversation restarts while its handler awaits after the create. The call throws,
  /// which fails the attempt. The store keeps the seen firing and the workflow.
  action theConversationRestarts: bool = {
    val answering = deliveriesWhere(world, isAnsweringInAThread)
    all {
      conversationRestarts < RESTARTS,
      answering.size() > 0,
      nondet delivery = answering.oneOf()
      val after = failedAttempt(world, delivery, calledPlace(world.deliveries.get(delivery).phase))
      all {
        world' = after,
        lastStepKept' = rulesKeptBy(world, after),
        conversationRestarts' = conversationRestarts + 1,
        lateRuns' = lateRuns,
        stepWitnesses' = NO_STEP_WITNESSES,
      },
    }
  }

  /// The pull request's conversation restarts while a handler awaits after its prompt or while its
  /// workflow ends. Every call out to it throws, which fails those attempts. The store keeps the
  /// seen firings, the workflows and the end, which the start step goes on with.
  action thePullRequestConversationRestarts: bool = {
    val answering = deliveriesWhere(world, phase => isAnswering(phase) and isOnThePullRequest(phase))
    all {
      conversationRestarts < RESTARTS,
      answering.size() > 0 or pullWorkflowIs(world, WorkflowEnding),
      val after = answering.fold(world, (failed, delivery) => failedAttempt(failed, delivery, At(OnThePullRequest)))
      all {
        world' = after,
        lastStepKept' = rulesKeptBy(world, after),
        conversationRestarts' = conversationRestarts + 1,
        lateRuns' = lateRuns,
        stepWitnesses' = NO_STEP_WITNESSES,
      },
    }
  }

  /// The pull request merges or closes, which starts the end of its running workflow.
  action theWatcherEndStarts: bool = all {
    pullWorkflowIs(world, WorkflowRunning),
    move(withLastPullWorkflow(world, WorkflowEnding)),
  }

  /// The end of the pull request's workflow finishes, from the alarm that goes on with it. The
  /// close armed it, and a restart arms it again.
  action theWatcherEndFinishes: bool = all {
    pullWorkflowIs(world, WorkflowEnding),
    move(withLastPullWorkflow(world, WorkflowEnded)),
  }

  /// The queue answers the send of the next attempt. A failed send throws, so the queue delivers
  /// the message again.
  action theNextAttemptIsSent: bool = {
    val sending = deliveriesWhere(world, isSendOut)
    all {
      sending.size() > 0,
      nondet delivery = sending.oneOf()
      nondet sent = Set(true, false).oneOf()
      move(
        if (sent) finish(withNextAttempt(world, delivery), delivery, NextAttemptSent)
        else withPhase(world, delivery, Finished(Redelivered))
      ),
    }
  }

  /// The chat answers the failure line post. A refused post is only logged.
  action theFailureLinePostReturns: bool = {
    val posting = deliveriesWhere(world, isFailureLineOut)
    all {
      posting.size() > 0,
      nondet delivery = posting.oneOf()
      nondet posted = Set(true, false).oneOf()
      move(finish(world, delivery, GaveUp(calledPlace(world.deliveries.get(delivery).phase)))),
    }
  }

  /// A consumer dies while it waits on a call, and the queue keeps its message. The start line
  /// post or the send it waited on may still land.
  action aConsumerDies: bool = {
    val working = deliveriesWhere(world, isWorking)
    all {
      working.size() > 0,
      nondet delivery = working.oneOf()
      nondet landed = Set(true, false).oneOf()
      val phase = world.deliveries.get(delivery).phase
      val firing = messageOf(world, delivery).firing
      val postLanded =
        if (landed and isPostOut(phase)) { ...world, startLines: world.startLines.put(world.startLines.keys().size(), firing) }
        else world
      val sendLanded = if (landed and isSendOut(phase)) withNextAttempt(postLanded, delivery) else postLanded
      move(withPhase(sendLanded, delivery, Died)),
    }
  }

  /// Every scheduled run queued, the queue delivered what it can, every delivery returned or
  /// died, and the pull request's workflow does not run or end. The model stays in this end state,
  /// so TLC does not report the end as a deadlock.
  action finished: bool = all {
    cronRuns == RUNS,
    waitingMessages.size() == 0 or deliveriesMade == DELIVERIES,
    deliveriesWhere(world, isWorking).size() == 0,
    activePullWorkflows(world).size() == 0,
    world' = world,
    lastStepKept' = ALL_KEPT,
    conversationRestarts' = conversationRestarts,
    lateRuns' = lateRuns,
    stepWitnesses' = stepWitnesses,
  }

  action step: bool = any {
    theScheduledRunQueues,
    aChannelEventFires,
    aPullRequestEventFires,
    theQueueDelivers,
    theStartLinePostReturns,
    theConversationTakesTheFiring,
    theConversationAnswers,
    theConversationCallFails,
    theConversationRestarts,
    thePullRequestConversationRestarts,
    theWatcherEndStarts,
    theWatcherEndFinishes,
    theNextAttemptIsSent,
    theFailureLinePostReturns,
    aConsumerDies,
    finished,
  }

  /// A firing starts at most one workflow, across duplicate runs, late runs, redeliveries,
  /// retries, racing consumers and restarts. Only the conversation of its recorded start line
  /// starts it.
  val aFiringStartsAtMostOneWorkflow: bool = and {
    0.to(CHANNEL_FIRINGS - 1).forall(firing => startedThreadsOf(world, firing).size() <= 1),
    world.startedConversations.forall(thread => isRecordedThread(world, thread)),
  }

  /// A firing keeps one thread. The record names a start line of the firing. Every attempt calls
  /// the recorded thread's conversation and posts its failure line there, and only that thread's
  /// conversation is recorded for replies.
  val aRetriedFiringKeepsItsThread: bool = and {
    world.records.keys().forall(firing => world.startLines.get(world.records.get(firing)) == firing),
    world.recordedConversations.forall(thread => isRecordedThread(world, thread)),
    world.failureLines.keys().forall(thread => isRecordedThread(world, thread)),
    world.deliveries.keys().forall(delivery => match calledPlace(world.deliveries.get(delivery).phase) {
      | At(place) => match place {
        | InThread(thread) => recordedThreadIs(world, messageOf(world, delivery).firing, thread)
        | OnThePullRequest => isPullFiring(messageOf(world, delivery).firing)
      }
      | NoPlace => true
    }),
  }

  /// A firing gets at most three attempts, the second after 30 seconds and the third after 2
  /// minutes. An attempt before the last that returns without the workflow has sent the next
  /// attempt. A taken attempt leaves the workflow started. Only the last attempt gives up, and it
  /// posts the failure line in the thread it has.
  val aFailedFiringIsTriedUntilItsAttemptsRunOut: bool = and {
    world.messages.keys().forall(id => {
      val message = world.messages.get(id)
      and {
        message.attempt >= 1,
        message.attempt <= LAST_ATTEMPT,
        message.delay == delayBefore(message.attempt),
        (message.acked and message.attempt < LAST_ATTEMPT and startedThreadsOf(world, message.firing).size() == 0 and promptsOf(world, message.firing).size() == 0)
          implies hasAttempt(world, message.firing, message.attempt + 1),
      }
    }),
    world.failureLines.keys().forall(thread => hasAttempt(world, world.startLines.get(thread), LAST_ATTEMPT)),
    world.failureComments > 0 implies CHANNEL_FIRINGS.to(CHANNEL_FIRINGS + PULL_FIRINGS - 1).exists(firing => hasAttempt(world, firing, LAST_ATTEMPT)),
    world.deliveries.keys().forall(delivery => match world.deliveries.get(delivery).phase {
      | Finished(ending) => match ending {
        | GaveUp(reached) => and {
          messageOf(world, delivery).attempt == LAST_ATTEMPT,
          match reached {
            | At(place) => match place {
              | InThread(line) => world.failureLines.keys().contains(line)
              | OnThePullRequest => world.failureComments > 0
            }
            | NoPlace => true
          },
        }
        | Taken =>
          if (isPullFiring(messageOf(world, delivery).firing)) promptsOf(world, messageOf(world, delivery).firing).size() > 0
          else startedThreadsOf(world, messageOf(world, delivery).firing).size() > 0
        | _ => true
      }
      | _ => true
    }),
  }

  /// A pull request firing's prompt reaches one workflow once, across redeliveries, retries and
  /// restarts. A taken attempt leaves it delivered. The pull request's conversation holds at most
  /// one workflow that has not ended, and it is the last one. A firing seen there has its prompt.
  val aFiringOnAnActiveDefinitionReachesItsWorkflowOnce: bool = and {
    CHANNEL_FIRINGS.to(CHANNEL_FIRINGS + PULL_FIRINGS - 1).forall(firing => promptsOf(world, firing).size() <= 1),
    world.pullSeen.forall(firing => promptsOf(world, firing).size() == 1),
    activePullWorkflows(world).forall(workflow => workflow == world.pullWorkflows.length() - 1),
    world.deliveries.keys().forall(delivery => match world.deliveries.get(delivery).phase {
      | Finished(ending) =>
        (ending == Taken and isPullFiring(messageOf(world, delivery).firing))
          implies promptsOf(world, messageOf(world, delivery).firing).size() == 1
      | _ => true
    }),
  }

  /// A firing's prompt never reaches a workflow whose end started.
  val aFiringNeverLandsOnAnEndingWorkflow: bool = lastStepKept.aFiringNeverLandsOnAnEndingWorkflow

  /// Witness for `aFiringStartsAtMostOneWorkflow`: two deliveries of one message returned, and its
  /// firing started one workflow.
  val aFiringDeliveredTwiceStartsOnce: bool = world.messages.keys().exists(id => and {
    world.deliveries.keys().filter(delivery => and {
      world.deliveries.get(delivery).message == id,
      isFinished(world.deliveries.get(delivery).phase),
    }).size() >= 2,
    startedThreadsOf(world, world.messages.get(id).firing).size() == 1,
  })

  /// Witness for `aFiringStartsAtMostOneWorkflow`: a late run and another run queued one minute's
  /// firing, the late run's message was acknowledged, and the firing started one workflow.
  val aLateCronRunFiresOnce: bool = lateRuns.exists(id => {
    val firing = world.messages.get(id).firing
    and {
      world.messages.keys().exists(other => and {
        other != id,
        world.messages.get(other).firing == firing,
        world.messages.get(other).attempt == 1,
      }),
      world.messages.get(id).acked,
      startedThreadsOf(world, firing).size() == 1,
    }
  })

  /// Witness for `aFailedFiringIsTriedUntilItsAttemptsRunOut`: the conversation started the
  /// workflow on a firing's second attempt.
  val aFiringStartsOnItsSecondAttempt: bool = stepWitnesses.startedOnTheSecondAttempt

  /// Witness for `aFailedFiringIsTriedUntilItsAttemptsRunOut`: a firing's last attempt failed in
  /// its thread, which got the failure line.
  val aFiringRunsOutOfAttempts: bool = world.deliveries.keys().exists(delivery => match world.deliveries.get(delivery).phase {
    | Finished(ending) => match ending {
      | GaveUp(reached) => reached != NoPlace
      | _ => false
    }
    | _ => false
  })

  /// Witness for `aRetriedFiringKeepsItsThread`: a later attempt of a firing calls the conversation
  /// of the thread an earlier attempt recorded.
  val aRetryReusesItsThread: bool = world.deliveries.keys().exists(delivery => and {
    messageOf(world, delivery).attempt >= 2,
    isCallOut(world.deliveries.get(delivery).phase),
  })

  /// Witness for `aRetriedFiringKeepsItsThread`: two deliveries of a firing posted start lines, and
  /// the one that recorded second calls the thread the first recorded.
  val twoConsumersRaceOneStartLine: bool = stepWitnesses.lostTheRecordRace

  /// Witness for `aFiringOnAnActiveDefinitionReachesItsWorkflowOnce`: a second event on the pull
  /// request, such as its ready for review, prompted the workflow the first one started.
  val aReadyForReviewInstructsTheRunningReview: bool = world.pullPrompts.indices().exists(first =>
    world.pullPrompts.indices().exists(second => and {
      first != second,
      world.pullPrompts[first].workflow == world.pullPrompts[second].workflow,
    })
  )

  /// Witness for `aFiringNeverLandsOnAnEndingWorkflow`: a pull request firing, such as a trigger on
  /// its close, failed its attempt while the workflow ended, and its next attempt started the next
  /// workflow.
  val aClosedTriggerWaitsForTheEnd: bool = world.pullPrompts.indices().exists(prompt => and {
    world.pullPrompts[prompt].workflow > 0,
    world.messages.keys().exists(id => and {
      world.messages.get(id).firing == world.pullPrompts[prompt].firing,
      world.messages.get(id).attempt == 2,
    }),
  })

  /// Witness for `aFiringOnAnActiveDefinitionReachesItsWorkflowOnce`: the pull request's workflow
  /// ended, and the first attempt of a later firing, such as its reopen, started the next one.
  val aCloseThenReopenStartsANewReview: bool = world.pullPrompts.indices().exists(prompt => and {
    world.pullPrompts[prompt].workflow > 0,
    world.messages.keys().forall(id =>
      world.messages.get(id).firing == world.pullPrompts[prompt].firing implies world.messages.get(id).attempt == 1
    ),
  })

  /// Witness for `aFailedFiringIsTriedUntilItsAttemptsRunOut`: a pull request firing's last attempt
  /// failed, and the pull request got the failure comment.
  val aPullRequestFiringRunsOutOfAttempts: bool = world.failureComments > 0

  /// Witness for `aFiringStartsAtMostOneWorkflow`: a vendor event firing with a channel, delivered
  /// twice, started its workflow once in the thread of its start line.
  val aChannelEventStartsInItsThread: bool = world.messages.keys().exists(id => and {
    world.messages.get(id).firing >= FIRINGS,
    not(isPullFiring(world.messages.get(id).firing)),
    world.deliveries.keys().filter(delivery => world.deliveries.get(delivery).message == id).size() >= 2,
    startedThreadsOf(world, world.messages.get(id).firing).size() == 1,
  })
}
