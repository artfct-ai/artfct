/// The orchestrator agent's turns in one workflow: the inbox each turn takes, messages that arrive
/// while a turn runs, one turn at a time, the turn deadline and its watchdog, compaction, restarts
/// of the Durable Object, and where each post goes. Prompt text and model output are left out.
/// Each action is one stretch of code between two awaits. A model call, a decisions call, a
/// summarization call, the closing post and the post that concludes a turn each take two
/// actions: one sends the call, a later one lands it. Tool posts, reactions, alarms and the
/// working status land in the stretch that sends them.
module agentTurnsTypes {
  /// Which reply targets the workflow has: a chat thread, tracker sessions, or both.
  type Surface = ChatOnly | TrackerOnly | ChatAndSession

  /// Where a person wrote from.
  type Origin = ChatThread | StartingSession | JobSession

  /// Who an inbox row is from: a person, or the workflow itself, such as a task event or a note.
  type RowFrom = Person(Origin) | FromWorkflow

  /// One row of the agent inbox. `taken` once a turn took it. `reacted` once its chat message has
  /// the thumbs-up.
  type InboxRow = { id: int, from: RowFrom, taken: bool, reacted: bool }

  /// The tools a model step may call. `React` is `acknowledge` with a reaction.
  type Tool = Acknowledge | React | Ask | Tell | StaySilent | PromptTask | FetchUrl | ReadChannel

  /// What one model call answers: one tool call, closing text, or nothing.
  type ModelAnswer = CallsTool(Tool) | AnswersText | AnswersNothing

  /// What a tool result row holds. A page or chat message is text from outside, by number.
  type ToolOutput =
    | ToolRan
    | ToolFailed
    | ToolRefused
    | PageText(int)
    | PageWithheld(int)
    | ChannelRead(Set[int])

  /// One transcript row. `TakenRows` is the user row that joins the inbox rows a turn took.
  type Entry =
    | TakenRows(Set[int])
    | Recap
    | ToolCallRow(Tool)
    | ToolResultRow(ToolOutput)
    | TextRow
    | UnansweredNote

  type Row = { id: int, entry: Entry }

  /// The stamp of the turn the store holds as running.
  type Stamp = Unstamped | Stamped(int)

  /// A watchdog or heads-up alarm, with the stamp it was armed for.
  type Alarm = NoAlarm | ArmedFor(int)

  /// The first transcript row of the running turn, which compaction keeps.
  type FirstRow = NoFirstRow | FirstRowIs(int)

  /// The session status of the chat thread as the notifier last set it.
  type ChatStatus = NoStatus | Processing | Active

  /// A reply target a post reached.
  type Target = ToChatThread | ToSession(Origin)

  /// What a post says, by kind.
  type PostText =
    | AcknowledgeText
    | QuestionText
    | ToldText
    | ClosingText
    | HeadsUpText
    | LostPlaceText
    | StuckText
    | TimeoutText

  /// One post, the targets it reached, and the sessions the people of its turn wrote from.
  type Post = { text: PostText, targets: Set[Target], answering: Set[Origin] }

  /// The Durable Object storage of the workflow, plus the chat thread and the posts it saw.
  type Store = {
    inbox: List[InboxRow],
    transcript: List[Row],
    nextRowId: int,
    nextInboxId: int,
    stamp: Stamp,
    nextStamp: int,
    watchdog: Alarm,
    headsUp: Alarm,
    firstRow: FirstRow,
    lastInputOverLimit: bool,
    chat: ChatStatus,
    posts: List[Post],
    pagesFetched: int,
    messagesRead: int,
    restarts: int,
  }

  /// What the message of the person who wrote is owed. `NotOwed` when nobody wrote.
  type Owed = NotOwed | OwedAnswer | OwedBoard

  /// How a turn's attempt ended.
  type Outcome = Replied | Silent | Failed | TimedOut

  /// The host call that concludes a turn after its attempt.
  type Conclusion = Releases | PostsStuckText(Set[Target]) | PostsTimeoutText(Set[Target])

  /// The text a screen call reads: a fetched page, or the messages of one chat read.
  type Screened = ScreensPage(int) | ScreensChannelRead(Set[int])

  /// The call a running turn waits on.
  type Phase =
    | ReadingMessage
    | Compacting
    | AwaitingModel
    | Screening({ screened: Screened, overLimit: bool })
    | PostingClosing(Set[Target])
    | Concluding(Conclusion)

  /// One model call of a turn: the tools it ran, and whether it left the person a reply.
  type StepRecord = { ran: Set[Tool], answered: bool }

  /// What happened to one decisions call.
  type DecisionsEvent = DecisionsAsked | DecisionsAnswered | DecisionsFailed

  /// One chat read: the messages in its result, and the messages the screen admitted.
  type ChatRead = { result: Set[int], admitted: Set[int] }

  /// What one turn was given and what it left, as the turn property test records it. A resumed
  /// turn carries the record of the turn it resumes.
  type TurnRecord = {
    owed: Owed,
    boardChanged: bool,
    posts: List[Post],
    steps: List[StepRecord],
    askedAgain: bool,
    closingTextsPosted: int,
    inboxRows: Set[int],
    rowsBefore: List[Row],
    quarantinedPages: Set[int],
    messagesRead: Set[int],
    admittedMessages: Set[int],
    timedOut: bool,
    lostTurnOwed: bool,
    modelHung: bool,
    decisionsEvents: List[DecisionsEvent],
    answeredBy: List[int],
    reads: List[ChatRead],
    answering: Set[Origin],
  }

  /// The turn that runs in the isolate, with what its code keeps in memory.
  type TurnRun = {
    stamp: int,
    phase: Phase,
    aborted: bool,
    pastTimeout: bool,
    olderRows: List[Row],
    reactable: bool,
    decisionsFailed: bool,
    owed: Owed,
    acknowledged: bool,
    firstReplied: bool,
    boardChanged: bool,
    attempt: int,
    pass: int,
    passEndedByTool: bool,
    record: TurnRecord,
  }

  type TurnSlot = NoTurn | Running(TurnRun)

  /// The isolate's memory: the turn that runs, and whether the turn coalescer runs once more.
  type Isolate = { turn: TurnSlot, rerun: bool }

  type Workflow = { store: Store, isolate: Isolate }

  /// A turn that ended in the last step, with the store as the turn left it.
  type TurnEnd =
    | NoTurnEnd
    | TurnEnded({
        record: TurnRecord,
        transcript: List[Row],
        waiting: Set[int],
        chatMessageWaits: bool,
        chat: ChatStatus,
      })

  /// The record a turn starts from: its own, or the one of the lost turn it resumes.
  type Carried = Fresh | ResumedFrom(TurnRecord)

  /// What one configured decisions model does on every call.
  type ModelSays = Answers | Fails | Hangs

  /// What a step leaves: the workflow, and the turn that ended in it.
  type Next = { workflow: Workflow, turnEnd: TurnEnd }
}

/// The agent turns of one workflow on one surface.
module agentTurns {
  import agentTurnsTypes.*

  /// The reply targets of the workflow.
  const SURFACE: Surface

  /// How many inbox rows arrive in a run.
  pure val MAX_ARRIVALS: int = 4

  /// How often the Durable Object restarts in a run.
  pure val MAX_RESTARTS: int = 2

  pure val HAS_CHAT_THREAD: bool = SURFACE != TrackerOnly

  pure val ORIGINS: Set[Origin] = match SURFACE {
    | ChatOnly => Set(ChatThread)
    | TrackerOnly => Set(StartingSession, JobSession)
    | ChatAndSession => Set(ChatThread, StartingSession, JobSession)
  }

  /// The workflow started from a tracker session on every surface but a chat-only one.
  pure val STARTED_FROM_A_SESSION: bool = SURFACE != ChatOnly

  pure val FIRST_REPLY_TOOLS: Set[Tool] = Set(Acknowledge, React, Ask)

  pure val TURN_ENDING_TOOLS: Set[Tool] = Set(Ask, Tell, StaySilent)

  pure val TOOLS: Set[Tool] =
    if (HAS_CHAT_THREAD) Set(Acknowledge, React, Ask, Tell, StaySilent, PromptTask, FetchUrl, ReadChannel)
    else Set(Acknowledge, React, Ask, Tell, StaySilent, PromptTask, FetchUrl)

  pure val MODEL_ANSWERS: Set[ModelAnswer] =
    TOOLS.map(tool => CallsTool(tool)).union(Set(AnswersText, AnswersNothing))

  /// The configured decisions models a run may have, in the order the gateway tries them.
  pure val MODEL_LISTS: Set[List[ModelSays]] =
    Set([Answers], [Fails, Answers], [Hangs, Answers], [Fails], [Hangs, Fails])

  pure val EMPTY_STORE: Store = {
    inbox: [],
    transcript: [],
    nextRowId: 1,
    nextInboxId: 1,
    stamp: Unstamped,
    nextStamp: 1,
    watchdog: NoAlarm,
    headsUp: NoAlarm,
    firstRow: NoFirstRow,
    lastInputOverLimit: false,
    chat: NoStatus,
    posts: [],
    pagesFetched: 0,
    messagesRead: 0,
    restarts: 0,
  }

  pure val FRESH_RECORD: TurnRecord = {
    owed: NotOwed,
    boardChanged: false,
    posts: [],
    steps: [],
    askedAgain: false,
    closingTextsPosted: 0,
    inboxRows: Set(),
    rowsBefore: [],
    quarantinedPages: Set(),
    messagesRead: Set(),
    admittedMessages: Set(),
    timedOut: false,
    lostTurnOwed: false,
    modelHung: false,
    decisionsEvents: [],
    answeredBy: [],
    reads: [],
    answering: Set(),
  }

  var workflow: Workflow
  var models: List[ModelSays]
  var lastTurnEnd: TurnEnd

  pure def isPerson(from: RowFrom): bool = match from { | Person(_) => true | FromWorkflow => false }

  pure def originOf(from: RowFrom): Set[Origin] =
    match from { | Person(origin) => Set(origin) | FromWorkflow => Set() }

  pure def isSessionOrigin(origin: Origin): bool = origin != ChatThread

  pure def idsOf(rows: List[InboxRow]): Set[int] =
    rows.foldl(Set(), (ids, row) => ids.union(Set(row.id)))

  pure def waitingRows(store: Store): List[InboxRow] = store.inbox.select(row => not(row.taken))

  pure def takenPersonRows(store: Store): List[InboxRow] =
    store.inbox.select(row => row.taken and isPerson(row.from))

  /// Where the people the running turn answers wrote from: the transcript's `answering()`.
  pure def answeringNow(store: Store): Set[Origin] =
    takenPersonRows(store).foldl(Set(), (origins, row) => origins.union(originOf(row.from)))

  pure def awaitingThumbsUp(store: Store): List[InboxRow] =
    store.inbox.select(row => row.taken and row.from == Person(ChatThread) and not(row.reacted))

  /// `recipientsOf` for a post to the people a turn answers. `asks` for a question.
  pure def answeringTargets(asks: bool, answering: Set[Origin]): Set[Target] =
    if (HAS_CHAT_THREAD) Set(ToChatThread)
    else answering.filter(isSessionOrigin).map(origin => ToSession(origin))
      .union(if (asks and STARTED_FROM_A_SESSION) Set(ToSession(StartingSession)) else Set())

  /// The targets of a post to every chat thread among the reply targets.
  pure val CHAT_THREADS: Set[Target] = if (HAS_CHAT_THREAD) Set(ToChatThread) else Set()

  /// The index of the first configured decisions model that answers, or -1 when none does.
  pure def firstAnswering(said: List[ModelSays]): int =
    said.foldl({ index: 0, found: -1 }, (search, says) => {
      index: search.index + 1,
      found: if (search.found == -1 and says == Answers) search.index else search.found,
    }).found

  pure def anyOf(items: List[a], test: a => bool): bool =
    items.foldl(false, (found, element) => found or test(element))

  pure def appendRows(store: Store, entries: List[Entry]): Store =
    entries.foldl(store, (grown, entry) => {
      ...grown,
      transcript: grown.transcript.append({ id: grown.nextRowId, entry: entry }),
      nextRowId: grown.nextRowId + 1,
    })

  pure def setLast(steps: List[StepRecord], update: StepRecord => StepRecord): List[StepRecord] =
    if (steps.length() == 0) steps
    else steps.replaceAt(steps.length() - 1, update(steps[steps.length() - 1]))

  /// True for a post that answers the humans in the step it lands in. The heads-up and the
  /// restart notice do not.
  pure def answersInAStep(text: PostText): bool = text != HeadsUpText and text != LostPlaceText

  /// Record a post in the turn record. It counts in the step that runs as it lands.
  pure def recordPost(record: TurnRecord, text: PostText, targets: Set[Target]): TurnRecord = {
    ...record,
    posts: record.posts.append({ text: text, targets: targets, answering: record.answering }),
    steps: setLast(record.steps, step => { ...step, answered: step.answered or answersInAStep(text) }),
  }

  /// A post lands. A post that does not keep the working status leaves the chat thread active.
  pure def landPost(store: Store, text: PostText, targets: Set[Target], keepsSession: bool): Store = {
    ...store,
    posts: store.posts.append({ text: text, targets: targets, answering: answeringNow(store) }),
    chat: if (keepsSession) store.chat else Active,
  }

  pure def withTurn(store: Store, turnRun: TurnRun): Next =
    { workflow: { store: store, isolate: { turn: Running(turnRun), rerun: false } }, turnEnd: NoTurnEnd }

  /// The turn sends a model call. The property test marks a step at every call.
  pure def awaitModel(store: Store, turnRun: TurnRun): Next = withTurn(store, {
    ...turnRun,
    phase: AwaitingModel,
    record: { ...turnRun.record, steps: turnRun.record.steps.append({ ran: Set(), answered: false }) },
  })

  /// Compact when the transcript before the turn is large, then call the model.
  pure def compactThenCallModel(store: Store, turnRun: TurnRun): Next =
    if (turnRun.olderRows.length() > 0 and store.lastInputOverLimit) withTurn(store, { ...turnRun, phase: Compacting })
    else awaitModel(store, turnRun)

  /// `runAgentTurn` takes the inbox, arms the watchdog, and runs until its first call. Null when
  /// the inbox is empty.
  pure def startTurn(store: Store, carried: Carried, said: List[ModelSays]): { store: Store, turn: TurnSlot } =
    val waiting = waitingRows(store)
    if (waiting.length() == 0) { store: store, turn: NoTurn }
    else
      val takenRow = store.nextRowId
      val takenIds = idsOf(waiting)
      val lostTurnOwed = takenPersonRows(store).length() > 0
      val took = appendRows(
        { ...store, inbox: store.inbox.foldl([], (rows, row) => rows.append({ ...row, taken: true })) },
        [TakenRows(takenIds)],
      )
      val first = match store.firstRow { | FirstRowIs(row) => row | NoFirstRow => takenRow }
      val people = takenPersonRows(took)
      val armed = {
        ...took,
        stamp: Stamped(store.nextStamp),
        nextStamp: store.nextStamp + 1,
        watchdog: ArmedFor(store.nextStamp),
        headsUp: if (people.length() > 0) ArmedFor(store.nextStamp) else NoAlarm,
        firstRow: FirstRowIs(first),
      }
      val base = match carried {
        | Fresh => { ...FRESH_RECORD, rowsBefore: store.transcript }
        | ResumedFrom(lost) => if (lostTurnOwed) lost else { ...FRESH_RECORD, rowsBefore: lost.rowsBefore }
      }
      val record = {
        ...base,
        owed: NotOwed,
        inboxRows: idsOf(took.inbox.select(row => row.taken)),
        lostTurnOwed: carried != Fresh and lostTurnOwed,
        modelHung: false,
        decisionsEvents: if (people.length() > 0) [DecisionsAsked] else [],
        answeredBy: [],
        answering: answeringNow(armed),
      }
      val turnRun = {
        stamp: store.nextStamp,
        phase: ReadingMessage,
        aborted: false,
        pastTimeout: false,
        olderRows: if (armed.transcript.select(row => row.id == first).length() > 0) armed.transcript.select(row => row.id < first) else [],
        reactable: awaitingThumbsUp(armed).length() > 0,
        decisionsFailed: false,
        owed: NotOwed,
        acknowledged: false,
        firstReplied: false,
        boardChanged: false,
        attempt: 1,
        pass: 1,
        passEndedByTool: false,
        record: record,
      }
      if (people.length() > 0) { store: armed, turn: Running(turnRun) }
      else
        val after = compactThenCallModel(armed, turnRun)
        { store: after.workflow.store, turn: after.workflow.isolate.turn }

  /// After the read, compact when the transcript before the turn is large, then call the model.
  /// A turn the deadline aborted ends its attempt, since every call it starts throws at once.
  pure def afterRead(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    if (turnRun.aborted) attemptEnds(store, turnRun, TimedOut, rerun, said)
    else keepRerun(compactThenCallModel(store, turnRun), rerun)

  /// The turn calls the model. A call that starts after the deadline aborted the turn throws
  /// before it reaches the model, and the attempt ends.
  pure def callModel(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    if (turnRun.aborted) attemptEnds(store, turnRun, TimedOut, rerun, said)
    else keepRerun(awaitModel(store, turnRun), rerun)

  /// The turn that ended leaves its record. The coalescer runs the next turn when a row arrived.
  pure def endTurn(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    val ended = TurnEnded({
      record: turnRun.record,
      transcript: store.transcript,
      waiting: idsOf(waitingRows(store)),
      chatMessageWaits: anyOf(waitingRows(store), row => row.from == Person(ChatThread)),
      chat: store.chat,
    })
    if (rerun)
      val after = startTurn(store, Fresh, said)
      { workflow: { store: after.store, isolate: { turn: after.turn, rerun: false } }, turnEnd: ended }
    else { workflow: { store: store, isolate: { turn: NoTurn, rerun: false } }, turnEnd: ended }

  /// `boundedAttempt` returns. The turn disarms its watchdog, then concludes when it still owns
  /// the reply.
  pure def attemptEnds(store: Store, turnRun: TurnRun, outcome: Outcome, rerun: bool, said: List[ModelSays]): Next =
    if (store.stamp != Stamped(turnRun.stamp)) endTurn(store, turnRun, rerun, said)
    else
      val disarmed = {
        ...store,
        watchdog: NoAlarm,
        headsUp: NoAlarm,
        stamp: Unstamped,
        firstRow: NoFirstRow,
        inbox: store.inbox.select(row => not(row.taken)),
      }
      val nobody = answeringTargets(false, Set())
      match outcome {
        | Replied => endTurn(disarmed, turnRun, rerun, said)
        | Silent => withTurnKeepingRerun(disarmed, { ...turnRun, phase: Concluding(Releases) }, rerun)
        | Failed => withTurnKeepingRerun(disarmed, { ...turnRun, phase: Concluding(PostsStuckText(nobody)) }, rerun)
        | TimedOut => withTurnKeepingRerun(
            disarmed,
            { ...turnRun, phase: Concluding(PostsTimeoutText(nobody)), record: { ...turnRun.record, timedOut: true } },
            rerun,
          )
      }

  pure def withTurnKeepingRerun(store: Store, turnRun: TurnRun, rerun: bool): Next =
    { workflow: { store: store, isolate: { turn: Running(turnRun), rerun: rerun } }, turnEnd: NoTurnEnd }

  /// A model pass ends. `generate` asks the model again once when a person got nothing, and
  /// posts closing text only as the answer to a person who wrote.
  pure def passEnds(store: Store, turnRun: TurnRun, text: bool, rerun: bool, said: List[ModelSays]): Next =
    if (turnRun.aborted) attemptEnds(store, turnRun, TimedOut, rerun, said)
    else if (turnRun.owed != NotOwed and turnRun.pass == 1 and not(text or turnRun.passEndedByTool or turnRun.boardChanged))
      callModel(
        appendRows(store, [UnansweredNote]),
        { ...turnRun, pass: 2, passEndedByTool: false, record: { ...turnRun.record, askedAgain: true } },
        rerun,
        said,
      )
    else if (turnRun.passEndedByTool or not(text)) attemptEnds(store, turnRun, Silent, rerun, said)
    else if (turnRun.owed == NotOwed or (turnRun.owed == OwedBoard and turnRun.boardChanged)) attemptEnds(store, turnRun, Silent, rerun, said)
    else withTurnKeepingRerun(store, { ...turnRun, phase: PostingClosing(answeringTargets(false, answeringNow(store))) }, rerun)

  pure def keepRerun(after: Next, rerun: bool): Next =
    { ...after, workflow: { ...after.workflow, isolate: { ...after.workflow.isolate, rerun: rerun } } }

  /// The tools the step offers: the first reply tools until one worked in a person's turn.
  pure def offeredTools(turnRun: TurnRun): Set[Tool] =
    val active =
      if (turnRun.owed != NotOwed) TOOLS.exclude(Set(Tell, StaySilent))
      else TOOLS.exclude(Set(Acknowledge, React))
    if (turnRun.owed != NotOwed and not(turnRun.firstReplied)) active.intersect(FIRST_REPLY_TOOLS) else active

  /// `onStep`: the step's rows land, its usage is recorded, and the chat thread shows it working.
  /// The loop stops on a turn-ending tool and calls the model again otherwise.
  pure def stepEnds(store: Store, turnRun: TurnRun, entries: List[Entry], overLimit: bool, ended: bool, rerun: bool, said: List[ModelSays]): Next =
    val landed = { ...appendRows(store, entries), lastInputOverLimit: overLimit, chat: Processing }
    if (ended) passEnds(landed, { ...turnRun, passEndedByTool: true }, false, rerun, said)
    else callModel(landed, turnRun, rerun, said)

  pure def ranIn(turnRun: TurnRun, tool: Tool): TurnRun =
    { ...turnRun, record: { ...turnRun.record, steps: setLast(turnRun.record.steps, step => { ...step, ran: step.ran.union(Set(tool)) }) } }

  /// The model answered with a call to one tool that the step offered. The tool runs.
  pure def runTool(store: Store, turnRun: TurnRun, tool: Tool, overLimit: bool, rerun: bool, said: List[ModelSays]): Next =
    val ran = ranIn(turnRun, tool)
    val answering = answeringTargets(false, answeringNow(store))
    match tool {
      | Acknowledge =>
          if (turnRun.acknowledged) stepEnds(store, ran, [ToolCallRow(tool), ToolResultRow(ToolFailed)], overLimit, false, rerun, said)
          else stepEnds(
            landPost(store, AcknowledgeText, answering, false),
            { ...ran, acknowledged: true, firstReplied: true, record: recordPost(ran.record, AcknowledgeText, answering) },
            [ToolCallRow(tool), ToolResultRow(ToolRan)], overLimit, false, rerun, said)
      | React =>
          if (turnRun.acknowledged or not(turnRun.reactable)) stepEnds(store, ran, [ToolCallRow(tool), ToolResultRow(ToolFailed)], overLimit, false, rerun, said)
          else
            val reacting = idsOf(awaitingThumbsUp(store))
            val reacted = { ...store, inbox: store.inbox.foldl([], (rows, row) => rows.append(if (reacting.contains(row.id)) { ...row, reacted: true } else row)) }
            val answered = { ...ran.record, steps: setLast(ran.record.steps, step => { ...step, answered: step.answered or reacting.size() > 0 }) }
            stepEnds(reacted, { ...ran, acknowledged: true, firstReplied: true, record: answered },
              [ToolCallRow(tool), ToolResultRow(ToolRan)], overLimit, false, rerun, said)
      | Ask =>
          val asked = answeringTargets(true, answeringNow(store))
          stepEnds(
            landPost(store, QuestionText, asked, false),
            { ...ran, firstReplied: true, record: recordPost(ran.record, QuestionText, asked) },
            [ToolCallRow(tool), ToolResultRow(ToolRan)], overLimit, true, rerun, said)
      | Tell =>
          stepEnds(
            landPost(store, ToldText, answering, false),
            { ...ran, record: recordPost(ran.record, ToldText, answering) },
            [ToolCallRow(tool), ToolResultRow(ToolRan)], overLimit, true, rerun, said)
      | StaySilent => stepEnds(store, ran, [ToolCallRow(tool), ToolResultRow(ToolRan)], overLimit, true, rerun, said)
      | PromptTask =>
          val changed = { ...ran, boardChanged: turnRun.boardChanged or HAS_CHAT_THREAD, record: { ...ran.record, boardChanged: ran.record.boardChanged or HAS_CHAT_THREAD } }
          stepEnds(store, changed, [ToolCallRow(tool), ToolResultRow(ToolRan)], overLimit, false, rerun, said)
      | FetchUrl =>
          val page = store.pagesFetched
          val fetched = { ...store, pagesFetched: page + 1 }
          if (turnRun.decisionsFailed)
            stepEnds(fetched, { ...ran, record: { ...ran.record, quarantinedPages: ran.record.quarantinedPages.union(Set(page)) } },
              [ToolCallRow(tool), ToolResultRow(PageWithheld(page))], overLimit, false, rerun, said)
          else withTurnKeepingRerun(fetched, askDecisions({ ...ran, phase: Screening({ screened: ScreensPage(page), overLimit: overLimit }) }), rerun)
      | ReadChannel =>
          val first = store.messagesRead
          val messages = Set(first, first + 1)
          val read = { ...store, messagesRead: first + 2 }
          val recorded = { ...ran.record, messagesRead: ran.record.messagesRead.union(messages) }
          if (turnRun.decisionsFailed)
            stepEnds(read, { ...ran, record: { ...recorded, reads: recorded.reads.append({ result: Set(), admitted: Set() }) } },
              [ToolCallRow(tool), ToolResultRow(ChannelRead(Set()))], overLimit, false, rerun, said)
          else withTurnKeepingRerun(read, askDecisions({ ...ran, record: recorded, phase: Screening({ screened: ScreensChannelRead(messages), overLimit: overLimit }) }), rerun)
    }

  pure def askDecisions(turnRun: TurnRun): TurnRun =
    { ...turnRun, record: { ...turnRun.record, decisionsEvents: turnRun.record.decisionsEvents.append(DecisionsAsked) } }

  /// The flagged message of a chat read. Every read holds one harmless and one malicious message.
  pure def isMalicious(message: int): bool = message % 2 == 1

  /// A screen call lands, and the step that waited on it ends.
  pure def screenLands(store: Store, turnRun: TurnRun, answered: bool, flagsPage: bool, rerun: bool, said: List[ModelSays]): Next =
    match turnRun.phase {
      | Screening(screening) =>
          val record = { ...turnRun.record,
            decisionsEvents: turnRun.record.decisionsEvents.append(if (answered) DecisionsAnswered else DecisionsFailed),
            answeredBy: if (answered) turnRun.record.answeredBy.append(firstAnswering(said)) else turnRun.record.answeredBy,
          }
          val landed = { ...turnRun, decisionsFailed: turnRun.decisionsFailed or not(answered), record: record }
          match screening.screened {
            | ScreensPage(page) =>
                val admitted = answered and not(flagsPage)
                stepEnds(store,
                  if (admitted) landed else { ...landed, record: { ...record, quarantinedPages: record.quarantinedPages.union(Set(page)) } },
                  [ToolCallRow(FetchUrl), ToolResultRow(if (admitted) PageText(page) else PageWithheld(page))],
                  screening.overLimit, false, rerun, said)
            | ScreensChannelRead(messages) =>
                val admitted = if (answered) messages.filter(message => not(isMalicious(message))) else Set()
                stepEnds(store,
                  { ...landed, record: { ...record,
                    admittedMessages: record.admittedMessages.union(admitted),
                    reads: record.reads.append({ result: admitted, admitted: admitted }),
                  } },
                  [ToolCallRow(ReadChannel), ToolResultRow(ChannelRead(admitted))],
                  screening.overLimit, false, rerun, said)
          }
      | _ => { workflow: { store: store, isolate: { turn: Running(turnRun), rerun: rerun } }, turnEnd: NoTurnEnd }
    }

  /// The read of the person's message lands. A failed read owes the person an answer.
  pure def readLands(store: Store, turnRun: TurnRun, owed: Owed, answered: bool, rerun: bool, said: List[ModelSays]): Next =
    val record = { ...turnRun.record,
      owed: if (answered) owed else OwedAnswer,
      decisionsEvents: turnRun.record.decisionsEvents.append(if (answered) DecisionsAnswered else DecisionsFailed),
      answeredBy: if (answered) turnRun.record.answeredBy.append(firstAnswering(said)) else turnRun.record.answeredBy,
    }
    afterRead(store, {
      ...turnRun,
      owed: if (answered) owed else OwedAnswer,
      decisionsFailed: not(answered),
      record: record,
    }, rerun, said)

  pure def modelAnswered(store: Store, turnRun: TurnRun, answer: ModelAnswer, overLimit: bool, rerun: bool, said: List[ModelSays]): Next =
    match answer {
      | AnswersText => passEnds({ ...appendRows(store, [TextRow]), lastInputOverLimit: overLimit }, turnRun, true, rerun, said)
      | AnswersNothing => passEnds({ ...store, lastInputOverLimit: overLimit }, turnRun, false, rerun, said)
      | CallsTool(tool) =>
          if (offeredTools(turnRun).contains(tool)) runTool(store, turnRun, tool, overLimit, rerun, said)
          else stepEnds(store, turnRun, [ToolCallRow(tool), ToolResultRow(ToolRefused)], overLimit, false, rerun, said)
    }

  /// A model call threw. The attempt runs once more, unless the deadline ended the first one.
  pure def modelThrew(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    if (turnRun.attempt == 1 and not(turnRun.aborted))
      callModel(store, { ...turnRun, attempt: 2, pass: 1, passEndedByTool: false }, rerun, said)
    else attemptEnds(store, turnRun, if (turnRun.aborted) TimedOut else Failed, rerun, said)

  /// `resumeLostTurn` on the new instance, and the turn its wake starts.
  pure def restarted(store: Store, lost: TurnSlot, said: List[ModelSays]): Next =
    val counted = { ...store, restarts: store.restarts + 1 }
    match store.stamp {
      | Unstamped => { workflow: { store: counted, isolate: { turn: NoTurn, rerun: false } }, turnEnd: NoTurnEnd }
      | Stamped(_) =>
          val unstamped = { ...counted, stamp: Unstamped, watchdog: NoAlarm, headsUp: NoAlarm }
          val lostRecord = match lost { | Running(turnRun) => turnRun.record | NoTurn => FRESH_RECORD }
          val noticed = takenPersonRows(store).length() > 0 and HAS_CHAT_THREAD
          val told = if (noticed) landPost(unstamped, LostPlaceText, CHAT_THREADS, true) else unstamped
          val carried = if (noticed) recordPost(lostRecord, LostPlaceText, CHAT_THREADS) else lostRecord
          val woken = { ...told,
            inbox: told.inbox.append({ id: told.nextInboxId, from: FromWorkflow, taken: false, reacted: false }),
            nextInboxId: told.nextInboxId + 1,
          }
          val after = startTurn(woken, ResumedFrom(carried), said)
          { workflow: { store: after.store, isolate: { turn: after.turn, rerun: false } }, turnEnd: NoTurnEnd }
    }

  action move(after: Next): bool = all {
    workflow' = after.workflow,
    models' = models,
    lastTurnEnd' = after.turnEnd,
  }

  /// Run `act` on the running turn.
  action onTurn(act: TurnRun => bool): bool = match workflow.isolate.turn {
    | Running(turnRun) => act(turnRun)
    | NoTurn => all { false, move({ workflow: workflow, turnEnd: lastTurnEnd }) }
  }

  action init: bool = all {
    nondet said = MODEL_LISTS.oneOf()
    models' = said,
    workflow' = { store: EMPTY_STORE, isolate: { turn: NoTurn, rerun: false } },
    lastTurnEnd' = NoTurnEnd,
  }

  /// A row lands in the inbox and wakes the agent. The coalescer runs the turn now, or once more
  /// after the turn that runs.
  pure def arrive(w: Workflow, from: RowFrom, said: List[ModelSays]): Next =
    val store = w.store
    val queued = {
      ...store,
      inbox: store.inbox.append({ id: store.nextInboxId, from: from, taken: false, reacted: false }),
      nextInboxId: store.nextInboxId + 1,
      chat: if (from == Person(ChatThread)) Processing else store.chat,
    }
    match w.isolate.turn {
      | Running(_) => { workflow: { store: queued, isolate: { ...w.isolate, rerun: true } }, turnEnd: NoTurnEnd }
      | NoTurn =>
          val after = startTurn(queued, Fresh, said)
          { workflow: { store: after.store, isolate: { turn: after.turn, rerun: false } }, turnEnd: NoTurnEnd }
    }

  /// A person writes. Ingress puts a chat thread in its working status as it acknowledges.
  action personWrites(origin: Origin): bool = all {
    workflow.store.nextInboxId <= MAX_ARRIVALS,
    move(arrive(workflow, Person(origin), models)),
  }

  /// A task event or a note reaches the agent.
  action workflowEventArrives: bool = all {
    workflow.store.nextInboxId <= MAX_ARRIVALS,
    move(arrive(workflow, FromWorkflow, models)),
  }

  /// The decisions model reads the person's message.
  action readAnswers(owed: Owed): bool = onTurn(turnRun => all {
    turnRun.phase == ReadingMessage,
    not(turnRun.aborted),
    firstAnswering(models) >= 0,
    move(readLands(workflow.store, turnRun, owed, true, workflow.isolate.rerun, models)),
  })

  /// The read fails: every configured model failed, or the deadline aborted it.
  action readFails: bool = onTurn(turnRun => all {
    turnRun.phase == ReadingMessage,
    turnRun.aborted or firstAnswering(models) < 0,
    move(readLands(workflow.store, turnRun, OwedAnswer, false, workflow.isolate.rerun, models)),
  })

  pure def isScreening(phase: Phase): bool = match phase { | Screening(_) => true | _ => false }

  /// The screen answers. It may flag a fetched page. It always flags the malicious chat message.
  action screenAnswers(flagsPage: bool): bool = onTurn(turnRun => all {
    isScreening(turnRun.phase),
    not(turnRun.aborted),
    firstAnswering(models) >= 0,
    move(screenLands(workflow.store, turnRun, true, flagsPage, workflow.isolate.rerun, models)),
  })

  /// The screen call fails, and the text it read stays unchecked.
  action screenFails: bool = onTurn(turnRun => all {
    isScreening(turnRun.phase),
    turnRun.aborted or firstAnswering(models) < 0,
    move(screenLands(workflow.store, turnRun, false, false, workflow.isolate.rerun, models)),
  })

  /// The summarization answers. One recap takes the place of every row before the turn.
  action summarizationAnswers: bool = onTurn(turnRun => all {
    turnRun.phase == Compacting,
    not(turnRun.aborted),
    val store = workflow.store
    val lastOlder = turnRun.olderRows[turnRun.olderRows.length() - 1].id
    val compacted = { ...store,
      transcript: [{ id: lastOlder, entry: Recap }].concat(store.transcript.select(row => row.id > lastOlder)),
    }
    move(callModel(compacted, turnRun, workflow.isolate.rerun, models)),
  })

  /// The summarization fails, and the transcript stays whole.
  action summarizationFails: bool = onTurn(turnRun => all {
    turnRun.phase == Compacting,
    move(callModel(workflow.store, turnRun, workflow.isolate.rerun, models)),
  })

  /// The model answers. `overLimit` when the request it read was over the context limit.
  action modelAnswers(answer: ModelAnswer, overLimit: bool): bool = onTurn(turnRun => all {
    turnRun.phase == AwaitingModel,
    not(turnRun.aborted),
    move(modelAnswered(workflow.store, turnRun, answer, overLimit, workflow.isolate.rerun, models)),
  })

  /// The model call throws: the model failed, or the deadline aborted it.
  action modelThrows: bool = onTurn(turnRun => all {
    turnRun.phase == AwaitingModel,
    move(modelThrew(workflow.store, turnRun, workflow.isolate.rerun, models)),
  })

  pure def isPostingClosing(phase: Phase): bool = match phase { | PostingClosing(_) => true | _ => false }

  pure def isConcluding(phase: Phase): bool = match phase { | Concluding(_) => true | _ => false }

  pure def closingPostLanded(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    match turnRun.phase {
      | PostingClosing(targets) =>
          val record = { ...recordPost(turnRun.record, ClosingText, targets), closingTextsPosted: turnRun.record.closingTextsPosted + 1 }
          attemptEnds(landPost(store, ClosingText, targets, false), { ...turnRun, record: record }, Replied, rerun, said)
      | _ => withTurnKeepingRerun(store, turnRun, rerun)
    }

  pure def conclusionLanded(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    match turnRun.phase {
      | Concluding(conclusion) => match conclusion {
          | Releases => endTurn({ ...store, chat: Active }, turnRun, rerun, said)
          | PostsStuckText(targets) =>
              endTurn(landPost(store, StuckText, targets, false), { ...turnRun, record: recordPost(turnRun.record, StuckText, targets) }, rerun, said)
          | PostsTimeoutText(targets) =>
              endTurn(landPost(store, TimeoutText, targets, false), { ...turnRun, record: recordPost(turnRun.record, TimeoutText, targets) }, rerun, said)
        }
      | _ => withTurnKeepingRerun(store, turnRun, rerun)
    }

  /// The closing text lands on its targets, and the attempt ends with the reply.
  action closingPostLands: bool = onTurn(turnRun => all {
    isPostingClosing(turnRun.phase),
    move(closingPostLanded(workflow.store, turnRun, workflow.isolate.rerun, models)),
  })

  /// The post or release that concludes the turn lands, and the turn ends.
  action conclusionLands: bool = onTurn(turnRun => all {
    isConcluding(turnRun.phase),
    move(conclusionLanded(workflow.store, turnRun, workflow.isolate.rerun, models)),
  })

  /// The turn timeout passes while the model is slow to answer. Every other call of a turn ends
  /// within its own deadline, which is far below the turn timeout.
  action timeoutPasses: bool = onTurn(turnRun => all {
    turnRun.phase == AwaitingModel,
    not(turnRun.pastTimeout),
    move(withTurnKeepingRerun(workflow.store, { ...turnRun, pastTimeout: true, record: { ...turnRun.record, modelHung: true } }, workflow.isolate.rerun)),
  })

  pure def deadlineRuns(phase: Phase): bool = match phase { | Concluding(_) => false | _ => true }

  /// The in-process deadline aborts the turn's signal. Every call that takes it fails from now on.
  action deadlineFires: bool = onTurn(turnRun => all {
    turnRun.pastTimeout,
    not(turnRun.aborted),
    deadlineRuns(turnRun.phase),
    move(withTurnKeepingRerun(workflow.store, { ...turnRun, aborted: true }, workflow.isolate.rerun)),
  })

  /// The watchdog alarm of the running turn fires after the timeout. It clears the turn, deletes
  /// the taken rows and posts the timeout text. The turn itself keeps running.
  action watchdogFires: bool = onTurn(turnRun => all {
    turnRun.pastTimeout,
    workflow.store.watchdog == ArmedFor(turnRun.stamp),
    workflow.store.stamp == Stamped(turnRun.stamp),
    val store = workflow.store
    val nobody = answeringTargets(false, Set())
    val cleared = { ...store,
      stamp: Unstamped,
      watchdog: NoAlarm,
      headsUp: NoAlarm,
      firstRow: NoFirstRow,
      inbox: store.inbox.select(row => not(row.taken)),
    }
    move(withTurnKeepingRerun(
      landPost(cleared, TimeoutText, nobody, false),
      { ...turnRun, record: { ...recordPost(turnRun.record, TimeoutText, nobody), timedOut: true } },
      workflow.isolate.rerun,
    )),
  })

  /// The heads-up alarm of the running turn fires. Its chat threads hear that it still runs.
  action headsUpFires: bool = onTurn(turnRun => all {
    workflow.store.headsUp == ArmedFor(turnRun.stamp),
    workflow.store.stamp == Stamped(turnRun.stamp),
    val store = { ...workflow.store, headsUp: NoAlarm }
    val told = if (HAS_CHAT_THREAD) landPost(store, HeadsUpText, CHAT_THREADS, true) else store
    val record = if (HAS_CHAT_THREAD) recordPost(turnRun.record, HeadsUpText, CHAT_THREADS) else turnRun.record
    move(withTurnKeepingRerun(told, { ...turnRun, record: record }, workflow.isolate.rerun)),
  })

  /// A deploy resets the Durable Object. The isolate and its turn are gone, with every call it
  /// had out. The new instance resumes a turn the store still holds as running.
  action durableObjectRestarts: bool = all {
    workflow.store.restarts < MAX_RESTARTS,
    move(restarted(workflow.store, workflow.isolate.turn, models)),
  }

  action step: bool = {
    nondet origin = ORIGINS.oneOf()
    nondet owed = Set(OwedAnswer, OwedBoard).oneOf()
    nondet flagsPage = Set(true, false).oneOf()
    nondet answer = MODEL_ANSWERS.oneOf()
    nondet overLimit = Set(true, false).oneOf()
    any {
      personWrites(origin),
      workflowEventArrives,
      readAnswers(owed),
      readFails,
      screenAnswers(flagsPage),
      screenFails,
      summarizationAnswers,
      summarizationFails,
      modelAnswers(answer, overLimit),
      modelThrows,
      closingPostLands,
      conclusionLands,
      timeoutPasses,
      deadlineFires,
      watchdogFires,
      headsUpFires,
      durableObjectRestarts,
    }
  }

  // Invariants over the turn that ended in the last step, mirrored from the agent turn
  // invariants of the property test under the same names.

  pure def holdsForTheEndedTurn(turnEnd: TurnEnd, rule: TurnRecord => bool): bool =
    match turnEnd { | TurnEnded(ended) => rule(ended.record) | NoTurnEnd => true }

  pure def isAnswerPost(post: Post): bool =
    not(Set(HeadsUpText, LostPlaceText, StuckText, TimeoutText).contains(post.text))

  pure def answeringPosts(record: TurnRecord): List[Post] = record.posts.select(post => answersInAStep(post.text))

  /// Closing text is posted only as the answer to a person who wrote, never after the board
  /// change that was the reply, and never twice.
  val closingTextAnswersOnlyAPersonWhoWrote: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.closingTextsPosted == 0 or and {
      record.owed != NotOwed,
      not(record.owed == OwedBoard and record.boardChanged),
      record.closingTextsPosted <= 1,
    })

  /// Every inbox row a turn took is in the transcript once after the turn, and no longer waits.
  val everyInboxRowReachesTheTranscriptOnce: bool = match lastTurnEnd {
    | TurnEnded(ended) => ended.record.inboxRows.forall(id => and {
        ended.transcript.select(row => match row.entry { | TakenRows(ids) => ids.contains(id) | _ => false }).length() == 1,
        not(ended.waiting.contains(id)),
      })
    | NoTurnEnd => true
  }

  /// Compaction changes only rows from before the turn: they stay as they were, or one recap
  /// replaced all of them.
  val compactionReplacesOnlyEarlierRows: bool = match lastTurnEnd {
    | TurnEnded(ended) =>
        val before = ended.record.rowsBefore
        val lastEarlier = if (before.length() == 0) 0 else before[before.length() - 1].id
        val earlier = ended.transcript.select(row => row.id <= lastEarlier)
        earlier == before or (earlier.length() == 1 and earlier[0].entry == Recap)
    | NoTurnEnd => true
  }

  pure def isToolCall(entry: Entry): bool = match entry { | ToolCallRow(_) => true | _ => false }

  pure def isToolResult(entry: Entry): bool = match entry { | ToolResultRow(_) => true | _ => false }

  /// Every tool call in the transcript has its result right after it.
  val everyToolCallKeepsItsResult: bool = match lastTurnEnd {
    | TurnEnded(ended) => ended.transcript.indices().forall(index =>
        isToolCall(ended.transcript[index].entry) implies
          (index + 1 < ended.transcript.length() and isToolResult(ended.transcript[index + 1].entry)))
    | NoTurnEnd => true
  }

  /// A turn on a person's message leaves them a post or the thumbs-up, or it ran the model once
  /// more after it was told the person got nothing.
  val aPersonsTurnNeverEndsUnanswered: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.owed == NotOwed or record.askedAgain or answeringPosts(record).length() > 0
      or record.steps.select(step => step.answered).length() > 0)

  /// In a person's turn, a step that runs any tool but a first reply follows a step that left
  /// them a post or the thumbs-up.
  val aPersonHearsBackBeforeAnyWork: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.owed == NotOwed or record.steps.indices().forall(index =>
      record.steps[index].ran.exclude(FIRST_REPLY_TOOLS).size() > 0 implies
        record.steps.indices().exists(earlier => earlier < index and record.steps[earlier].answered)))

  pure def holdsText(entry: Entry, pages: Set[int], messages: Set[int]): bool = match entry {
    | ToolResultRow(output) => match output {
        | PageText(page) => pages.contains(page)
        | ChannelRead(read) => read.intersect(messages).size() > 0
        | _ => false
      }
    | _ => false
  }

  /// A page or chat message the screen did not admit is in no row of the transcript.
  val quarantinedTextNeverEntersTheTranscript: bool = match lastTurnEnd {
    | TurnEnded(ended) =>
        val messages = ended.record.messagesRead.exclude(ended.record.admittedMessages)
        not(anyOf(ended.transcript, row => holdsText(row.entry, ended.record.quarantinedPages, messages)))
    | NoTurnEnd => true
  }

  /// After a turn, the chat thread is out of its working status, unless a chat message that
  /// waits for the next turn put it back in.
  val theWorkingStatusNeverOutlivesItsTurn: bool = match lastTurnEnd {
    | TurnEnded(ended) => ended.chat != Processing or ended.chatMessageWaits
    | NoTurnEnd => true
  }

  /// A person's turn that the deadline ended posted the timeout text.
  val aWaitingPersonHearsBackByTheTimeout: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    (record.owed != NotOwed and record.timedOut) implies record.posts.select(post => post.text == TimeoutText).length() > 0)

  /// A turn that resumes a lost turn a person waited on posts the restart notice in chat, and
  /// leaves them an answer, a board change, or a second model pass.
  val aResumedTurnAnswersWhatItsLostTurnOwed: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.lostTurnOwed implies and {
      HAS_CHAT_THREAD implies record.posts.select(post => post.text == LostPlaceText).length() > 0,
      answeringPosts(record).length() > 0 or record.boardChanged or record.askedAgain,
    })

  /// A person's turn times out only when the model was slow to answer.
  val aPersonGetsTheAnswerDuringADecisionsOutage: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    (record.owed != NotOwed and not(record.modelHung)) implies not(record.timedOut))

  /// While a configured decisions model answers, every decisions call of a turn that did not
  /// time out gets the answer of the first model that does.
  val aDecisionsCallFallsBackOnlyAfterEveryModelFailed: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    (firstAnswering(models) >= 0 and not(record.timedOut)) implies and {
      record.decisionsEvents.select(event => event == DecisionsAsked).length() == record.answeredBy.length(),
      record.answeredBy.foldl(true, (holds, model) => holds and model == firstAnswering(models)),
    })

  /// After a decisions call of a turn fails, no later call of the turn asks the decisions model.
  val laterDecisionsCallsFallBackOnceOneFails: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.decisionsEvents.indices().forall(failed =>
      record.decisionsEvents[failed] == DecisionsFailed implies
        record.decisionsEvents.indices().forall(later =>
          later > failed implies record.decisionsEvents[later] != DecisionsAsked)))

  /// Every chat message the screen admitted is in its read.
  val aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.reads.foldl(true, (holds, read) => holds and read.admitted.subseteq(read.result)))

  pure def sessionsOf(targets: Set[Target]): Set[Origin] =
    targets.fold(Set(), (sessions, target) => match target {
      | ToSession(origin) => sessions.union(Set(origin))
      | ToChatThread => sessions
    })

  /// With a chat thread, a turn's posts reach no session, and its answers reach the thread.
  /// Without one, a session gets a post only when a person wrote there, or as the starting
  /// session of a question, and every answer reaches every session a person wrote from.
  val sessionMessageWithoutAnAuthorIsAnswered: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.posts.foldl(true, (holds, post) => holds and {
      val sessions = sessionsOf(post.targets)
      if (HAS_CHAT_THREAD) and {
        sessions.size() == 0,
        isAnswerPost(post) implies post.targets.contains(ToChatThread),
      }
      else and {
        sessions.forall(session => post.answering.contains(session)
          or (post.text == QuestionText and STARTED_FROM_A_SESSION and session == StartingSession)),
        isAnswerPost(post) implies post.answering.subseteq(sessions),
      }
    }))

  // Proposed invariants. They are not in the property test yet.

  /// Every row that waits in the inbox has a turn coming: the turn that runs takes it when the
  /// coalescer runs once more.
  val aWaitingInboxRowHasATurnComing: bool =
    waitingRows(workflow.store).length() > 0 implies
      (workflow.isolate.turn != NoTurn and workflow.isolate.rerun)

  /// The store holds a turn as running only while that turn runs. One turn runs at a time.
  val theTurnStampBelongsToTheRunningTurn: bool = match workflow.store.stamp {
    | Stamped(stamp) => match workflow.isolate.turn {
        | Running(turnRun) => turnRun.stamp == stamp
        | NoTurn => false
      }
    | Unstamped => true
  }

  /// Every invariant above, for one check of all of them.
  val invariants: bool = and {
    closingTextAnswersOnlyAPersonWhoWrote,
    everyInboxRowReachesTheTranscriptOnce,
    compactionReplacesOnlyEarlierRows,
    everyToolCallKeepsItsResult,
    aPersonsTurnNeverEndsUnanswered,
    aPersonHearsBackBeforeAnyWork,
    quarantinedTextNeverEntersTheTranscript,
    theWorkingStatusNeverOutlivesItsTurn,
    aWaitingPersonHearsBackByTheTimeout,
    aResumedTurnAnswersWhatItsLostTurnOwed,
    aPersonGetsTheAnswerDuringADecisionsOutage,
    aDecisionsCallFallsBackOnlyAfterEveryModelFailed,
    laterDecisionsCallsFallBackOnceOneFails,
    aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead,
    sessionMessageWithoutAnAuthorIsAnswered,
    aWaitingInboxRowHasATurnComing,
    theTurnStampBelongsToTheRunningTurn,
  }

  // Witnesses: states where the behavior an invariant guards happens.

  pure def endedTurnWhere(turnEnd: TurnEnd, rule: TurnRecord => bool): bool =
    match turnEnd { | TurnEnded(ended) => rule(ended.record) | NoTurnEnd => false }

  /// A turn posted closing text.
  val aTurnPostsClosingText: bool = endedTurnWhere(lastTurnEnd, record => record.closingTextsPosted > 0)

  /// A person's turn ended with the timeout.
  val aPersonsTurnTimesOut: bool = endedTurnWhere(lastTurnEnd, record => record.owed != NotOwed and record.timedOut)

  /// A recap replaced the rows before a turn.
  val aTurnIsCompacted: bool = anyOf(workflow.store.transcript, row => row.entry == Recap)

  /// A tool call is in the transcript.
  val aToolCallIsInTheTranscript: bool = anyOf(workflow.store.transcript, row => isToolCall(row.entry))

  /// A person's turn ran the model once more after it left them nothing.
  val aPersonsTurnRunsTheModelAgain: bool = endedTurnWhere(lastTurnEnd, record => record.owed != NotOwed and record.askedAgain)

  /// A person's turn ran work after it replied.
  val aPersonHearsBackThenWorkRuns: bool = endedTurnWhere(lastTurnEnd, record =>
    record.owed != NotOwed and anyOf(record.steps, step => step.ran.exclude(FIRST_REPLY_TOOLS).size() > 0))

  /// The screen withheld a page from a turn.
  val aPageIsWithheld: bool = endedTurnWhere(lastTurnEnd, record => record.quarantinedPages.size() > 0)

  /// The screen admitted a page into the transcript.
  val aPageIsAdmitted: bool = anyOf(workflow.store.transcript, row => match row.entry {
    | ToolResultRow(output) => match output { | PageText(_) => true | _ => false }
    | _ => false
  })

  /// A turn read the chat history.
  val aTurnReadsTheChat: bool = endedTurnWhere(lastTurnEnd, record => record.reads.length() > 0)

  /// A turn ended with the chat thread out of its working status after it showed working.
  val aWorkingTurnEnds: bool = match lastTurnEnd {
    | TurnEnded(ended) => ended.record.steps.length() > 1 and ended.chat == Active
    | NoTurnEnd => false
  }

  /// The watchdog fired on a turn that kept running.
  val theWatchdogFiresOnARunningTurn: bool = match workflow.isolate.turn {
    | Running(turnRun) => turnRun.pastTimeout and workflow.store.stamp == Unstamped and turnRun.record.timedOut
    | NoTurn => false
  }

  /// A resumed turn ended after the turn a person waited on was lost.
  val aResumedTurnEnds: bool = endedTurnWhere(lastTurnEnd, record => record.lostTurnOwed)

  /// A person's turn failed into the stuck text.
  val aTurnPostsTheStuckText: bool = endedTurnWhere(lastTurnEnd, record => anyOf(record.posts, post => post.text == StuckText))

  /// A decisions call failed and a later one fell back without asking.
  val aDecisionsCallFallsBack: bool = endedTurnWhere(lastTurnEnd, record =>
    record.decisionsEvents.select(event => event == DecisionsFailed).length() > 0 and record.reads.length() + record.quarantinedPages.size() > 0)

  /// A turn's answer reached a session a person wrote from.
  val anAnswerReachesASession: bool = endedTurnWhere(lastTurnEnd, record =>
    anyOf(record.posts, post => isAnswerPost(post) and sessionsOf(post.targets).size() > 0))

  /// A row arrived while a turn ran.
  val aRowWaitsForTheNextTurn: bool = workflow.isolate.rerun

  /// The heads-up reached a chat thread.
  val theHeadsUpPosts: bool = anyOf(workflow.store.posts, post => post.text == HeadsUpText)
}
