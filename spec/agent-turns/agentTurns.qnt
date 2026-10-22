/// The orchestrator agent's turns in one workflow: the inbox each turn takes, messages that arrive
/// while a turn runs, firings whose payload the screen reads before their row arrives, one turn at
/// a time, the turn deadline and its watchdog, compaction, restarts of the Durable Object, and
/// where each post goes. Prompt text and model output are left out.
/// Each action is one stretch of code between two awaits. A model call, a decisions call, a
/// summarization call, the closing post and the post that concludes a turn each take two
/// actions: one sends the call, a later one lands it. Tool posts, reactions, alarms and the
/// working status land in the stretch that sends them.
module agentTurnsTypes {
  /// Which reply targets the workflow has: a chat thread, tracker sessions, or both.
  type Surface = ChatOnly | TrackerOnly | ChatAndSession

  /// Where a person wrote from.
  type Origin = ChatThread | StartingSession | JobSession

  /// A firing's payload, by number, and whether the screen admitted it into the firing's row.
  type FiredPayload = { payload: int, admitted: bool }

  /// Who an inbox row is from: a person, the workflow itself, such as a task event or a note, or a
  /// firing. A firing's row wakes the agent as a message, but no person wrote it, so it has no
  /// words to read and no reply target.
  type RowFrom = Person(Origin) | FromWorkflow | FromFiring(FiredPayload)

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

  /// The user row that joins the inbox rows a turn took, and the firing payloads whose text it holds.
  type TakenEntry = { rows: Set[int], payloads: Set[int] }

  /// One transcript row. `TakenRows` is the user row that joins the inbox rows a turn took.
  type Entry =
    | TakenRows(TakenEntry)
    | Recap
    | ToolCallRow(Tool)
    | ToolResultRow(ToolOutput)
    | TextRow
    | UnansweredNote
    | HeldCommentsNote

  type Row = { id: int, entry: Entry }

  /// A watchdog or heads-up alarm, with the start time of the turn it was armed for.
  type Alarm = NoAlarm | ArmedFor(int)

  /// The agent turn record. A running turn holds its start time, its alarms, its first transcript
  /// row, which compaction keeps, and whether a person's turn started or prompted a task in chat.
  /// A restart turns it lost, and the lost turn keeps its first row and board change for its resume.
  type StoredTurn =
    | NoTurn
    | TurnRunning({ startedAt: int, watchdog: Alarm, headsUp: Alarm, firstRow: int, boardChanged: bool })
    | TurnLost({ firstRow: int, boardChanged: bool })

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
    turn: StoredTurn,
    nextStart: int,
    // The `runAgent` alarms that no running turn lane cancels: those a new instance arms for rows
    // that wait, and the backup alarms a restart kept. A restart does not reuse an armed one.
    runAgentAlarms: int,
    // The backup alarm `tellAgent` armed as it started the turn lane that runs. The lane cancels
    // it when it returns. It is the newest `runAgent` alarm, so it fires after every other one.
    backupAlarm: bool,
    lastInputOverLimit: bool,
    chat: ChatStatus,
    posts: List[Post],
    pagesFetched: int,
    messagesRead: int,
    // The firings whose payload went to the screen. It numbers their payloads.
    payloadsScreened: int,
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

  /// One model call of a turn, or the system's first reply before the model runs: the tools it
  /// ran, and whether it left the person a reply.
  type StepRecord = { ran: Set[Tool], answered: bool }

  /// What a revision request did with the comments held on the author's page: it did not read
  /// them, it sent them after or before the person heard back, or they stay held. `authorFinished`
  /// when the screen admitted them but the workflow finished and cancelled their author meanwhile.
  type HeldCommentsOutcome =
    | HeldCommentsNotRead
    | HeldCommentsSent({ afterTheFirstReply: bool })
    | HeldCommentsKept({ authorFinished: bool })

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
    quarantinedPayloads: Set[int],
    messagesRead: Set[int],
    admittedMessages: Set[int],
    timedOut: bool,
    lostTurnOwed: bool,
    callHung: bool,
    heldComments: HeldCommentsOutcome,
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
    // The heads-up of this turn start reached a chat thread.
    headsUpPosted: bool,
    // The turn on a person's message, or the lost turn it resumes, started or prompted a task in
    // chat. The turn keeps it after the watchdog deleted its record.
    boardChanged: bool,
    record: TurnRecord,
  }

  type TurnSlot = Idle | Running(TurnRun)

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

  /// The two alarms an agent turn arms, by the handler they call.
  type TurnAlarmKind = WatchdogAlarm | HeadsUpAlarm

  /// The kind of a step, for the rules and witnesses over one step. A stale alarm step carries the
  /// start of the turn its alarm was armed for.
  type StepKind = OtherStep | StaleAlarmStep(int)

  /// Whether the last step kept each rule over one step.
  type KeptRules = {
    aStaleTurnAlarmChangesNothing: bool,
    theHeadsUpPostsOnceToChatInAPersonsTurn: bool,
    aPersonsMessageLeavesTheInboxOnlyWithItsTurn: bool,
  }

  /// Whether the last step reached each witness that needs the step.
  type ReachedWitnesses = {
    aStaleAlarmFiresAfterItsTurnEnded: bool,
    aStaleAlarmFiresAfterARestart: bool,
    aStaleAlarmFiresDuringALaterTurn: bool,
  }

  /// What a step did with the backup alarm: a restart kept it, it fired while its turn ran, or
  /// the turn lane cancelled it as it returned.
  type BackupAlarmStep = { kept: bool, firedDuringItsTurn: bool, cancelled: bool }
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

  /// How many alarms fire in a run for a turn that no longer runs.
  pure val MAX_STALE_ALARMS: int = 2

  /// The most turns that start in a run. Each one takes a row that arrived or a restart's note.
  pure val MAX_TURN_STARTS: int = MAX_ARRIVALS + MAX_RESTARTS

  /// How many firings send their payload to the screen in a run.
  pure val MAX_FIRINGS: int = 2

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
    turn: NoTurn,
    nextStart: 1,
    runAgentAlarms: 0,
    backupAlarm: false,
    lastInputOverLimit: false,
    chat: NoStatus,
    posts: [],
    pagesFetched: 0,
    messagesRead: 0,
    payloadsScreened: 0,
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
    quarantinedPayloads: Set(),
    messagesRead: Set(),
    admittedMessages: Set(),
    timedOut: false,
    lostTurnOwed: false,
    callHung: false,
    heldComments: HeldCommentsNotRead,
    decisionsEvents: [],
    answeredBy: [],
    reads: [],
    answering: Set(),
  }

  var workflow: Workflow
  var models: List[ModelSays]
  var lastTurnEnd: TurnEnd
  /// What the last step did with the backup alarm. Only witnesses read it.
  var backupAlarmStep: BackupAlarmStep
  /// The steps the run took. TLC bounds a run by it.
  var actionsTaken: int
  /// The alarms that fired for a turn that no longer runs.
  var staleAlarmsTaken: int
  var lastStepKept: KeptRules
  var lastStepReached: ReachedWitnesses
  /// The payloads whose screen a firing's handler waits on, outside any turn. A restart drops them.
  var payloadScreensOut: Set[int]

  /// A person wrote the row, so it has their words and a reply target.
  pure def isPerson(from: RowFrom): bool = match from { | Person(_) => true | _ => false }

  /// The row wakes the agent as a message: a person's row or a firing's row.
  pure def wakesAsMessage(from: RowFrom): bool = match from { | FromWorkflow => false | _ => true }

  pure def originOf(from: RowFrom): Set[Origin] =
    match from { | Person(origin) => Set(origin) | _ => Set() }

  /// The payloads of the firing rows among `rows` that the screen admitted, or withheld.
  pure def payloadsOf(rows: List[InboxRow], admitted: bool): Set[int] =
    rows.foldl(Set(), (payloads, row) => match row.from {
      | FromFiring(fired) => if (fired.admitted == admitted) payloads.union(Set(fired.payload)) else payloads
      | _ => payloads
    })

  pure def isSessionOrigin(origin: Origin): bool = origin != ChatThread

  pure def idsOf(rows: List[InboxRow]): Set[int] =
    rows.foldl(Set(), (ids, row) => ids.union(Set(row.id)))

  pure def waitingRows(store: Store): List[InboxRow] = store.inbox.select(row => not(row.taken))

  pure def takenPersonRows(store: Store): List[InboxRow] =
    store.inbox.select(row => row.taken and isPerson(row.from))

  /// The taken rows that woke the agent as a message: the transcript's `takenMessages()`.
  pure def takenMessageRows(store: Store): List[InboxRow] =
    store.inbox.select(row => row.taken and wakesAsMessage(row.from))

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

  /// The status a call to every chat thread among the reply targets leaves. Without a chat
  /// thread no status call goes out.
  pure def chatSetTo(store: Store, status: ChatStatus): ChatStatus = if (HAS_CHAT_THREAD) status else store.chat

  /// A post lands. A post to the chat thread that does not keep its working status releases it.
  pure def landPost(store: Store, text: PostText, targets: Set[Target], keepsSession: bool): Store = {
    ...store,
    posts: store.posts.append({ text: text, targets: targets, answering: answeringNow(store) }),
    chat: if (keepsSession or not(targets.contains(ToChatThread))) store.chat else released(store),
  }

  /// The store holds the turn of `start` as running.
  pure def holdsAsRunning(store: Store, start: int): bool = match store.turn {
    | TurnRunning(running) => running.startedAt == start
    | _ => false
  }

  /// The stored turn with its board change marked, when it runs.
  pure def boardChangedIn(turn: StoredTurn): StoredTurn = match turn {
    | TurnRunning(running) => TurnRunning({ ...running, boardChanged: true })
    | _ => turn
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
  /// the inbox is empty. The heads-up is armed only when a person's row was taken. Only a person's
  /// words go to the decisions model.
  pure def startTurn(store: Store, carried: Carried, said: List[ModelSays]): { store: Store, turn: TurnSlot } =
    val waiting = waitingRows(store)
    if (waiting.length() == 0) { store: store, turn: Idle }
    else
      val takenRow = store.nextRowId
      val takenIds = idsOf(waiting)
      val lostTurnOwed = takenPersonRows(store).length() > 0
      val took = appendRows(
        { ...store, inbox: store.inbox.foldl([], (rows, row) => rows.append({ ...row, taken: true })) },
        [TakenRows({ rows: takenIds, payloads: payloadsOf(waiting, true) })],
      )
      val lost = match store.turn {
        | TurnLost(lostTurn) => lostTurn
        | _ => { firstRow: takenRow, boardChanged: false }
      }
      val first = lost.firstRow
      val people = takenPersonRows(took)
      val armed = {
        ...took,
        turn: TurnRunning({
          startedAt: store.nextStart,
          watchdog: ArmedFor(store.nextStart),
          headsUp: if (people.length() > 0) ArmedFor(store.nextStart) else NoAlarm,
          firstRow: first,
          boardChanged: lost.boardChanged,
        }),
        nextStart: store.nextStart + 1,
      }
      val base = match carried {
        | Fresh => { ...FRESH_RECORD, rowsBefore: store.transcript }
        | ResumedFrom(lost) => if (lostTurnOwed) lost else { ...FRESH_RECORD, rowsBefore: lost.rowsBefore }
      }
      val record = {
        ...base,
        owed: NotOwed,
        inboxRows: idsOf(took.inbox.select(row => row.taken)),
        quarantinedPayloads: payloadsOf(took.inbox.select(row => row.taken), false),
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
        headsUpPosted: false,
        boardChanged: lost.boardChanged,
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

  /// The turn that ended leaves its record. The isolate runs one more turn when a row arrived
  /// while it ran. Otherwise the turn lane returns and cancels its backup alarm.
  pure def endTurn(store: Store, turnRun: TurnRun, rerun: bool, said: List[ModelSays]): Next =
    val ended = TurnEnded({
      record: turnRun.record,
      transcript: store.transcript,
      waiting: idsOf(waitingRows(store)),
      chatMessageWaits: anyOf(waitingRows(store), row => row.from == Person(ChatThread)),
      chat: store.chat,
    })
    val after = if (rerun) startTurn(store, Fresh, said) else { store: store, turn: Idle }
    val laneReturned = if (after.turn == Idle) { ...after.store, backupAlarm: false } else after.store
    { workflow: { store: laneReturned, isolate: { turn: after.turn, rerun: false } }, turnEnd: ended }

  /// `boundedAttempt` returns. The turn disarms its watchdog, then concludes when it still owes
  /// the reply. When the watchdog already posted the timeout text, the turn only releases.
  pure def attemptEnds(store: Store, turnRun: TurnRun, outcome: Outcome, rerun: bool, said: List[ModelSays]): Next =
    if (not(holdsAsRunning(store, turnRun.startedAt))) withTurnKeepingRerun(store, { ...turnRun, phase: Concluding(Releases) }, rerun)
    else
      val disarmed = {
        ...store,
        turn: NoTurn,
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
    else if (turnRun.owed != NotOwed and turnRun.pass == 1 and not(text or turnRun.passEndedByTool or turnRun.boardChanged))
      callModel(
        appendRows(store, [UnansweredNote]),
        { ...turnRun, pass: 2, passEndedByTool: false, record: { ...turnRun.record, askedAgain: true } },
        rerun,
        said,
      )
    else if (turnRun.passEndedByTool or not(text)) attemptEnds(store, turnRun, Silent, rerun, said)
    else if (turnRun.owed == NotOwed or (turnRun.owed == OwedBoard and turnRun.boardChanged)) attemptEnds(store, turnRun, Silent, rerun, said)
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
    val landed = { ...appendRows(store, entries), lastInputOverLimit: overLimit, chat: chatSetTo(store, Processing) }
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
          val changesTheBoard = turnRun.owed != NotOwed and HAS_CHAT_THREAD
          val changed = {
            ...ran,
            boardChanged: ran.boardChanged or changesTheBoard,
            record: { ...ran.record, boardChanged: ran.record.boardChanged or HAS_CHAT_THREAD },
          }
          val board = if (changesTheBoard) { ...store, turn: boardChangedIn(store.turn) } else store
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
  /// stay held when the workflow finished and cancelled their author meanwhile. The agent hears
  /// what happened to the held comments in every case.
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
                val outcome =
                  if (admitted and not(store.workflowEnded)) HeldCommentsSent({ afterTheFirstReply: heardBack(store, record) })
                  else HeldCommentsKept({ authorFinished: admitted })
                afterRead(appendRows(store, [HeldCommentsNote]), { ...landed, record: { ...record, heldComments: outcome } }, rerun, said)
          }
      | _ => { workflow: { store: store, isolate: { turn: Running(turnRun), rerun: rerun } }, turnEnd: NoTurnEnd }
    }

  /// What a failed read falls back to: an unread message.
  pure val UNREAD: MessageRead = { asksForRevision: false, namesModel: false }

  /// The person heard back in the turn: a post answered them, or their chat messages have the
  /// thumbs-up.
  pure def heardBack(store: Store, record: TurnRecord): bool =
    answeringPosts(record).length() > 0 or anyOf(takenPersonRows(store), row => row.reacted)

  /// The turn sends the first reply itself: the thumbs-up on the chat messages that wait for one,
  /// or one line to the people it answers. The model's `acknowledge` then fails.
  pure def repliesFirst(store: Store, turnRun: TurnRun): { store: Store, turnRun: TurnRun } =
    val replied = { ...turnRun, acknowledged: true, firstReplied: true, record: { ...turnRun.record, steps: turnRun.record.steps.append({ ran: Set(), answered: true }) } }
    if (turnRun.reactable)
      val reacting = idsOf(awaitingThumbsUp(store))
      val reacted = store.inbox.foldl([], (rows, row) => rows.append(if (reacting.contains(row.id)) { ...row, reacted: true } else row))
      { store: { ...store, inbox: reacted }, turnRun: replied }
    else
      val targets = answeringTargets(false, turnRun.answering)
      { store: landPost(store, AcknowledgeText, targets, false), turnRun: { ...replied, record: recordPost(replied.record, AcknowledgeText, targets) } }

  /// The read of the person's message lands. A failed read owes the person an answer. A message
  /// that names a model starts the runtime request beside the turn. A message that asks for a
  /// revision gets the first reply, then screens the comments held on the author's page before
  /// the model runs, unless the workflow finished and cancelled the author.
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
    val acknowledged = if (read.asksForRevision) repliesFirst(store, readTurn) else { store: store, turnRun: readTurn }
    if (sendsHeldComments)
      keepRerun(withTurn(acknowledged.store, { ...acknowledged.turnRun, phase: Screening({ screened: ScreensHeldComments, overLimit: false }) }), rerun)
    else afterRead(acknowledged.store, acknowledged.turnRun, rerun, said)

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

  /// The new instance resumes the lost turn: the chat threads of a lost turn on a message hear
  /// that it starts again, and an agent note wakes the turn that resumes. `tellAgent` arms the
  /// backup alarm of its lane.
  pure def resumed(store: Store, forgotten: Store, lost: TurnSlot, said: List[ModelSays]): Next =
    val lostRecord = match lost { | Running(turnRun) => turnRun.record | Idle => FRESH_RECORD }
    val noticed = takenMessageRows(store).length() > 0 and HAS_CHAT_THREAD
    val told = if (noticed) landPost(forgotten, LostPlaceText, CHAT_THREADS, true) else forgotten
    val carried = if (noticed) recordPost(lostRecord, LostPlaceText, CHAT_THREADS) else lostRecord
    val woken = { ...told,
      inbox: told.inbox.append({ id: told.nextInboxId, from: FromWorkflow, taken: false, reacted: false }),
      nextInboxId: told.nextInboxId + 1,
      backupAlarm: true,
    }
    val after = startTurn(woken, ResumedFrom(carried), said)
    { workflow: { store: after.store, isolate: { turn: after.turn, rerun: false } }, turnEnd: NoTurnEnd }

  /// `resumeLostTurn` on the new instance, and the turn its wake starts. The backup alarm of the
  /// lost turn lane stays armed, since no lane cancels it now. With no lost turn, rows that wait
  /// get the `runAgent` alarm. A finished workflow drops a lost turn that took no message,
  /// releases the threads, and arms the `runAgent` alarm for rows that wait. It resumes a lost turn
  /// on a message.
  pure def restarted(store: Store, lost: TurnSlot, said: List[ModelSays]): Next =
    val counted = { ...store,
      restarts: store.restarts + 1,
      runAgentAlarms: store.runAgentAlarms + (if (store.backupAlarm) 1 else 0),
      backupAlarm: false,
    }
    match store.turn {
      | TurnRunning(running) =>
          val forgotten = { ...counted, turn: TurnLost({ firstRow: running.firstRow, boardChanged: running.boardChanged }) }
          val dropped = { ...forgotten,
            turn: NoTurn,
            inbox: forgotten.inbox.select(row => not(row.taken)),
            chat: chatSetTo(forgotten, Closed),
          }
          val woken = if (waitingRows(dropped).length() > 0) { ...dropped, runAgentAlarms: dropped.runAgentAlarms + 1 } else dropped
          if (store.workflowEnded and takenMessageRows(store).length() == 0)
            { workflow: { store: woken, isolate: { turn: Idle, rerun: false } }, turnEnd: NoTurnEnd }
          else resumed(store, forgotten, lost, said)
      | _ =>
          val armed = if (waitingRows(counted).length() > 0) { ...counted, runAgentAlarms: counted.runAgentAlarms + 1 } else counted
          { workflow: { store: armed, isolate: { turn: Idle, rerun: false } }, turnEnd: NoTurnEnd }
    }

  /// What a step from `before` to `after` did with the backup alarm.
  pure def backupAlarmStepOf(before: Workflow, after: Workflow): BackupAlarmStep =
    val restarted = after.store.restarts > before.store.restarts
    val gone = before.store.backupAlarm and not(after.store.backupAlarm) and not(restarted)
    {
      kept: restarted and before.store.backupAlarm,
      firedDuringItsTurn: gone and after.isolate.turn != Idle,
      cancelled: gone and after.isolate.turn == Idle,
    }

  pure val NO_BACKUP_ALARM_STEP: BackupAlarmStep = { kept: false, firedDuringItsTurn: false, cancelled: false }

  /// Take a step of `kind` to `after`, and record which rules over one step it kept.
  action stepTo(after: Next, kind: StepKind): bool = stepWithScreens(after, kind, payloadScreensOut)

  /// Take a step of `kind` to `after` that leaves `screens` as the payload screens out.
  action stepWithScreens(after: Next, kind: StepKind, screens: Set[int]): bool = all {
    payloadScreensOut' = screens,
    workflow' = after.workflow,
    models' = models,
    lastTurnEnd' = after.turnEnd,
    backupAlarmStep' = backupAlarmStepOf(workflow, after.workflow),
    actionsTaken' = actionsTaken + 1,
    staleAlarmsTaken' = staleAlarmsTaken + (if (isStaleAlarmStep(kind)) 1 else 0),
    lastStepKept' = rulesKeptBy(workflow, after, kind),
    lastStepReached' = witnessesReachedBy(workflow, kind),
  }

  action move(after: Next): bool = stepTo(after, OtherStep)

  /// Run `act` on the running turn.
  action onTurn(act: TurnRun => bool): bool = match workflow.isolate.turn {
    | Running(turnRun) => act(turnRun)
    | Idle => all { false, move({ workflow: workflow, turnEnd: lastTurnEnd }) }
  }

  action init: bool = all {
    nondet said = MODEL_LISTS.oneOf()
    models' = said,
    workflow' = { store: EMPTY_STORE, isolate: { turn: Idle, rerun: false } },
    lastTurnEnd' = NoTurnEnd,
    backupAlarmStep' = NO_BACKUP_ALARM_STEP,
    actionsTaken' = 0,
    staleAlarmsTaken' = 0,
    lastStepKept' = ALL_RULES_KEPT,
    lastStepReached' = NO_WITNESS_REACHED,
    payloadScreensOut' = Set(),
  }

  /// A row lands in the inbox and wakes the agent. The isolate runs the turn now in a lane that
  /// `tellAgent` backs with a backup alarm, or once more after the turn that runs. The lane that
  /// runs returns at once to that `tellAgent`, which cancels the backup alarm it just armed.
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
      | Idle =>
          val after = startTurn({ ...queued, backupAlarm: true }, Fresh, said)
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

  /// A firing reaches the workflow, and its handler sends the payload to the screen before the
  /// row exists, outside any turn. The firing of a workflow that finished starts the next
  /// workflow, which this spec leaves out.
  action firingScreenStarts: bool = all {
    workflow.store.payloadsScreened < MAX_FIRINGS,
    workflow.store.nextInboxId + payloadScreensOut.size() <= MAX_ARRIVALS,
    not(workflow.store.workflowEnded),
    val payload = workflow.store.payloadsScreened
    stepWithScreens(
      { workflow: { ...workflow, store: { ...workflow.store, payloadsScreened: payload + 1 } }, turnEnd: NoTurnEnd },
      OtherStep,
      payloadScreensOut.union(Set(payload)),
    ),
  }

  /// The screen of a firing's payload lands, and the handler queues the firing's row. The row
  /// holds the payload only when the screen admitted it, and the fixed line otherwise.
  action firingScreenLands(payload: int, admitted: bool): bool = all {
    payloadScreensOut.contains(payload),
    stepWithScreens(
      arrive(workflow, FromFiring({ payload: payload, admitted: admitted }), models),
      OtherStep,
      payloadScreensOut.exclude(Set(payload)),
    ),
  }

  /// The screen answers for a firing's payload. It may flag it.
  action firingScreenAnswers(payload: int, flagsPayload: bool): bool = all {
    firstAnswering(models) >= 0,
    firingScreenLands(payload, not(flagsPayload)),
  }

  /// The screen of a firing's payload fails, and the payload stays unchecked.
  action firingScreenFails(payload: int): bool = all {
    firstAnswering(models) < 0,
    firingScreenLands(payload, false),
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
          | Releases => endTurn({ ...store, chat: chatSetTo(store, released(store)) }, turnRun, rerun, said)
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

  /// `onTurnTimeout` with the start the alarm carries. It acts only while the store holds the turn
  /// of that start as running: it clears the turn, deletes the taken rows and posts the timeout
  /// text. On a finished workflow where nobody waits, it only releases the threads. The turn
  /// itself keeps running.
  pure def watchdogLands(w: Workflow, armedFor: int): Workflow =
    if (not(holdsAsRunning(w.store, armedFor))) w
    else match w.isolate.turn {
      | Idle => w
      | Running(turnRun) =>
          val store = w.store
          val told = answeringTargets(true, answeringNow(store))
          val cleared = { ...store,
            turn: NoTurn,
            inbox: store.inbox.select(row => not(row.taken)),
          }
          if (store.workflowEnded and answeringNow(store).size() == 0)
            { store: { ...cleared, chat: chatSetTo(cleared, Closed) }, isolate: { ...w.isolate, turn: Running({ ...turnRun, record: { ...turnRun.record, timedOut: true } }) } }
          else {
            store: landPost(cleared, TimeoutText, told, false),
            isolate: { ...w.isolate, turn: Running({ ...turnRun, record: { ...recordPost(turnRun.record, TimeoutText, told), timedOut: true } }) },
          }
    }

  /// `onTurnHeadsUp` with the start the alarm carries. It acts only while the store holds the turn
  /// of that start as running: its chat threads hear that it still runs, and keep working.
  pure def headsUpLands(w: Workflow, armedFor: int): Workflow =
    if (not(holdsAsRunning(w.store, armedFor))) w
    else match w.isolate.turn {
      | Idle => w
      | Running(turnRun) =>
          val fired = match w.store.turn {
            | TurnRunning(running) => TurnRunning({ ...running, headsUp: NoAlarm })
            | _ => w.store.turn
          }
          val store = { ...w.store, turn: fired }
          val told = if (HAS_CHAT_THREAD) landPost(store, HeadsUpText, CHAT_THREADS, true) else store
          val record = if (HAS_CHAT_THREAD) recordPost(turnRun.record, HeadsUpText, CHAT_THREADS) else turnRun.record
          { store: told, isolate: { ...w.isolate, turn: Running({ ...turnRun, headsUpPosted: turnRun.headsUpPosted or HAS_CHAT_THREAD, record: record }) } }
    }

  /// The watchdog alarm of the running turn fires after the timeout.
  action watchdogFires: bool = onTurn(turnRun => all {
    turnRun.pastTimeout,
    match workflow.store.turn {
      | TurnRunning(running) => running.watchdog == ArmedFor(turnRun.startedAt)
      | _ => false
    },
    move({ workflow: watchdogLands(workflow, turnRun.startedAt), turnEnd: NoTurnEnd }),
  })

  /// The workflow finishes: its last job completes, or a person stops it. A turn that runs goes on.
  /// A firing whose screen is out would land on the next workflow, which this spec leaves out.
  action workflowFinishes: bool = all {
    not(workflow.store.workflowEnded),
    payloadScreensOut.size() == 0,
    move({ workflow: { ...workflow, store: { ...workflow.store, workflowEnded: true } }, turnEnd: NoTurnEnd }),
  }

  /// The heads-up alarm of the running turn fires.
  action headsUpFires: bool = onTurn(turnRun => all {
    match workflow.store.turn {
      | TurnRunning(running) => running.headsUp == ArmedFor(turnRun.startedAt)
      | _ => false
    },
    move({ workflow: headsUpLands(workflow, turnRun.startedAt), turnEnd: NoTurnEnd }),
  })

  /// A watchdog or heads-up alarm fires for a turn that no longer runs: a turn that ended, a turn
  /// a restart lost, or a turn before the one that runs now. The store does not hold that turn as
  /// running. Its handler runs as for the running turn's alarm.
  action staleAlarmFires(kind: TurnAlarmKind, armedFor: int): bool = all {
    staleAlarmsTaken < MAX_STALE_ALARMS,
    armedFor < workflow.store.nextStart,
    not(holdsAsRunning(workflow.store, armedFor)),
    val landed = match kind {
      | WatchdogAlarm => watchdogLands(workflow, armedFor)
      | HeadsUpAlarm => headsUpLands(workflow, armedFor)
    }
    stepTo({ workflow: landed, turnEnd: NoTurnEnd }, StaleAlarmStep(armedFor)),
  }

  /// A deploy resets the Durable Object. The isolate and its turn are gone, with every call it
  /// had out, the payload screens of firings among them. The new instance resumes a turn the
  /// store still holds as running.
  action durableObjectRestarts: bool = all {
    workflow.store.restarts < MAX_RESTARTS,
    stepWithScreens(restarted(workflow.store, workflow.isolate.turn, models), OtherStep, Set()),
  }

  /// The oldest `runAgent` alarm fires: the backup alarm only after every other one. Like
  /// `runIfIdle`, it runs a turn only when none runs.
  action runAgentAlarmFires: bool = all {
    workflow.store.runAgentAlarms > 0 or workflow.store.backupAlarm,
    val store =
      if (workflow.store.runAgentAlarms > 0) { ...workflow.store, runAgentAlarms: workflow.store.runAgentAlarms - 1 }
      else { ...workflow.store, backupAlarm: false }
    match workflow.isolate.turn {
      | Running(_) => move({ workflow: { ...workflow, store: store }, turnEnd: NoTurnEnd })
      | Idle =>
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

  /// The alarms that fired for a turn that no longer runs.
  val staleAlarmsFired: int = staleAlarmsTaken

  /// The firings whose payload went to the screen.
  val firingsScreened: int = workflow.store.payloadsScreened

  /// The workflow finished, every restart and stale alarm happened, no turn runs, no payload
  /// screen is out and no `runAgent` alarm is armed. These negate the guards of every other step,
  /// so each of them is blocked here. A run where no turn started has no alarm to fire late.
  val theTurnsEnd: bool = and {
    workflow.store.workflowEnded,
    payloadScreensOut.size() == 0,
    workflow.store.restarts >= MAX_RESTARTS,
    staleAlarmsTaken >= MAX_STALE_ALARMS or workflow.store.nextStart == 1,
    workflow.isolate.turn == Idle,
    workflow.store.runAgentAlarms == 0,
    not(workflow.store.backupAlarm),
  }

  /// The model stays in its end state, so TLC does not report the end as a deadlock.
  action finished: bool = all {
    theTurnsEnd,
    workflow' = workflow,
    models' = models,
    lastTurnEnd' = lastTurnEnd,
    backupAlarmStep' = NO_BACKUP_ALARM_STEP,
    actionsTaken' = actionsTaken,
    staleAlarmsTaken' = staleAlarmsTaken,
    lastStepKept' = lastStepKept,
    lastStepReached' = lastStepReached,
    payloadScreensOut' = payloadScreensOut,
  }

  /// Each step picks only the values its action reads, so TLC does not generate one copy of a
  /// successor for every value of a pick it ignores.
  action step: bool = any {
    {
      nondet origin = ORIGINS.oneOf()
      personWrites(origin)
    },
    workflowEventArrives,
    firingScreenStarts,
    {
      nondet payload = 0.to(MAX_FIRINGS - 1).oneOf()
      nondet flagsPayload = Set(true, false).oneOf()
      firingScreenAnswers(payload, flagsPayload)
    },
    {
      nondet payload = 0.to(MAX_FIRINGS - 1).oneOf()
      firingScreenFails(payload)
    },
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
    {
      nondet alarm = Set(WatchdogAlarm, HeadsUpAlarm).oneOf()
      nondet armedFor = 1.to(MAX_TURN_STARTS).oneOf()
      staleAlarmFires(alarm, armedFor)
    },
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
        ended.transcript.select(row => match row.entry { | TakenRows(taken) => taken.rows.contains(id) | _ => false }).length() == 1,
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
  /// them a post or the thumbs-up. The held comments a revision request sends follow a post or the
  /// thumbs-up too.
  val aPersonHearsBackBeforeAnyWork: bool = holdsForTheEndedTurn(lastTurnEnd, record =>
    record.owed == NotOwed or and {
      record.steps.foldl({ heard: true, answered: false }, (seen, step) => {
        heard: seen.heard and (step.ran.exclude(FIRST_REPLY_TOOLS).size() > 0 implies seen.answered),
        answered: seen.answered or step.answered,
      }).heard,
      match record.heldComments { | HeldCommentsSent(sent) => sent.afterTheFirstReply | _ => true },
    })

  pure def holdsText(entry: Entry, pages: Set[int], messages: Set[int], payloads: Set[int]): bool = match entry {
    | TakenRows(taken) => taken.payloads.intersect(payloads).size() > 0
    | ToolResultRow(output) => match output {
        | PageText(page) => pages.contains(page)
        | ChannelRead(read) => read.intersect(messages).size() > 0
        | _ => false
      }
    | _ => false
  }

  /// A page, chat message or firing payload the screen did not admit is in no row of the
  /// transcript.
  val quarantinedTextNeverEntersTheTranscript: bool = match lastTurnEnd {
    | TurnEnded(ended) =>
        val record = ended.record
        val messages = record.messagesRead.exclude(record.admittedMessages)
        not(anyOf(ended.transcript, row => holdsText(row.entry, record.quarantinedPages, messages, record.quarantinedPayloads)))
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
      ((workflow.isolate.turn != Idle and workflow.isolate.rerun) or workflow.store.runAgentAlarms > 0)

  pure def isStaleAlarmStep(kind: StepKind): bool = match kind { | StaleAlarmStep(_) => true | _ => false }

  /// The posts a step added. Posts are only ever appended.
  pure def postsAdded(before: Store, after: Store): List[Post] =
    after.posts.slice(before.posts.length(), after.posts.length())

  /// A stale alarm leaves the workflow as it was: the store, its posts, and the turn that runs.
  pure def changesNothingOnAStaleAlarm(before: Workflow, after: Next, kind: StepKind): bool =
    isStaleAlarmStep(kind) implies after.workflow == before

  /// A step posts the heads-up at most once, only to the chat threads, and only in a turn that
  /// took a person's message and did not post its heads-up yet.
  pure def postsTheHeadsUpOnceToChat(before: Workflow, after: Next): bool =
    val headsUps = postsAdded(before.store, after.workflow.store).select(post => post.text == HeadsUpText)
    headsUps.length() == 0 or and {
      headsUps.length() == 1,
      HAS_CHAT_THREAD,
      headsUps[0].targets == CHAT_THREADS,
      match before.isolate.turn {
        | Running(turnRun) => turnRun.answering.size() > 0 and not(turnRun.headsUpPosted)
        | Idle => false
      },
    }

  /// A person's message leaves the inbox only with the turn that took it: the turn that ended in
  /// the step, or a turn that runs after it.
  pure def leavesAPersonsMessageWithItsTurn(before: Workflow, after: Next): bool =
    val left = idsOf(takenPersonRows(before.store)).exclude(idsOf(after.workflow.store.inbox))
    val ended = match after.turnEnd { | TurnEnded(turnEnd) => turnEnd.record.inboxRows | NoTurnEnd => Set() }
    val running = match after.workflow.isolate.turn { | Running(turnRun) => turnRun.record.inboxRows | Idle => Set() }
    left.subseteq(ended.union(running))

  pure val ALL_RULES_KEPT: KeptRules = {
    aStaleTurnAlarmChangesNothing: true,
    theHeadsUpPostsOnceToChatInAPersonsTurn: true,
    aPersonsMessageLeavesTheInboxOnlyWithItsTurn: true,
  }

  pure def rulesKeptBy(before: Workflow, after: Next, kind: StepKind): KeptRules = {
    aStaleTurnAlarmChangesNothing: changesNothingOnAStaleAlarm(before, after, kind),
    theHeadsUpPostsOnceToChatInAPersonsTurn: postsTheHeadsUpOnceToChat(before, after),
    aPersonsMessageLeavesTheInboxOnlyWithItsTurn: leavesAPersonsMessageWithItsTurn(before, after),
  }

  pure val NO_WITNESS_REACHED: ReachedWitnesses = {
    aStaleAlarmFiresAfterItsTurnEnded: false,
    aStaleAlarmFiresAfterARestart: false,
    aStaleAlarmFiresDuringALaterTurn: false,
  }

  pure def witnessesReachedBy(before: Workflow, kind: StepKind): ReachedWitnesses = match kind {
    | StaleAlarmStep(armedFor) => {
        aStaleAlarmFiresAfterItsTurnEnded: before.isolate.turn == Idle and before.store.restarts == 0,
        aStaleAlarmFiresAfterARestart: before.store.restarts > 0,
        aStaleAlarmFiresDuringALaterTurn: match before.isolate.turn {
          | Running(turnRun) => turnRun.startedAt > armedFor
          | Idle => false
        },
      }
    | OtherStep => NO_WITNESS_REACHED
  }

  /// A heads-up or watchdog alarm armed for a turn that no longer runs does not change the store
  /// and does not post.
  val aStaleTurnAlarmChangesNothing: bool = lastStepKept.aStaleTurnAlarmChangesNothing

  /// The heads-up posts at most once per turn, only in a turn that took a person's message, and
  /// only to the chat threads.
  val theHeadsUpPostsOnceToChatInAPersonsTurn: bool = lastStepKept.theHeadsUpPostsOnceToChatInAPersonsTurn

  /// A person's message leaves the inbox only with the turn that took it, so a turn always ends
  /// on it. A restart does not drop it, also on a finished workflow.
  val aPersonsMessageLeavesTheInboxOnlyWithItsTurn: bool = lastStepKept.aPersonsMessageLeavesTheInboxOnlyWithItsTurn

  /// The store holds a turn as running only while that turn runs. One turn runs at a time.
  val oneTurnRunsAtATime: bool = match workflow.store.turn {
    | TurnRunning(running) => match workflow.isolate.turn {
        | Running(turnRun) => turnRun.startedAt == running.startedAt
        | Idle => false
      }
    | _ => true
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
    aStaleTurnAlarmChangesNothing,
    theHeadsUpPostsOnceToChatInAPersonsTurn,
    aPersonsMessageLeavesTheInboxOnlyWithItsTurn,
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

  /// Witness for `quarantinedTextNeverEntersTheTranscript`: a turn took a firing's row whose
  /// payload the screen flagged or could not check.
  val aTriggeredPayloadIsQuarantined: bool = endedTurnWhere(lastTurnEnd, record => record.quarantinedPayloads.size() > 0)

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
    | Running(turnRun) => turnRun.pastTimeout and workflow.store.turn == NoTurn and turnRun.record.timedOut
    | Idle => false
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

  /// Witness for `theWorkingStatusNeverOutlivesItsTurn` and `theHeadsUpPostsOnceToChatInAPersonsTurn`:
  /// the heads-up reached a chat thread.
  val theHeadsUpPosts: bool = anyOf(workflow.store.posts, post => post.text == HeadsUpText)

  /// Witness for `aWaitingInboxRowHasATurnComing`: a restart kept the backup alarm of the turn lane
  /// it cut off.
  val aRestartKeepsTheBackupAlarm: bool = backupAlarmStep.kept

  /// Witness for `oneTurnRunsAtATime`: the backup alarm fired while the turn of its lane ran, and
  /// ran no turn.
  val theBackupAlarmFiresDuringItsTurn: bool = backupAlarmStep.firedDuringItsTurn

  /// Witness for `aWaitingInboxRowHasATurnComing`: the turn lane returned and cancelled its backup
  /// alarm.
  val theTurnLaneCancelsItsBackupAlarm: bool = backupAlarmStep.cancelled

  /// Witness for `aWaitingInboxRowHasATurnComing`: a row waits for the `runAgent` alarm after a
  /// restart.
  val aRowWaitsForTheRunAgentAlarm: bool =
    workflow.store.runAgentAlarms > 0 and waitingRows(workflow.store).length() > 0

  /// Witness for `aPersonHearsBackBeforeAnyWork`: a person's revision request sent the held
  /// comments to the author after the first reply.
  val aRevisionSendsTheHeldComments: bool = endedTurnWhere(lastTurnEnd, record =>
    match record.heldComments { | HeldCommentsSent(_) => true | _ => false })

  /// The screen admitted the held comments of a revision request, but the workflow finished and
  /// cancelled their author meanwhile, so they stay held.
  val aFinishedAuthorKeepsItsHeldComments: bool = endedTurnWhere(lastTurnEnd, record =>
    record.heldComments == HeldCommentsKept({ authorFinished: true }))

  /// Witness for `aPersonsMessageLeavesTheInboxOnlyWithItsTurn`: a restart resumed a lost turn on a
  /// person's message after the workflow finished.
  val aRestartResumesAPersonsTurnOnAFinishedWorkflow: bool = match workflow.isolate.turn {
    | Running(turnRun) => turnRun.record.lostTurnOwed and workflow.store.workflowEnded
    | Idle => false
  }

  /// Witness for `aStaleTurnAlarmChangesNothing`: a stale alarm fired with no turn running, before
  /// any restart.
  val aStaleAlarmFiresAfterItsTurnEnded: bool = lastStepReached.aStaleAlarmFiresAfterItsTurnEnded

  /// Witness for `aStaleTurnAlarmChangesNothing`: a stale alarm fired after a restart.
  val aStaleAlarmFiresAfterARestart: bool = lastStepReached.aStaleAlarmFiresAfterARestart

  /// Witness for `aStaleTurnAlarmChangesNothing`: a stale alarm fired while a later turn ran.
  val aStaleAlarmFiresDuringALaterTurn: bool = lastStepReached.aStaleAlarmFiresDuringALaterTurn

  /// Witness for `laterDecisionsCallsFallBackOnceOneFails`: the runtime request is out while the turn
  /// waits on a screen call.
  val twoDecisionsCallsAreOut: bool = match workflow.isolate.turn {
    | Running(turnRun) => turnRun.runtimeRequestOut and isScreening(turnRun.phase)
    | Idle => false
  }

  /// Witness for `aWaitingPersonHearsBackByTheTimeout`: the watchdog fired while the closing text was
  /// still posting.
  val theClosingPostOutlivesTheTimeout: bool = match workflow.isolate.turn {
    | Running(turnRun) => isPostingClosing(turnRun.phase) and turnRun.pastTimeout and workflow.store.turn == NoTurn
    | Idle => false
  }

  /// Witness for `theWorkingStatusNeverOutlivesItsTurn`: the watchdog of a finished workflow released
  /// the threads of a turn that kept running, without the timeout text.
  val theWatchdogReleasesAFinishedWorkflow: bool = match workflow.isolate.turn {
    | Running(turnRun) => and {
        turnRun.record.timedOut,
        workflow.store.workflowEnded,
        not(anyOf(turnRun.record.posts, post => post.text == TimeoutText)),
      }
    | Idle => false
  }

  /// Witness for `theWorkingStatusNeverOutlivesItsTurn`: a turn ended on a finished workflow and
  /// closed the chat thread.
  val aTurnEndsOnAFinishedWorkflow: bool = match lastTurnEnd {
    | TurnEnded(ended) => ended.chat == Closed
    | NoTurnEnd => false
  }
}
