/// How the firings of schedule triggers reach their conversations through the firing queue.
/// The scheduled run queues a firing's first attempt. Each queue delivery runs the consumer on one
/// message. The consumer reads the firing's start line record. Without one, it posts the start
/// line, records it unless a racing delivery recorded one first, and uses the recorded one. It then
/// records the thread's conversation and hands the firing to it. A failed attempt sends the next
/// one after its delay, and the last failure posts the failure line in the thread.
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
  /// The thread an attempt works in: none, or a start line by its place in the posts.
  type ThreadRef = NoThread | InThread(int)

  /// How a delivery returned to the queue. `Taken` is an answer that the conversation started the
  /// workflow or saw the firing before. `NextAttemptSent` follows a failed attempt before the last.
  /// `GaveUp` follows the last failed attempt, with the thread its failure line went to. A
  /// delivery whose send of the next attempt failed throws, so the queue delivers it again.
  type Ending = Taken | NextAttemptSent | GaveUp(ThreadRef) | Redelivered

  /// Where a delivery stands. `PostOut` waits on the start line post. `CallOut` waits on the
  /// conversation of the thread, and `Answering` on a conversation that took the firing.
  /// `SendOut` waits on the send of the next attempt, and `FailureLineOut` on the failure line
  /// post. `Died` is a consumer that stopped mid-work.
  type Phase =
    | PostOut
    | CallOut(int)
    | Answering(int)
    | SendOut
    | FailureLineOut(int)
    | Finished(Ending)
    | Died

  /// One run of the consumer on one message.
  type Delivery = { message: int, phase: Phase }

  /// One attempt of a firing in the queue. `delay` is the wait before the queue delivers it, in
  /// seconds. `acked` is true once a delivery acknowledged it.
  type Message = { firing: int, attempt: int, delay: int, acked: bool }

  /// The queue, the chat, D1 and the conversations. `startLines` holds the firing of each start
  /// line, by its thread. `records` holds the recorded thread of each firing. `failureLines` holds
  /// the failure line posts sent to each thread.
  type World = {
    messages: int -> Message,
    deliveries: int -> Delivery,
    startLines: int -> int,
    records: int -> int,
    recordedConversations: Set[int],
    startedConversations: Set[int],
    failureLines: int -> int,
  }

  /// Witnesses that need the step that reached them.
  type StepWitnesses = { startedOnTheSecondAttempt: bool, lostTheRecordRace: bool }

  /// The scheduled minutes that fire, one firing each.
  const FIRINGS: int

  /// The most scheduled runs, counted over every minute.
  const RUNS: int

  /// The most queue deliveries.
  const DELIVERIES: int

  /// The most conversation restarts.
  const RESTARTS: int

  /// The attempts a firing gets.
  pure val LAST_ATTEMPT: int = 3

  pure val NO_STEP_WITNESSES: StepWitnesses = { startedOnTheSecondAttempt: false, lostTheRecordRace: false }

  pure val EMPTY_WORLD: World = {
    messages: Map(),
    deliveries: Map(),
    startLines: Map(),
    records: Map(),
    recordedConversations: Set(),
    startedConversations: Set(),
    failureLines: Map(),
  }

  var world: World

  /// The conversation restarts so far.
  var conversationRestarts: int

  /// The messages a late scheduled run queued. Only witnesses read it.
  var lateRuns: Set[int]

  var stepWitnesses: StepWitnesses

  /// The wait before the queue delivers an attempt: none for the first, then 30 seconds and 2 minutes.
  pure def delayBefore(attempt: int): int = if (attempt == 2) 30 else if (attempt == 3) 120 else 0

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

  /// The thread a delivery calls or posts the failure line to.
  pure def calledThread(phase: Phase): ThreadRef = match phase {
    | CallOut(thread) => InThread(thread)
    | Answering(thread) => InThread(thread)
    | FailureLineOut(thread) => InThread(thread)
    | _ => NoThread
  }

  pure def isCallOut(phase: Phase): bool = match phase {
    | CallOut(_) => true
    | _ => false
  }

  pure def isAnswering(phase: Phase): bool = match phase {
    | Answering(_) => true
    | _ => false
  }

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
  /// it logs the error and posts the failure line in the thread it has.
  pure def attemptFailed(w: World, delivery: int, thread: ThreadRef): World =
    if (messageOf(w, delivery).attempt < LAST_ATTEMPT) withPhase(w, delivery, SendOut)
    else match thread {
      | InThread(line) => {
        val posting = withPhase(w, delivery, FailureLineOut(line))
        val sent = if (w.failureLines.keys().contains(line)) w.failureLines.get(line) else 0
        { ...posting, failureLines: posting.failureLines.put(line, sent + 1) }
      }
      | NoThread => finish(w, delivery, GaveUp(NoThread))
    }

  /// The consumer records the thread's conversation and calls it with the firing.
  pure def callTheConversation(w: World, delivery: int, thread: int): World =
    withPhase({ ...w, recordedConversations: w.recordedConversations.union(Set(thread)) }, delivery, CallOut(thread))

  /// A queue delivery reads the firing's start line record. It calls the recorded thread's
  /// conversation, or posts the start line when the firing does not have a record.
  pure def delivered(w: World, id: int): World = {
    val firing = w.messages.get(id).firing
    val delivery = w.deliveries.keys().size()
    val started = { ...w, deliveries: w.deliveries.put(delivery, { message: id, phase: PostOut }) }
    if (w.records.keys().contains(firing)) callTheConversation(started, delivery, w.records.get(firing))
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

  /// The scheduled runs so far, one first attempt each.
  val cronRuns: int = world.messages.keys().filter(id => world.messages.get(id).attempt == 1).size()

  /// The queue deliveries so far.
  val deliveriesMade: int = world.deliveries.keys().size()

  val waitingMessages: Set[int] = world.messages.keys().filter(id => not(world.messages.get(id).acked))

  action init: bool = all {
    world' = EMPTY_WORLD,
    conversationRestarts' = 0,
    lateRuns' = Set(),
    stepWitnesses' = NO_STEP_WITNESSES,
  }

  /// One step that does not reach a step witness.
  action move(nextWorld: World): bool = all {
    world' = nextWorld,
    conversationRestarts' = conversationRestarts,
    lateRuns' = lateRuns,
    stepWitnesses' = NO_STEP_WITNESSES,
  }

  /// The scheduled run of a minute queues the first attempt of its firing. A late run starts a
  /// minute or more after the minute it was scheduled for. A repeated run queues the firing again.
  action theScheduledRunQueues: bool = all {
    cronRuns < RUNS,
    nondet firing = 0.to(FIRINGS - 1).oneOf()
    nondet late = Set(true, false).oneOf()
    val id = world.messages.keys().size()
    all {
      world' = { ...world, messages: world.messages.put(id, { firing: firing, attempt: 1, delay: 0, acked: false }) },
      conversationRestarts' = conversationRestarts,
      lateRuns' = if (late) lateRuns.union(Set(id)) else lateRuns,
      stepWitnesses' = NO_STEP_WITNESSES,
    },
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
      all {
        world' = if (posted) startLinePosted(world, delivery) else attemptFailed(world, delivery, NoThread),
        conversationRestarts' = conversationRestarts,
        lateRuns' = lateRuns,
        stepWitnesses' = { ...NO_STEP_WITNESSES, lostTheRecordRace: posted and lostTheRace },
      },
    }
  }

  /// The conversation of the called thread takes the firing. A firing it saw before gets the
  /// duplicate answer. Otherwise it records the firing as seen, creates the workflow and queues the
  /// agent's first message in one synchronous block, then awaits the rest of its handler.
  pure def tookTheFiring(w: World, delivery: int): World = match calledThread(w.deliveries.get(delivery).phase) {
    | InThread(thread) =>
      if (w.startedConversations.contains(thread)) finish(w, delivery, Taken)
      else withPhase({ ...w, startedConversations: w.startedConversations.union(Set(thread)) }, delivery, Answering(thread))
    | NoThread => w
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
      move(attemptFailed(world, delivery, calledThread(world.deliveries.get(delivery).phase))),
    }
  }

  /// The conversation restarts while its handler awaits after the create. The call throws, which
  /// fails the attempt. The store keeps the seen firing and the workflow.
  action theConversationRestarts: bool = {
    val answering = deliveriesWhere(world, isAnswering)
    all {
      conversationRestarts < RESTARTS,
      answering.size() > 0,
      nondet delivery = answering.oneOf()
      all {
        world' = attemptFailed(world, delivery, calledThread(world.deliveries.get(delivery).phase)),
        conversationRestarts' = conversationRestarts + 1,
        lateRuns' = lateRuns,
        stepWitnesses' = NO_STEP_WITNESSES,
      },
    }
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
      move(finish(world, delivery, GaveUp(calledThread(world.deliveries.get(delivery).phase)))),
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

  /// Every scheduled run queued, the queue delivered what it can, and every delivery returned or
  /// died. The model stays in this end state, so TLC does not report the end as a deadlock.
  action finished: bool = all {
    cronRuns == RUNS,
    waitingMessages.size() == 0 or deliveriesMade == DELIVERIES,
    deliveriesWhere(world, isWorking).size() == 0,
    world' = world,
    conversationRestarts' = conversationRestarts,
    lateRuns' = lateRuns,
    stepWitnesses' = stepWitnesses,
  }

  action step: bool = any {
    theScheduledRunQueues,
    theQueueDelivers,
    theStartLinePostReturns,
    theConversationTakesTheFiring,
    theConversationAnswers,
    theConversationCallFails,
    theConversationRestarts,
    theNextAttemptIsSent,
    theFailureLinePostReturns,
    aConsumerDies,
    finished,
  }

  /// A firing starts at most one workflow, across duplicate runs, late runs, redeliveries,
  /// retries, racing consumers and restarts. Only the conversation of its recorded start line
  /// starts it.
  val aFiringStartsAtMostOneWorkflow: bool = and {
    0.to(FIRINGS - 1).forall(firing => startedThreadsOf(world, firing).size() <= 1),
    world.startedConversations.forall(thread => isRecordedThread(world, thread)),
  }

  /// A firing keeps one thread. The record names a start line of the firing. Every attempt calls
  /// the recorded thread's conversation and posts its failure line there, and only that thread's
  /// conversation is recorded for replies.
  val aRetriedFiringKeepsItsThread: bool = and {
    world.records.keys().forall(firing => world.startLines.get(world.records.get(firing)) == firing),
    world.recordedConversations.forall(thread => isRecordedThread(world, thread)),
    world.failureLines.keys().forall(thread => isRecordedThread(world, thread)),
    world.deliveries.keys().forall(delivery => match calledThread(world.deliveries.get(delivery).phase) {
      | InThread(thread) => recordedThreadIs(world, messageOf(world, delivery).firing, thread)
      | NoThread => true
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
        (message.acked and message.attempt < LAST_ATTEMPT and startedThreadsOf(world, message.firing).size() == 0)
          implies hasAttempt(world, message.firing, message.attempt + 1),
      }
    }),
    world.failureLines.keys().forall(thread => hasAttempt(world, world.startLines.get(thread), LAST_ATTEMPT)),
    world.deliveries.keys().forall(delivery => match world.deliveries.get(delivery).phase {
      | Finished(ending) => match ending {
        | GaveUp(thread) => and {
          messageOf(world, delivery).attempt == LAST_ATTEMPT,
          match thread {
            | InThread(line) => world.failureLines.keys().contains(line)
            | NoThread => true
          },
        }
        | Taken => startedThreadsOf(world, messageOf(world, delivery).firing).size() > 0
        | _ => true
      }
      | _ => true
    }),
  }

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
      | GaveUp(thread) => thread != NoThread
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
}
