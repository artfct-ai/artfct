/// How the router acknowledges a message while its workflow takes it. A chat message that waits
/// past the delay gets the eyes reaction, and the eyes come off once the delivery settles.
/// Each message is its own delivery, its own eyes timer, and its own reaction calls on the chat.
/// Every message waits the same delay, so the delays pass in the order the messages arrived.
module chatAcknowledgement {
  /// Where a message comes from. Only a chat message names a chat message to react to.
  type Source = Chat | Tracker

  /// What a delivery settled with, or what the caller got. Pending until it settles.
  type Outcome = Pending | Returned | Threw

  /// One reaction call on the chat: not sent, out, or answered.
  type CallState = NotSent | Out | Accepted | Refused

  /// One message. `slow` is true once the delay passed while its delivery ran. `addsSent` and
  /// `removesSent` count the eyes add and removal calls the router made for it.
  type Message = {
    source: Source,
    timerArmed: bool,
    slow: bool,
    delivery: Outcome,
    add: CallState,
    addsSent: int,
    remove: CallState,
    removesSent: int,
    callerGot: Outcome,
  }

  /// How many messages arrive.
  const MESSAGES: int

  /// The messages that arrived, by the order they arrived in.
  var messages: int -> Message

  /// How many messages, in the order they arrived, have waited the whole delay.
  var delaysPassed: int

  pure def arrived(source: Source): Message = {
    source: source,
    timerArmed: source == Chat,
    slow: false,
    delivery: Pending,
    add: NotSent,
    addsSent: 0,
    remove: NotSent,
    removesSent: 0,
    callerGot: Pending,
  }

  /// The router sends the eyes removal for eyes the chat accepted. Otherwise the caller gets
  /// what the delivery gave.
  pure def afterTheEyes(message: Message): Message =
    if (message.add == Accepted)
      { ...message, remove: Out, removesSent: message.removesSent + 1 }
    else
      { ...message, callerGot: message.delivery }

  action init: bool = all {
    messages' = Map(),
    delaysPassed' = 0,
  }

  /// A message reaches the router, which arms the eyes timer for a chat message and starts the delivery.
  action messageArrives: bool = {
    nondet source = Set(Chat, Tracker).oneOf()
    all {
      messages.keys().size() < MESSAGES,
      messages' = messages.put(messages.keys().size(), arrived(source)),
      delaysPassed' = delaysPassed,
    }
  }

  /// The delay of the next message passes. While its delivery runs, its timer sends the eyes add.
  action delayPasses: bool = {
    val message = messages.get(delaysPassed)
    val waited = if (message.delivery == Pending) { ...message, slow: true } else message
    val fired =
      if (waited.timerArmed) { ...waited, timerArmed: false, add: Out, addsSent: waited.addsSent + 1 }
      else waited
    all {
      delaysPassed < messages.keys().size(),
      messages' = messages.set(delaysPassed, fired),
      delaysPassed' = delaysPassed + 1,
    }
  }

  /// The chat answers the eyes add. A refused add is logged. A delivery that settled while the
  /// add was out waits for this answer.
  action addReturns: bool = {
    nondet id = messages.keys().filter(id => messages.get(id).add == Out).oneOf()
    nondet accepted = Set(true, false).oneOf()
    val message = messages.get(id)
    val answered = { ...message, add: if (accepted) Accepted else Refused }
    all {
      messages' = messages.set(id, if (message.delivery == Pending) answered else afterTheEyes(answered)),
      delaysPassed' = delaysPassed,
    }
  }

  /// The delivery returns or throws. The router clears the timer and waits for an add that is out.
  action deliverySettles: bool = {
    nondet id = messages.keys().filter(id => messages.get(id).delivery == Pending).oneOf()
    nondet outcome = Set(Returned, Threw).oneOf()
    val settled = { ...messages.get(id), delivery: outcome, timerArmed: false }
    all {
      messages' = messages.set(id, if (settled.add == Out) settled else afterTheEyes(settled)),
      delaysPassed' = delaysPassed,
    }
  }

  /// The chat answers the eyes removal. A refused removal is logged. The caller gets what the delivery gave.
  action removeReturns: bool = {
    nondet id = messages.keys().filter(id => messages.get(id).remove == Out).oneOf()
    nondet accepted = Set(true, false).oneOf()
    val message = messages.get(id)
    all {
      messages' = messages.set(id, {
        ...message,
        remove: if (accepted) Accepted else Refused,
        callerGot: message.delivery,
      }),
      delaysPassed' = delaysPassed,
    }
  }

  /// Every message arrived and waited its delay, and every caller got its result. The model
  /// stays in this end state, so TLC does not report the end as a deadlock.
  action finished: bool = all {
    messages.keys().size() == MESSAGES,
    delaysPassed == MESSAGES,
    messages.keys().forall(id => messages.get(id).callerGot != Pending),
    messages' = messages,
    delaysPassed' = delaysPassed,
  }

  action step: bool = any { messageArrives, delayPasses, addReturns, deliverySettles, removeReturns, finished }

  /// A message gets the eyes at most once. Once its delivery settles, the eyes have come off
  /// exactly when they went on.
  val eyesNeverOutliveTheDelivery: bool = messages.keys().forall(id => {
    val message = messages.get(id)
    and {
      message.addsSent <= 1,
      message.removesSent <= 1,
      message.removesSent == 1 implies message.add == Accepted,
      message.delivery != Pending implies not(message.timerArmed),
      message.callerGot != Pending implies (message.add == Accepted iff message.removesSent == 1),
    }
  })

  /// Only a chat message gets the eyes, and only when the delay passed while its delivery ran.
  val eyesMarkOnlyASlowChatDelivery: bool = messages.keys().forall(id => {
    val message = messages.get(id)
    message.addsSent > 0 implies (message.source == Chat and message.slow)
  })

  /// The caller gets what the delivery returned or threw, after any eyes came off.
  val theCallerGetsWhatTheDeliveryGave: bool = messages.keys().forall(id => {
    val message = messages.get(id)
    message.callerGot != Pending implies and {
      message.callerGot == message.delivery,
      message.add != Out,
      message.remove != Out,
    }
  })

  /// The messages that arrived, which model checking bounds.
  val messagesArrived: int = messages.keys().size()

  /// Witness for `theCallerGetsWhatTheDeliveryGave`: a delivery settled while its eyes add was out.
  val aMessageSettlesWhileTheEyesAreOut: bool =
    messages.keys().exists(id => messages.get(id).delivery != Pending and messages.get(id).add == Out)

  /// Witness for `eyesNeverOutliveTheDelivery`: the chat took the eyes off.
  val theEyesComeOff: bool = messages.keys().exists(id => messages.get(id).remove == Accepted)

  /// Witness for `eyesNeverOutliveTheDelivery`: the chat refused the eyes, so no removal follows.
  val anEyesAddIsRefused: bool =
    messages.keys().exists(id => messages.get(id).add == Refused and messages.get(id).callerGot != Pending)

  /// Witness for `theCallerGetsWhatTheDeliveryGave`: the chat refused the removal and the caller got the delivery.
  val anEyesRemovalIsRefused: bool =
    messages.keys().exists(id => messages.get(id).remove == Refused and messages.get(id).callerGot == Threw)

  /// Witness for `eyesMarkOnlyASlowChatDelivery`: a tracker message waited past the delay.
  val aTrackerMessageOutlivesTheDelay: bool =
    messages.keys().exists(id => messages.get(id).source == Tracker and messages.get(id).slow)

  /// Witness for `eyesMarkOnlyASlowChatDelivery`: a chat message settled before its delay passed.
  val aChatMessageSettlesBeforeTheDelay: bool = messages.keys().exists(id => and {
    messages.get(id).source == Chat,
    messages.get(id).callerGot != Pending,
    not(messages.get(id).slow),
  })
}
