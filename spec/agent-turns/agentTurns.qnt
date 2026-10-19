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
    | HeldCommentsNote

  type Row = { id: int, entry: Entry }

  /// The start time of the turn the store holds as running, by number.
  type StartTime = NotRunning | StartedAt(int)

  /// A watchdog or heads-up alarm, with the start time of the turn it was armed for.
  type Alarm = NoAlarm | ArmedFor(int)

  /// The first transcript row of the running turn, which compaction keeps.
  type FirstRow = NoFirstRow | FirstRowIs(int)

  /// The session status of the chat thread as the notifier last set it.
  type ChatStatus = NoStatus | Processing | Active | Closed

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
    startedAt: StartTime,
    nextStart: int,
    watchdog: Alarm,
    headsUp: Alarm,
    firstRow: FirstRow,
    // A person's running turn, or the lost turn it resumes, started or prompted a task in chat.
    boardChanged: bool,
    // The `runAgent` alarms each new instance arms for rows that wait. A restart does not reuse an armed one.
    runAgentAlarms: int,
    lastInputOverLimit: bool,
    chat: ChatStatus,
    posts: List[Post],
    pagesFetched: int,
    messagesRead: int,
    restarts: int,
    workflowEnded: bool,
  }

  /// What the message of the person who wrote is owed. `NotOwed` when nobody wrote.
  type Owed = NotOwed | OwedAnswer | OwedBoard

  /// How a turn's attempt ended.
  type Outcome = Replied | Silent | Failed | TimedOut

  /// The host call that concludes a turn after its attempt.
  type Conclusion = Releases | PostsStuckText(Set[Target]) | PostsTimeoutText(Set[Target])

  /// The text a screen call reads: a fetched page, the messages of one chat read, or the comments
  /// held on the page of the author a revision request sends them to.
  type Screened = ScreensPage(int) | ScreensChannelRead(Set[int]) | ScreensHeldComments

  /// The call a running turn waits on.
  type Phase =
    | ReadingMessage
    | Compacting
    | AwaitingModel
    | Screening({ screened: Screened, overLimit: bool })
    | PostingClosing(Set[Target])
    | AwaitingRuntimeRequest
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
    callHung: bool,
    sentHeldComments: bool,
    decisionsEvents: List[DecisionsEvent],
    answeredBy: List[int],
    reads: List[ChatRead],
    answering: Set[Origin],
  }

  /// The turn that runs in the isolate, with what its code keeps in memory.
  type TurnRun = {
    startedAt: int,
    phase: Phase,
    aborted: bool,
    pastTimeout: bool,
    olderRows: List[Row],
    reactable: bool,
    decisionsFailed: bool,
    owed: Owed,
    acknowledged: bool,
    firstReplied: bool,
    // Where the people the turn answers wrote from, read as it took its inbox.
    answering: Set[Origin],
    attempt: int,
    pass: int,
    passEndedByTool: bool,
    runtimeRequestOut: bool,
    record: TurnRecord,
  }

  type TurnSlot = NoTurn | Running(TurnRun)

  /// The isolate's memory: the turn that runs, and whether the isolate runs one more turn after it.
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

  /// What the decisions model read in a person's message, beyond what it owes them.
  type MessageRead = { asksForRevision: bool, namesModel: bool }

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
    startedAt: NotRunning,
    nextStart: 1,
    watchdog: NoAlarm,
    headsUp: NoAlarm,
    firstRow: NoFirstRow,
    boardChanged: false,
    runAgentAlarms: 0,
    lastInputOverLimit: false,
    chat: NoStatus,
    posts: [],
    pagesFetched: 0,
    messagesRead: 0,
    restarts: 0,
    workflowEnded: false,
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
    callHung: false,
    sentHeldComments: false,
    decisionsEvents: [],
    answeredBy: [],
    reads: [],
    answering: Set(),
  }

  var workflow: Workflow
  var models: List[ModelSays]
  var lastTurnEnd: TurnEnd
  /// The steps the run took. TLC bounds a run by it.
  var actionsTaken: int

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

  /// `recipientsOf` for a post to the people a turn answers. `asks` for a question, the stuck
  /// text and the timeout text, which the starting session also gets.
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

  /// The chat thread once a turn lets go of it: active, or closed once the workflow finished.
  pure def released(store: Store): ChatStatus = if (store.workflowEnded) Closed else Active

  /// A post lands. A post that does not keep the working status releases the chat thread.
  pure def landPost(store: Store, text: PostText, targets: Set[Target], keepsSession: bool): Store = {
    ...store,
    posts: store.posts.append({ text: text, targets: targets, answering: answeringNow(store) }),
    chat: if (keepsSession) store.chat else released(store),
  }

  pure def withTurn(store: Store, turnRun: TurnRun): Next =
    { workflow: { store: store, isolate: { turn: Running(turnRun), rerun: false } }, turnEnd: NoTurnEnd }

  /// The turn sends a model call. The property test marks a step at every call. The first call
  /// waits until the runtime request lands.
  pure def awaitModel(store: Store, turnRun: TurnRun): Next =
    if (turnRun.runtimeRequestOut) withTurn(store, { ...turnRun, phase: AwaitingRuntimeRequest })
    else withTurn(store, {
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
        startedAt: StartedAt(store.nextStart),
        nextStart: store.nextStart + 1,
        watchdog: ArmedFor(store.nextStart),
        headsUp: if (people.length() > 0) ArmedFor(store.nextStart) else NoAlarm,
        firstRow: FirstRowIs(first),
        boardChanged: store.firstRow != NoFirstRow and store.boardChanged,
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
        callHung: false,
        decisionsEvents: if (people.length() > 0) [DecisionsAsked] else [],
        answeredBy: [],
        answering: answeringNow(armed),
      }
      val turnRun = {
        startedAt: store.nextStart,
        phase: ReadingMessage,
        aborted: false,
        pastTimeout: false,
        olderRows: if (armed.transcript.select(row => row.id == first).length() > 0) armed.transcript.select(row => row.id < first) else [],
        reactable: awaitingThumbsUp(armed).length() > 0,
        decisionsFailed: false,
        owed: NotOwed,
        acknowledged: false,
        firstReplied: false,
        answering: answeringNow(armed),
        attempt: 1,
        pass: 1,
        passEndedByTool: false,
        runtimeRequestOut: false,
        record: record,
      }
      if (people.length() > 0) { store: armed, turn: Running(turnRun) }
      else
        val after = compactThenCallModel(armed, turnRun)
        { store: after.workflow.store, turn: after.workflow.isolate.turn }

  /// After the read, compact when the transcript before the turn is large, then call the model.
  /// A turn the deadline aborted ends its attempt once the runtime request lands, since every
  /// call it starts throws at once.
  pure def afterRead(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    if (turnRun.aborted and not(turnRun.runtimeRequestOut)) attemptEnds(store, turnRun, TimedOut, rerun, said)
    else keepRerun(compactThenCallModel(store, turnRun), rerun)

  /// The turn calls the model. A call that starts after the deadline aborted the turn throws
  /// before it reaches the model, and the attempt ends once the runtime request lands.
  pure def callModel(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    if (turnRun.aborted and not(turnRun.runtimeRequestOut)) attemptEnds(store, turnRun, TimedOut, rerun, said)
    else keepRerun(awaitModel(store, turnRun), rerun)

  /// The turn that ended leaves its record. The isolate runs one more turn when a row arrived while it ran.
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

  /// `boundedAttempt` returns. The turn disarms its watchdog, then concludes when it still owes
  /// the reply. When the watchdog already posted the timeout text, the turn only releases.
  pure def attemptEnds(store: Store, turnRun: TurnRun, outcome: Outcome, rerun: bool, said: List[ModelSays]): Next =
    if (store.startedAt != StartedAt(turnRun.startedAt)) withTurnKeepingRerun(store, { ...turnRun, phase: Concluding(Releases) }, rerun)
    else
      val disarmed = {
        ...store,
        watchdog: NoAlarm,
        headsUp: NoAlarm,
        startedAt: NotRunning,
        firstRow: NoFirstRow,
        inbox: store.inbox.select(row => not(row.taken)),
      }
      val told = answeringTargets(true, turnRun.answering)
      match outcome {
        | Replied => endTurn(disarmed, turnRun, rerun, said)
        | Silent => withTurnKeepingRerun(disarmed, { ...turnRun, phase: Concluding(Releases) }, rerun)
        | Failed => withTurnKeepingRerun(disarmed, { ...turnRun, phase: Concluding(PostsStuckText(told)) }, rerun)
        | TimedOut => withTurnKeepingRerun(
            disarmed,
            { ...turnRun, phase: Concluding(PostsTimeoutText(told)), record: { ...turnRun.record, timedOut: true } },
            rerun,
          )
      }

  pure def withTurnKeepingRerun(store: Store, turnRun: TurnRun, rerun: bool): Next =
    { workflow: { store: store, isolate: { turn: Running(turnRun), rerun: rerun } }, turnEnd: NoTurnEnd }

  /// A model pass ends. `generate` asks the model again once when a person got nothing, and
  /// posts closing text only as the answer to a person who wrote.
  pure def passEnds(store: Store, turnRun: TurnRun, text: bool, rerun: bool, said: List[ModelSays]): Next =
    if (turnRun.aborted) attemptEnds(store, turnRun, TimedOut, rerun, said)
    else if (turnRun.owed != NotOwed and turnRun.pass == 1 and not(text or turnRun.passEndedByTool or store.boardChanged))
      callModel(
        appendRows(store, [UnansweredNote]),
        { ...turnRun, pass: 2, passEndedByTool: false, record: { ...turnRun.record, askedAgain: true } },
        rerun,
        said,
      )
    else if (turnRun.passEndedByTool or not(text)) attemptEnds(store, turnRun, Silent, rerun, said)
    else if (turnRun.owed == NotOwed or (turnRun.owed == OwedBoard and store.boardChanged)) attemptEnds(store, turnRun, Silent, rerun, said)
    else withTurnKeepingRerun(store, { ...turnRun, phase: PostingClosing(answeringTargets(false, turnRun.answering)) }, rerun)

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
    val answering = answeringTargets(false, turnRun.answering)
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
          val asked = answeringTargets(true, turnRun.answering)
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
          val changed = { ...ran, record: { ...ran.record, boardChanged: ran.record.boardChanged or HAS_CHAT_THREAD } }
          val board = { ...store, boardChanged: store.boardChanged or (turnRun.owed != NotOwed and HAS_CHAT_THREAD) }
          stepEnds(board, changed, [ToolCallRow(tool), ToolResultRow(ToolRan)], overLimit, false, rerun, said)
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

  /// A screen call lands, and the step that waited on it ends. Held comments the screen admitted
  /// stay held when the workflow finished and cancelled their author meanwhile, and the agent is
  /// not told.
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
            | ScreensHeldComments =>
                val admitted = answered and not(flagsPage)
                val sent = admitted and not(store.workflowEnded)
                val noted = if (admitted and not(sent)) store else appendRows(store, [HeldCommentsNote])
                afterRead(noted, { ...landed, record: { ...record, sentHeldComments: sent } }, rerun, said)
          }
      | _ => { workflow: { store: store, isolate: { turn: Running(turnRun), rerun: rerun } }, turnEnd: NoTurnEnd }
    }

  /// What a failed read falls back to: an unread message.
  pure val UNREAD: MessageRead = { asksForRevision: false, namesModel: false }

  /// The read of the person's message lands. A failed read owes the person an answer. A message
  /// that names a model starts the runtime request beside the turn. A message that asks for a
  /// revision screens the comments held on the author's page before the model runs, unless the
  /// workflow finished and cancelled the author.
  pure def readLands(store: Store, turnRun: TurnRun, owed: Owed, answered: bool, read: MessageRead, rerun: bool, said: List[ModelSays]): Next =
    val heard = turnRun.record.decisionsEvents.append(if (answered) DecisionsAnswered else DecisionsFailed)
    val requested = if (read.namesModel) heard.append(DecisionsAsked) else heard
    val sendsHeldComments = read.asksForRevision and not(store.workflowEnded)
    val record = { ...turnRun.record,
      owed: if (answered) owed else OwedAnswer,
      decisionsEvents: if (sendsHeldComments) requested.append(DecisionsAsked) else requested,
      answeredBy: if (answered) turnRun.record.answeredBy.append(firstAnswering(said)) else turnRun.record.answeredBy,
    }
    val readTurn = {
      ...turnRun,
      owed: if (answered) owed else OwedAnswer,
      decisionsFailed: not(answered),
      runtimeRequestOut: read.namesModel,
      record: record,
    }
    if (sendsHeldComments) keepRerun(withTurn(store, { ...readTurn, phase: Screening({ screened: ScreensHeldComments, overLimit: false }) }), rerun)
    else afterRead(store, readTurn, rerun, said)

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

  /// The new instance resumes the lost turn: a person who waited hears that it starts again, and
  /// an agent note wakes the turn that resumes.
  pure def resumed(store: Store, forgotten: Store, lost: TurnSlot, said: List[ModelSays]): Next =
    val lostRecord = match lost { | Running(turnRun) => turnRun.record | NoTurn => FRESH_RECORD }
    val noticed = takenPersonRows(store).length() > 0 and HAS_CHAT_THREAD
    val told = if (noticed) landPost(forgotten, LostPlaceText, CHAT_THREADS, true) else forgotten
    val carried = if (noticed) recordPost(lostRecord, LostPlaceText, CHAT_THREADS) else lostRecord
    val woken = { ...told,
      inbox: told.inbox.append({ id: told.nextInboxId, from: FromWorkflow, taken: false, reacted: false }),
      nextInboxId: told.nextInboxId + 1,
    }
    val after = startTurn(woken, ResumedFrom(carried), said)
    { workflow: { store: after.store, isolate: { turn: after.turn, rerun: false } }, turnEnd: NoTurnEnd }

  /// `resumeLostTurn` on the new instance, and the turn its wake starts. With no lost turn, rows
  /// that wait get the `runAgent` alarm. A finished workflow drops its lost turn, releases the
  /// threads, and arms the `runAgent` alarm for rows that wait.
  pure def restarted(store: Store, lost: TurnSlot, said: List[ModelSays]): Next =
    val counted = { ...store, restarts: store.restarts + 1 }
    match store.startedAt {
      | NotRunning =>
          val armed = if (waitingRows(counted).length() > 0) { ...counted, runAgentAlarms: counted.runAgentAlarms + 1 } else counted
          { workflow: { store: armed, isolate: { turn: NoTurn, rerun: false } }, turnEnd: NoTurnEnd }
      | StartedAt(_) =>
          val forgotten = { ...counted, startedAt: NotRunning, watchdog: NoAlarm, headsUp: NoAlarm }
          val dropped = { ...forgotten,
            firstRow: NoFirstRow,
            inbox: forgotten.inbox.select(row => not(row.taken)),
            chat: Closed,
          }
          val woken = if (waitingRows(dropped).length() > 0) { ...dropped, runAgentAlarms: dropped.runAgentAlarms + 1 } else dropped
          if (store.workflowEnded) { workflow: { store: woken, isolate: { turn: NoTurn, rerun: false } }, turnEnd: NoTurnEnd }
          else resumed(store, forgotten, lost, said)
    }

  action move(after: Next): bool = all {
    workflow' = after.workflow,
    models' = models,
    lastTurnEnd' = after.turnEnd,
    actionsTaken' = actionsTaken + 1,
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
    actionsTaken' = 0,
  }

  /// A row lands in the inbox and wakes the agent. The isolate runs the turn now, or once more
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

  /// A person writes. Ingress puts a chat thread in its working status as it acknowledges. A
  /// finished workflow refuses the message.
  action personWrites(origin: Origin): bool = all {
    workflow.store.nextInboxId <= MAX_ARRIVALS,
    not(workflow.store.workflowEnded),
    move(arrive(workflow, Person(origin), models)),
  }

  /// A task event or a note reaches the agent. A finished workflow takes no more events.
  action workflowEventArrives: bool = all {
    workflow.store.nextInboxId <= MAX_ARRIVALS,
    not(workflow.store.workflowEnded),
    move(arrive(workflow, FromWorkflow, models)),
  }

  /// The decisions model reads the person's message.
  action readAnswers(owed: Owed, read: MessageRead): bool = onTurn(turnRun => all {
    turnRun.phase == ReadingMessage,
    not(turnRun.aborted),
    firstAnswering(models) >= 0,
    move(readLands(workflow.store, turnRun, owed, true, read, workflow.isolate.rerun, models)),
  })

  /// The read fails: every configured model failed, or the deadline aborted it.
  action readFails: bool = onTurn(turnRun => all {
    turnRun.phase == ReadingMessage,
    turnRun.aborted or firstAnswering(models) < 0,
    move(readLands(workflow.store, turnRun, OwedAnswer, false, UNREAD, workflow.isolate.rerun, models)),
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

  /// The runtime request lands. The turn goes on with the call it waits on, or calls the model
  /// when it waited only on the runtime request.
  pure def runtimeRequestLands(store: Store, turnRun: TurnRun, answered: bool, rerun: bool, said: List[ModelSays]): Next =
    val record = { ...turnRun.record,
      decisionsEvents: turnRun.record.decisionsEvents.append(if (answered) DecisionsAnswered else DecisionsFailed),
      answeredBy: if (answered) turnRun.record.answeredBy.append(firstAnswering(said)) else turnRun.record.answeredBy,
    }
    val landed = { ...turnRun, runtimeRequestOut: false, decisionsFailed: turnRun.decisionsFailed or not(answered), record: record }
    match turnRun.phase {
      | AwaitingRuntimeRequest => callModel(store, landed, rerun, said)
      | _ => withTurnKeepingRerun(store, landed, rerun)
    }

  /// The decisions model picks the model the person's message names.
  action runtimeRequestAnswers: bool = onTurn(turnRun => all {
    turnRun.runtimeRequestOut,
    not(turnRun.aborted),
    firstAnswering(models) >= 0,
    move(runtimeRequestLands(workflow.store, turnRun, true, workflow.isolate.rerun, models)),
  })

  /// The runtime request fails, and the model the message named stays unresolved.
  action runtimeRequestFails: bool = onTurn(turnRun => all {
    turnRun.runtimeRequestOut,
    turnRun.aborted or firstAnswering(models) < 0,
    move(runtimeRequestLands(workflow.store, turnRun, false, workflow.isolate.rerun, models)),
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
          | Releases => endTurn({ ...store, chat: released(store) }, turnRun, rerun, said)
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

  /// The turn timeout passes while the model is slow to answer or the closing post hangs. Every
  /// other call of a turn, the runtime request and the summarization among them, ends within its
  /// own deadline, which is far below the turn timeout.
  action timeoutPasses: bool = onTurn(turnRun => all {
    turnRun.phase == AwaitingModel or isPostingClosing(turnRun.phase),
    not(turnRun.pastTimeout),
    move(withTurnKeepingRerun(workflow.store, { ...turnRun, pastTimeout: true, record: { ...turnRun.record, callHung: true } }, workflow.isolate.rerun)),
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
  /// the taken rows and posts the timeout text. On a finished workflow where nobody waits, it
  /// only releases the threads. The turn itself keeps running.
  action watchdogFires: bool = onTurn(turnRun => all {
    turnRun.pastTimeout,
    workflow.store.watchdog == ArmedFor(turnRun.startedAt),
    workflow.store.startedAt == StartedAt(turnRun.startedAt),
    val store = workflow.store
    val told = answeringTargets(true, answeringNow(store))
    val cleared = { ...store,
      startedAt: NotRunning,
      watchdog: NoAlarm,
      headsUp: NoAlarm,
      firstRow: NoFirstRow,
      inbox: store.inbox.select(row => not(row.taken)),
    }
    if (store.workflowEnded and answeringNow(store).size() == 0)
      move(withTurnKeepingRerun({ ...cleared, chat: Closed }, { ...turnRun, record: { ...turnRun.record, timedOut: true } }, workflow.isolate.rerun))
    else move(withTurnKeepingRerun(
      landPost(cleared, TimeoutText, told, false),
      { ...turnRun, record: { ...recordPost(turnRun.record, TimeoutText, told), timedOut: true } },
      workflow.isolate.rerun,
    )),
  })

  /// The workflow finishes: its last job completes, or a person stops it. A turn that runs goes on.
  action workflowFinishes: bool = all {
    not(workflow.store.workflowEnded),
    move({ workflow: { ...workflow, store: { ...workflow.store, workflowEnded: true } }, turnEnd: NoTurnEnd }),
  }

  /// The heads-up alarm of the running turn fires. Its chat threads hear that it still runs.
  action headsUpFires: bool = onTurn(turnRun => all {
    workflow.store.headsUp == ArmedFor(turnRun.startedAt),
    workflow.store.startedAt == StartedAt(turnRun.startedAt),
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

  /// The `runAgent` alarm fires. Like `runIfIdle`, it runs a turn only when none runs.
  action runAgentAlarmFires: bool = all {
    workflow.store.runAgentAlarms > 0,
    val store = { ...workflow.store, runAgentAlarms: workflow.store.runAgentAlarms - 1 }
    match workflow.isolate.turn {
      | Running(_) => move({ workflow: { ...workflow, store: store }, turnEnd: NoTurnEnd })
      | NoTurn =>
          val after = startTurn(store, Fresh, models)
          move({ workflow: { store: after.store, isolate: { turn: after.turn, rerun: false } }, turnEnd: NoTurnEnd })
    }
  }

  // Counters that TLC bounds per setup.

  /// The inbox rows that arrived.
  val rowsArrived: int = workflow.store.nextInboxId - 1

  /// The restarts of the Durable Object.
  val restartsTaken: int = workflow.store.restarts

  /// The transcript rows written. Compaction replaces rows but does not lower it.
  val rowsWritten: int = workflow.store.nextRowId - 1

  /// The workflow finished, every restart happened, no turn runs and no `runAgent` alarm is
  /// armed. These negate the guards of every other step, so each of them is blocked here.
  val theTurnsEnd: bool = and {
    workflow.store.workflowEnded,
    workflow.store.restarts >= MAX_RESTARTS,
    workflow.isolate.turn == NoTurn,
    workflow.store.runAgentAlarms == 0,
  }

  /// The model stays in its end state, so TLC does not report the end as a deadlock.
  action finished: bool = all {
    theTurnsEnd,
    workflow' = workflow,
    models' = models,
    lastTurnEnd' = lastTurnEnd,
    actionsTaken' = actionsTaken,
  }

  /// Each step picks only the values its action reads, so TLC does not generate one copy of a
  /// successor for every value of a pick it ignores.
  action step: bool = any {
    {
      nondet origin = ORIGINS.oneOf()
      personWrites(origin)
    },
    workflowEventArrives,
    {
      nondet owed = Set(OwedAnswer, OwedBoard).oneOf()
      nondet asksForRevision = Set(true, false).oneOf()
      nondet namesModel = Set(true, false).oneOf()
      readAnswers(owed, { asksForRevision: asksForRevision, namesModel: namesModel })
    },
    readFails,
    runtimeRequestAnswers,
    runtimeRequestFails,
    {
      nondet flagsPage = Set(true, false).oneOf()
      screenAnswers(flagsPage)
    },
    screenFails,
    summarizationAnswers,
    summarizationFails,
    {
      nondet answer = MODEL_ANSWERS.oneOf()
      nondet overLimit = Set(true, false).oneOf()
      modelAnswers(answer, overLimit)
    },
    modelThrows,
    closingPostLands,
    conclusionLands,
    timeoutPasses,
    deadlineFires,
    watchdogFires,
    headsUpFires,
    durableObjectRestarts,
    runAgentAlarmFires,
    workflowFinishes,
    finished,
  }

  // Invariants over the turn that ended in the last step, mirrored from the agent turn
  // invariants of the property test under the same names.

  pure def holdsForTheEndedTurn(turnEnd: TurnEnd, rule: TurnRecord => bool): bool =
    match turnEnd { | TurnEnded(ended) => rule(ended.record) | NoTurnEnd => true }

  /// True for the stuck text and the timeout text of a turn that ended without its reply.
  pure def isTurnFailedPost(post: Post): bool = Set(StuckText, TimeoutText).contains(post.text)

  /// True for a post the starting session gets as well as the sessions of the people it answers.
  pure def asksTheStartingSession(post: Post): bool = post.text == QuestionText or isTurnFailedPost(post)

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
    | TurnEnded(ended) =>
        val read = ended.transcript.foldl({ kept: true, callOpen: false }, (seen, row) => {
          kept: seen.kept and (seen.callOpen implies isToolResult(row.entry)),
          callOpen: isToolCall(row.entry),
        })
        read.kept and not(read.callOpen)
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
    record.owed == NotOwed or record.steps.foldl({ heard: true, answered: false }, (seen, step) => {
      heard: seen.heard and (step.ran.exclude(FIRST_REPLY_TOOLS).size() > 0 implies seen.answered),
      answered: seen.answered or step.answered,
    }).heard)

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

  /// A person's turn times out only when a call other than a decisions call hung.
  val aPersonGetsTheAnswerDuringADecisionsOutage: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    (record.owed != NotOwed and not(record.callHung)) implies not(record.timedOut))

  /// While a configured decisions model answers, every decisions call of a turn that did not
  /// time out gets the answer of the first model that does.
  val aDecisionsCallFallsBackOnlyAfterEveryModelFailed: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    (firstAnswering(models) >= 0 and not(record.timedOut)) implies and {
      record.decisionsEvents.select(event => event == DecisionsAsked).length() == record.answeredBy.length(),
      record.answeredBy.foldl(true, (holds, model) => holds and model == firstAnswering(models)),
    })

  /// After a decisions call of a turn fails, no call of the turn that starts later asks the
  /// decisions model. A call that started before the failure may still get its answer.
  val laterDecisionsCallsFallBackOnceOneFails: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.decisionsEvents.foldl({ fellBack: true, failed: false }, (seen, event) => {
      fellBack: seen.fellBack and not(seen.failed and event == DecisionsAsked),
      failed: seen.failed or event == DecisionsFailed,
    }).fellBack)

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
  /// session of a question or a failed turn. Every answer and every failed turn's text reaches
  /// every session a person wrote from, and the failed turn's text reaches the starting session.
  val sessionMessageWithoutAnAuthorIsAnswered: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.posts.foldl(true, (holds, post) => holds and {
      val sessions = sessionsOf(post.targets)
      if (HAS_CHAT_THREAD) and {
        sessions.size() == 0,
        isAnswerPost(post) implies post.targets.contains(ToChatThread),
      }
      else and {
        sessions.forall(session => post.answering.contains(session)
          or (asksTheStartingSession(post) and STARTED_FROM_A_SESSION and session == StartingSession)),
        isAnswerPost(post) implies post.answering.subseteq(sessions),
        isTurnFailedPost(post) implies post.answering.subseteq(sessions),
        (isTurnFailedPost(post) and STARTED_FROM_A_SESSION) implies sessions.contains(StartingSession),
      }
    }))

  /// Every row that waits in the inbox has a turn coming: the isolate runs one more turn after
  /// the turn that runs, or the `runAgent` alarm runs one.
  val aWaitingInboxRowHasATurnComing: bool =
    waitingRows(workflow.store).length() > 0 implies
      ((workflow.isolate.turn != NoTurn and workflow.isolate.rerun) or workflow.store.runAgentAlarms > 0)

  /// The store holds a turn as running only while that turn runs. One turn runs at a time.
  val oneTurnRunsAtATime: bool = match workflow.store.startedAt {
    | StartedAt(start) => match workflow.isolate.turn {
        | Running(turnRun) => turnRun.startedAt == start
        | NoTurn => false
      }
    | NotRunning => true
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
    oneTurnRunsAtATime,
  }

  // Witnesses: states where the behavior an invariant guards happens.

  pure def endedTurnWhere(turnEnd: TurnEnd, rule: TurnRecord => bool): bool =
    match turnEnd { | TurnEnded(ended) => rule(ended.record) | NoTurnEnd => false }

  /// Witness for `closingTextAnswersOnlyAPersonWhoWrote`: a turn posted closing text.
  val aTurnPostsClosingText: bool = endedTurnWhere(lastTurnEnd, record => record.closingTextsPosted > 0)

  /// Witness for `aWaitingPersonHearsBackByTheTimeout`: a person's turn ended with the timeout.
  val aPersonsTurnTimesOut: bool = endedTurnWhere(lastTurnEnd, record => record.owed != NotOwed and record.timedOut)

  /// Witness for `compactionReplacesOnlyEarlierRows`: a recap replaced the rows before a turn.
  val aTurnIsCompacted: bool = anyOf(workflow.store.transcript, row => row.entry == Recap)

  /// Witness for `everyToolCallKeepsItsResult`: a tool call is in the transcript.
  val aToolCallIsInTheTranscript: bool = anyOf(workflow.store.transcript, row => isToolCall(row.entry))

  /// Witness for `aPersonsTurnNeverEndsUnanswered`: a person's turn ran the model once more after it
  /// left them nothing.
  val aPersonsTurnRunsTheModelAgain: bool = endedTurnWhere(lastTurnEnd, record => record.owed != NotOwed and record.askedAgain)

  /// Witness for `aPersonHearsBackBeforeAnyWork`: a person's turn ran work after it replied.
  val aPersonHearsBackThenWorkRuns: bool = endedTurnWhere(lastTurnEnd, record =>
    record.owed != NotOwed and anyOf(record.steps, step => step.ran.exclude(FIRST_REPLY_TOOLS).size() > 0))

  /// Witness for `quarantinedTextNeverEntersTheTranscript`: the screen withheld a page from a turn.
  val aPageIsWithheld: bool = endedTurnWhere(lastTurnEnd, record => record.quarantinedPages.size() > 0)

  /// Witness for `quarantinedTextNeverEntersTheTranscript`: the screen admitted a page into the
  /// transcript.
  val aPageIsAdmitted: bool = anyOf(workflow.store.transcript, row => match row.entry {
    | ToolResultRow(output) => match output { | PageText(_) => true | _ => false }
    | _ => false
  })

  /// Witness for `aFlaggedMessageNeverRemovesAnotherFromAChatHistoryRead`: a turn read the chat
  /// history.
  val aTurnReadsTheChat: bool = endedTurnWhere(lastTurnEnd, record => record.reads.length() > 0)

  /// Witness for `theWorkingStatusNeverOutlivesItsTurn`: a turn ended with the chat thread out of its
  /// working status after it showed working.
  val aWorkingTurnEnds: bool = match lastTurnEnd {
    | TurnEnded(ended) => ended.record.steps.length() > 1 and ended.chat == Active
    | NoTurnEnd => false
  }

  /// Witness for `oneTurnRunsAtATime`: the watchdog fired on a turn that kept running.
  val theWatchdogFiresOnARunningTurn: bool = match workflow.isolate.turn {
    | Running(turnRun) => turnRun.pastTimeout and workflow.store.startedAt == NotRunning and turnRun.record.timedOut
    | NoTurn => false
  }

  /// Witness for `aResumedTurnAnswersWhatItsLostTurnOwed`: a resumed turn ended after the turn a
  /// person waited on was lost.
  val aResumedTurnEnds: bool = endedTurnWhere(lastTurnEnd, record => record.lostTurnOwed)

  /// Witness for `aPersonsTurnNeverEndsUnanswered`: a person's turn failed into the stuck text.
  val aTurnPostsTheStuckText: bool = endedTurnWhere(lastTurnEnd, record => anyOf(record.posts, post => post.text == StuckText))

  /// Witness for `aPersonGetsTheAnswerDuringADecisionsOutage`,
  /// `aDecisionsCallFallsBackOnlyAfterEveryModelFailed` and
  /// `laterDecisionsCallsFallBackOnceOneFails`: a decisions call failed and a later one fell back
  /// without asking.
  val aDecisionsCallFallsBack: bool = endedTurnWhere(lastTurnEnd, record =>
    record.decisionsEvents.select(event => event == DecisionsFailed).length() > 0 and record.reads.length() + record.quarantinedPages.size() > 0)

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: a turn's answer reached a session a
  /// person wrote from.
  val anAnswerReachesASession: bool = endedTurnWhere(lastTurnEnd, record =>
    anyOf(record.posts, post => isAnswerPost(post) and sessionsOf(post.targets).size() > 0))

  /// Witness for `everyInboxRowReachesTheTranscriptOnce`, `aWaitingInboxRowHasATurnComing` and
  /// `oneTurnRunsAtATime`: a row arrived while a turn ran.
  val aRowWaitsForTheNextTurn: bool = workflow.isolate.rerun

  /// Witness for `theWorkingStatusNeverOutlivesItsTurn`: the heads-up reached a chat thread.
  val theHeadsUpPosts: bool = anyOf(workflow.store.posts, post => post.text == HeadsUpText)

  /// Witness for `aWaitingInboxRowHasATurnComing`: a row waits for the `runAgent` alarm after a
  /// restart.
  val aRowWaitsForTheRunAgentAlarm: bool =
    workflow.store.runAgentAlarms > 0 and waitingRows(workflow.store).length() > 0

  /// A person's revision request sent the held comments to the author.
  val aRevisionSendsTheHeldComments: bool = endedTurnWhere(lastTurnEnd, record => record.sentHeldComments)

  /// Witness for `laterDecisionsCallsFallBackOnceOneFails`: the runtime request is out while the turn
  /// waits on a screen call.
  val twoDecisionsCallsAreOut: bool = match workflow.isolate.turn {
    | Running(turnRun) => turnRun.runtimeRequestOut and isScreening(turnRun.phase)
    | NoTurn => false
  }

  /// Witness for `aWaitingPersonHearsBackByTheTimeout`: the watchdog fired while the closing text was
  /// still posting.
  val theClosingPostOutlivesTheTimeout: bool = match workflow.isolate.turn {
    | Running(turnRun) => isPostingClosing(turnRun.phase) and turnRun.pastTimeout and workflow.store.startedAt == NotRunning
    | NoTurn => false
  }

  /// Witness for `theWorkingStatusNeverOutlivesItsTurn`: the watchdog of a finished workflow released
  /// the threads of a turn that kept running, without the timeout text.
  val theWatchdogReleasesAFinishedWorkflow: bool = match workflow.isolate.turn {
    | Running(turnRun) => and {
        turnRun.record.timedOut,
        workflow.store.workflowEnded,
        not(anyOf(turnRun.record.posts, post => post.text == TimeoutText)),
      }
    | NoTurn => false
  }

  /// Witness for `theWorkingStatusNeverOutlivesItsTurn`: a turn ended on a finished workflow and
  /// closed the chat thread.
  val aTurnEndsOnAFinishedWorkflow: bool = match lastTurnEnd {
    | TurnEnded(ended) => ended.chat == Closed
    | NoTurnEnd => false
  }
}
