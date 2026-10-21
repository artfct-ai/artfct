/// Where the orchestrator's posts go in one workflow, what a person's message or stop in a
/// tracker session reaches, and what each author's session feed shows there. The surfaces are the
/// chat threads, the starting session, and the sessions the tracker opens on the issues of jobs.
/// Each action is one step of the orchestrator that runs to its end before the next event lands,
/// unless the Durable Object restarts while the step's last feed activity is out.
/// An agent turn folds into one step that takes the inbox and posts its answer, its question, or
/// the timeout text. Every sandbox that waits comes up at the end of a step, so an author that
/// starts or restarts is in its turn when the next step begins. Prompt text, model output and the
/// order of the reply targets are left out.
module sessionRoutingTypes {
  /// The subject issue of the workflow, and one of its sub-issues. Under a project subject, the
  /// project holds both.
  type Issue = SubjectIssue | SubIssue

  /// The subject of the workflow: none yet, the subject issue, or the tracker project. A tracker
  /// origin sets the subject issue. A chat workflow's plan names one later.
  type Subject = NoSubject | IssueSubject | ProjectSubject

  /// A reply target: a chat thread by number, or the tracker session on one issue. Thread 0 is
  /// the chat thread a chat workflow started from. Thread 1 joins later. Without a chat origin,
  /// the session on the subject issue is the starting session.
  type Target = ChatThread(int) | Session(Issue)

  /// The author of a job. `NotStarted` is a job whose author does not exist yet, because its
  /// researcher runs or was cancelled. `InTurn` is an author with a prompt out. `Idle` is a
  /// working author between turns. `InReview` is an author whose artifact is out and who is not
  /// at work. `Finished` covers failed and cancelled.
  type AuthorStatus = NotStarted | InTurn | Idle | InReview | Finished

  /// A prompt queued for an author: a person's instruction, or another prompt.
  type QueuedPrompt = Instruction | OtherPrompt

  /// A todo list of `TODO_ENTRIES` entries, by how many of them are complete.
  type TodoList = NoTodos | Todos(int)

  /// The researcher of a job, in a workflow whose stage researches first.
  type Research = NoResearch | Researching | Researched | ResearchCancelled | ResearchFailed

  /// A job on one issue. `queued` lists the prompts that wait for the author's next turn, oldest
  /// first. `holdsInstruction` holds while a harness author's turn runs on a person's instruction,
  /// which stays in the queue until that turn ends and waits again when it is cancelled.
  /// `handedOver` holds once its artifact went to the humans. `buffered` holds while the session
  /// feed keeps a message of the author's turn for the closing reply. `nudged` and `stoppedEarly`
  /// are the stall marks of the author's sandbox. `restarts` counts the fresh sandboxes of the
  /// job's current task: its researcher, then its author. `containerClosed` holds while an idle
  /// author waits without a container, since a stop closed it. `paused` holds while
  /// the author is paused, so its prompts wait for its resume. `cancelSent` holds while the
  /// author's turn runs after a pause sent the harness a cancel.
  type Job = {
    issue: Issue,
    author: AuthorStatus,
    queued: List[QueuedPrompt],
    holdsInstruction: bool,
    handedOver: bool,
    buffered: bool,
    todos: TodoList,
    restarts: int,
    nudged: bool,
    stoppedEarly: bool,
    containerClosed: bool,
    paused: bool,
    cancelSent: bool,
    research: Research,
    researcherTodos: TodoList,
  }

  /// The kind of an orchestrator post. `InfoPost` is plain text, such as an answer or a reply to
  /// a person who wrote to a finished workflow. `TurnFailedPost` is the timeout text.
  type PostKind =
    | QuestionPost
    | ArtifactReadyPost
    | FailedPost
    | WorkflowFailedPost
    | DonePost
    | StatusPost
    | InfoPost
    | TurnFailedPost

  /// One post and the reply targets it reached.
  type Post = { kind: PostKind, targets: Set[Target] }

  /// The kind of a closing in the feed. `ReplyActivity` is a response that holds the author's last
  /// message, and `DoneActivity` is the response without one. `StoppedActivity` is the stopped
  /// reply. `NarratedAccount` is the author's last message as narration, a persistent thought,
  /// when the author goes straight into its next turn. The spec does not model the other thoughts
  /// of the feed, receipts and heartbeats. The narration before a tool call is the author's
  /// `FeedNarration`.
  type FeedKind = ReplyActivity | DoneActivity | StoppedActivity | ErrorActivity | NarratedAccount

  /// One feed activity in the job session of a job, and how many activities the tracker stored
  /// across the attempts to post it.
  type FeedPost = { job: int, kind: FeedKind, stored: int }

  /// How the tracker answers an activity: it stores it, it fails before storing it, or it stores
  /// it and then fails. On the last two arms the Durable Object restarts while the first attempt
  /// is out, before or after the tracker stores the activity.
  type TrackerHealth =
    | TrackerUp
    | FailsBeforeStoring
    | FailsAfterStoring
    | RestartsBeforeStoring
    | RestartsAfterStoring

  /// What a person types in a session: a question, a status request, or the verbal command
  /// "pause" or "cancel".
  type SessionText = Question | StatusRequest | PauseCommand | CancelCommand

  /// How an agent turn ends: closing text that answers, a question, or the watchdog's timeout text.
  type TurnOutcome = Answers | Asks | TimesOut

  /// What an author streams in its turn: a message, or a tool call.
  type Streamed = Message | ToolCall

  /// How an author's turn ends. The first four end the turn on its own, with closing text that the
  /// decisions model reads as finished, without a word, as stopped early, or as giving up.
  /// `PromptFails` is a harness error answer to the prompt. `Cancelled` is the harness answer to
  /// the cancel a pause sent.
  type TurnEnding = Replies | EndsSilently | StopsEarly | GivesUp | PromptFails | Cancelled

  /// How a researcher's turn ends without a payload its author may take: it left none, it gave
  /// up, or the harness stopped it on a limit, such as max tokens or a refusal. The last two may
  /// leave a payload behind.
  type ResearchEnding = LeavesNoPayload | ResearcherGivesUp | StopsOnALimit

  /// How the agent ends the workflow.
  type Ending = Finishes | Fails

  /// A board of one job in one chat thread.
  type Board = { job: int, thread: int }

  /// The workflow as routing sees it. `waiting` holds where the people who wrote since the last
  /// agent turn wait for its answer. `links` holds the issue of each request to link an issue to
  /// the chat thread, in the order they went out. `waitsForInput` holds while the workflow sleeps
  /// on a question to the humans.
  type Routing = {
    subject: Subject,
    replyTargets: Set[Target],
    jobs: List[Job],
    waiting: Set[Target],
    links: List[Issue],
    boards: Set[Board],
    waitsForInput: bool,
    ended: bool,
  }

  /// Where a person wrote in this step, and what they wrote.
  type Wrote = NobodyWrote | WroteIn({ issue: Issue, text: SessionText })

  /// What one step did. `answered` holds where the people its agent turn answers wrote from.
  /// `woke` holds when a person's message waits for an agent turn. `feed` holds the feed
  /// activities in order, and `plans` the session of each session plan set. `turnEnded` holds the
  /// jobs whose author's turn ended, and `cancelled` those whose turn ended on a cancel.
  /// `stoppedIn` holds the issue of a session where a person pressed Stop. `health` is how the
  /// tracker answered the step's feed activities. `researchEnded` holds each researcher turn that
  /// ended without a payload its author may take. `startRefusedBesideTheIssuesJob` holds when a
  /// job start names an issue whose job is not over and is refused. `accounts` holds the jobs
  /// whose author's turn ended on its own while the feed kept the author's last message, the
  /// turn's closing account. `feedClosed` holds the jobs whose author's feed closed, and
  /// `narrationLines` those whose author's tool call made its message a narration line.
  /// `replyAlarmFired` holds the job of a closing reply whose alarm fired, and `anHourPassed`
  /// holds when the clock moved an hour. `held` holds each closing reply that waits on its alarm
  /// behind narration the tracker failed, without a post. `folded` holds the closing replies that
  /// folded into the narration.
  type StepFacts = {
    wrote: Wrote,
    answered: Set[Target],
    posts: List[Post],
    woke: bool,
    feed: List[FeedPost],
    plans: List[Issue],
    turnEnded: Set[int],
    cancelled: Set[int],
    stoppedIn: Set[Issue],
    health: TrackerHealth,
    researchEnded: Set[{ job: int, ending: ResearchEnding }],
    startRefusedBesideTheIssuesJob: bool,
    accounts: Set[int],
    feedClosed: Set[int],
    narrationLines: Set[int],
    replyAlarmFired: Set[int],
    anHourPassed: bool,
    held: List[FeedPost],
    folded: Set[int],
  }

  /// Whether the last step kept each rule that spans a step.
  type KeptRules = {
    orchestratorStaysOutOfSessionsWhenChatExists: bool,
    linearOnlyAsksReachTheStartingSession: bool,
    sessionMessageReachesItsRunningAuthorSilently: bool,
    sessionMessageWithoutAnAuthorIsAnswered: bool,
    sessionFeedEndsWhenItsAuthorIdles: bool,
    feedActivityPostsOnce: bool,
    chatWorkflowNeverSetsASessionPlan: bool,
    sessionPlanSetsOnlyWhenATurnEnds: bool,
    todoListIsFixedAfterFirstArtifact: bool,
    aStopAnswersOnlyInTheFeed: bool,
    aResearcherThatDidNotFinishRestartsOrFails: bool,
    aTurnEndNeverDropsItsAccount: bool,
    aClosingReplyNeverOvertakesAnEarlierOne: bool,
  }

  /// The state of one step and the feed activities and posts of the turn end that led to it.
  type TurnEnd = { state: Routing, feed: List[FeedPost], posts: List[Post] }

  /// The state after one step and the facts of that step.
  type StepResult = { state: Routing, facts: StepFacts }

  /// The deliveries of a message a person sent in a session that waits on the workflow's idle
  /// clock before it lands: how many are in flight, whether the tracker still owes one after a
  /// restart failed one, and how many times the message landed. The workflow marks it seen when
  /// it lands.
  type SessionMessage = { inFlight: int, owed: bool, landed: int }

  /// A session message that has not landed yet: where and what a person wrote, and whether a
  /// restart failed a delivery of it.
  type MessageToLand = { issue: Issue, text: SessionText, failedByARestart: bool }

  /// Whether the last step landed a message the tracker delivered again after a restart, or
  /// dropped a second delivery of a message that landed.
  type DeliveryWitnesses = { aRedeliveredMessageLands: bool, aSecondDeliveryIsDropped: bool }

  /// A closing reply whose post an instance restart or a tracker failure cut: its job, its kind,
  /// how many activities the tracker stored under its activity id, whether its alarm is still
  /// armed, whether its alarm gave up before the tracker stored it, whether it folded into the
  /// narration of its author, and whether an hour has passed since its turn ended.
  type CutClosingReply = { job: int, kind: FeedKind, stored: int, armed: bool, gaveUp: bool, folded: bool, pastItsHour: bool }

  /// The narration of a job's author: whether lines wait to post, and whether the last post was
  /// within the narration interval, so a line after a tool call waits for a later post.
  type FeedNarration = { waits: bool, postedLately: bool }
}

/// Routing in a workflow that starts from a chat thread or from a tracker session.
module sessionRouting {
  import sessionRoutingTypes.*

  /// True when the workflow started from a chat thread, false when it started from the tracker
  /// session on its subject issue.
  const STARTS_IN_CHAT: bool

  /// True when each job's stage runs a researcher before its harness author.
  const RESEARCH: bool

  /// True when the author of each job is a model call, false for a harness author.
  const MODEL_AUTHOR: bool

  /// How many jobs the workflow starts at most.
  pure val MAX_JOBS: int = 3

  /// How many fresh sandboxes a task gets before it fails, as `MAX_RESTARTS`.
  pure val MAX_RESTARTS: int = 2

  /// How many times the notifier tries one feed activity, as `FEED_POST_ATTEMPTS`.
  pure val FEED_POST_ATTEMPTS: int = 3

  /// How many entries a todo list holds.
  pure val TODO_ENTRIES: int = 3

  /// The id the notifier gives one feed activity. It sends the same id with every attempt.
  pure val ACTIVITY_ID: int = 0

  /// The chat thread that joins later.
  pure val JOINED_THREAD: Target = ChatThread(1)

  /// The session the workflow started from, in a workflow that started from the tracker.
  pure val STARTING_SESSION: Target = Session(SubjectIssue)

  pure val ISSUES: Set[Issue] = Set(SubjectIssue, SubIssue)

  pure val JOB_SLOTS: Set[int] = 0.to(MAX_JOBS - 1)

  pure val HEALTHS: Set[TrackerHealth] = Set(TrackerUp, FailsBeforeStoring, FailsAfterStoring)

  /// The tracker fails every attempt of a feed activity, after it stores the activity or before.
  pure val TRACKER_FAILURES: Set[TrackerHealth] = Set(FailsBeforeStoring, FailsAfterStoring)

  /// The restarts of the Durable Object while a feed activity is out.
  pure val RESTARTS_MID_POST: Set[TrackerHealth] = Set(RestartsBeforeStoring, RestartsAfterStoring)

  pure val RESEARCH_ENDINGS: Set[ResearchEnding] = Set(LeavesNoPayload, ResearcherGivesUp, StopsOnALimit)

  /// What a person types in a session. The spec does not pause a researcher or a model-call
  /// author, so those setups do not take "pause".
  pure val SESSION_TEXTS: Set[SessionText] =
    if (RESEARCH or MODEL_AUTHOR) Set(Question, StatusRequest, CancelCommand)
    else Set(Question, StatusRequest, PauseCommand, CancelCommand)

  /// The todo lists a step reports: one with an open entry, and one that reads complete.
  pure val REPORTED_TODOS: Set[TodoList] = Set(Todos(1), Todos(TODO_ENTRIES))

  pure val ORIGIN: Target = if (STARTS_IN_CHAT) ChatThread(0) else STARTING_SESSION

  /// A tracker origin sets the subject issue. A chat workflow starts without a subject.
  pure val INITIAL_ROUTING: Routing = {
    subject: if (STARTS_IN_CHAT) NoSubject else IssueSubject,
    replyTargets: Set(ORIGIN),
    jobs: List(),
    waiting: Set(),
    links: List(),
    boards: Set(),
    waitsForInput: false,
    ended: false,
  }

  pure val NO_FACTS: StepFacts = {
    wrote: NobodyWrote,
    answered: Set(),
    posts: List(),
    woke: false,
    feed: List(),
    plans: List(),
    turnEnded: Set(),
    cancelled: Set(),
    stoppedIn: Set(),
    health: TrackerUp,
    researchEnded: Set(),
    startRefusedBesideTheIssuesJob: false,
    accounts: Set(),
    feedClosed: Set(),
    narrationLines: Set(),
    replyAlarmFired: Set(),
    anHourPassed: false,
    held: List(),
    folded: Set(),
  }

  /// The narration of an author that has not narrated.
  pure val QUIET_NARRATION: FeedNarration = { waits: false, postedLately: false }

  pure val NO_DELIVERY_WITNESSES: DeliveryWitnesses = {
    aRedeliveredMessageLands: false,
    aSecondDeliveryIsDropped: false,
  }

  var routing: Routing
  var lastStepKept: KeptRules
  var lastStep: StepFacts

  /// The deliveries of each session message that waits on the idle clock, by the order they were
  /// sent.
  var sessionMessages: int -> SessionMessage

  /// The session messages that have not landed yet.
  var messagesToLand: int -> MessageToLand

  /// What the last step did with a delivery of a session message.
  var lastDelivery: DeliveryWitnesses

  /// The closing replies whose post an instance restart or a tracker failure cut, by the order of
  /// the cuts.
  var cutClosingReplies: int -> CutClosingReply

  /// The narration of each job's author.
  var feedNarration: int -> FeedNarration

  pure def isChatThread(target: Target): bool = match target {
    | ChatThread(_) => true
    | Session(_) => false
  }

  pure def isSession(target: Target): bool = not(isChatThread(target))

  pure def chatThreads(state: Routing): Set[Target] = state.replyTargets.filter(isChatThread)

  /// The number of each chat thread among the reply targets.
  pure def chatThreadNumbers(state: Routing): Set[int] =
    state.replyTargets.fold(Set(), (numbers, target) => match target {
      | ChatThread(thread) => numbers.union(Set(thread))
      | Session(_) => numbers
    })

  pure def hasChat(state: Routing): bool = chatThreads(state).size() > 0

  pure def sessionsOf(targets: Set[Target]): Set[Target] = targets.filter(isSession)

  pure def hasSession(state: Routing, issue: Issue): bool = state.replyTargets.contains(Session(issue))

  /// True for a post that asks a person to act or tells them work failed.
  pure def isAskOrFailure(kind: PostKind): bool =
    Set(QuestionPost, ArtifactReadyPost, FailedPost, WorkflowFailedPost, TurnFailedPost).contains(kind)

  /// `recipientsOf` for a post to the workflow's audience that answers the people who wrote from
  /// `answering`. With a chat thread, it reaches every chat thread. Without one, the starting
  /// session gets each ask and failure, and each session a person wrote from gets the post.
  pure def audienceTargets(state: Routing, kind: PostKind, answering: Set[Target]): Set[Target] =
    if (hasChat(state)) chatThreads(state)
    else {
      val starting = if (not(STARTS_IN_CHAT) and isAskOrFailure(kind)) Set(STARTING_SESSION) else Set()
      starting.union(sessionsOf(answering))
    }

  /// `recipientsOf` for a reply to one person where they wrote. A session's reply goes to the chat
  /// threads when the workflow has one.
  pure def replyTargetsOf(state: Routing, target: Target): Set[Target] =
    if (isSession(target) and hasChat(state)) chatThreads(state) else Set(target)

  pure def post(state: Routing, kind: PostKind, answering: Set[Target]): Post =
    { kind: kind, targets: audienceTargets(state, kind, answering) }

  /// True for the issue that is the subject itself, not one under a project subject.
  pure def isSubjectItself(state: Routing, issue: Issue): bool =
    state.subject == IssueSubject and issue == SubjectIssue

  pure def linksOf(state: Routing, issue: Issue): int =
    state.links.foldl(0, (count, linked) => if (linked == issue) count + 1 else count)

  pure def isAuthorUnfinished(job: Job): bool =
    job.author == InTurn or job.author == Idle or job.author == InReview

  /// A job is over once its author finished, or once its researcher was cancelled or failed
  /// before the author existed.
  pure def isUnfinished(job: Job): bool = isAuthorUnfinished(job) or job.research == Researching

  /// The `BUSY` statuses of `onIdle`: an author that runs, or a researcher.
  pure def isBusy(job: Job): bool = job.author == InTurn or job.author == Idle or job.research == Researching

  pure def hasAuthor(job: Job): bool = job.author != NotStarted

  pure def isOpen(list: TodoList): bool = match list {
    | NoTodos => false
    | Todos(done) => done < TODO_ENTRIES
  }

  /// `completeTodos`: every entry of a reported list reads complete.
  pure def completed(list: TodoList): TodoList = match list {
    | NoTodos => NoTodos
    | Todos(_) => Todos(TODO_ENTRIES)
  }

  pure def jobIds(state: Routing): Set[int] = JOB_SLOTS.filter(id => id < state.jobs.length())

  pure def jobsOn(state: Routing, issue: Issue): Set[int] = jobIds(state).filter(id => state.jobs[id].issue == issue)

  /// `jobByIssue`: the last job on the issue, if any.
  pure def lastJobOn(state: Routing, issue: Issue): Set[int] = {
    val onIssue = jobsOn(state, issue)
    onIssue.filter(id => onIssue.forall(other => other <= id))
  }

  pure def unfinishedJobs(state: Routing): Set[int] = jobIds(state).filter(id => isUnfinished(state.jobs[id]))

  /// `authorInSession`: among the jobs on the session's issue that have an author, the one whose
  /// author is unfinished, else the last one.
  pure def sessionJob(state: Routing, issue: Issue): Set[int] = {
    val authored = jobsOn(state, issue).filter(id => hasAuthor(state.jobs[id]))
    val unfinished = authored.filter(id => isAuthorUnfinished(state.jobs[id]))
    val last = authored.filter(id => authored.forall(other => other <= id))
    if (unfinished.size() > 0) unfinished else last
  }

  /// `runningAuthorInSession`: the job whose author is queued, provisioning or working in the
  /// session of the issue, if any.
  pure def runningSessionJob(state: Routing, issue: Issue): Set[int] =
    sessionJob(state, issue).filter(id => state.jobs[id].author == InTurn or state.jobs[id].author == Idle)

  pure def withJob(state: Routing, id: int, change: Job => Job): Routing =
    { ...state, jobs: state.jobs.replaceAt(id, change(state.jobs[id])) }

  /// A board flush writes the job's board in every chat thread among the reply targets.
  pure def flushBoard(state: Routing, id: int): Routing =
    { ...state, boards: state.boards.union(chatThreadNumbers(state).map(thread => { job: id, thread: thread })) }

  pure def addTarget(state: Routing, target: Target): Routing =
    { ...state, replyTargets: state.replyTargets.union(Set(target)) }

  /// How many activities the tracker holds after the notifier's attempts to post one. Each
  /// attempt sends `ACTIVITY_ID`, and the notifier stops at the first attempt that succeeds. A
  /// restart ends the attempts.
  pure def storedAcrossAttempts(health: TrackerHealth): int = {
    val attempts = 1.to(FEED_POST_ATTEMPTS).fold({ stored: Set(), over: false }, (tries, _) =>
      if (tries.over) tries
      else match health {
        | TrackerUp => { stored: tries.stored.union(Set(ACTIVITY_ID)), over: true }
        | FailsBeforeStoring => tries
        | FailsAfterStoring => { ...tries, stored: tries.stored.union(Set(ACTIVITY_ID)) }
        | RestartsBeforeStoring => { ...tries, over: true }
        | RestartsAfterStoring => { stored: tries.stored.union(Set(ACTIVITY_ID)), over: true }
      })
    attempts.stored.size()
  }

  /// `notifier.feed`: an activity in the job session of the job, when the job has one.
  pure def feedOf(state: Routing, id: int, kind: FeedKind, health: TrackerHealth): List[FeedPost] =
    if (hasSession(state, state.jobs[id].issue)) List({ job: id, kind: kind, stored: storedAcrossAttempts(health) })
    else List()

  /// `publishSessionPlan` when the author's turn ends: the author's todo list goes to its job
  /// session as the session plan, unless the workflow has a chat thread.
  pure def planOf(state: Routing, id: int): List[Issue] = {
    val job = state.jobs[id]
    if (not(hasChat(state)) and hasSession(state, job.issue) and job.todos != NoTodos) List(job.issue)
    else List()
  }

  /// The closing reply of a turn that ended on its own: the author's last message, or "Done.".
  pure def replyClosing(job: Job): FeedKind = if (job.buffered) ReplyActivity else DoneActivity

  /// `closeSessionFeed`: the feed of the author forgets the message of the turn.
  pure def forgetMessage(job: Job): Job = { ...job, buffered: false }

  /// The author says its closing text. The feed keeps it while the author has a job session.
  pure def says(state: Routing, id: int): Routing =
    withJob(state, id, job => { ...job, buffered: job.buffered or hasSession(state, job.issue) })

  pure def feedOfJob(facts: StepFacts, id: int): List[FeedPost] = facts.feed.select(posted => posted.job == id)

  pure def lastFeedIs(facts: StepFacts, id: int, accepted: FeedKind => bool): bool = {
    val posts = feedOfJob(facts, id)
    posts.length() > 0 and accepted(posts[posts.length() - 1].kind)
  }

  /// The sessions a step's posts may reach without a chat thread: the starting session for an ask
  /// or failure, and the sessions of the people the step answers.
  pure def allowedSessions(facts: StepFacts, kind: PostKind): Set[Target] = {
    val starting = if (not(STARTS_IN_CHAT) and isAskOrFailure(kind)) Set(STARTING_SESSION) else Set()
    val wroteHere = match facts.wrote {
      | WroteIn(wrote) => Set(Session(wrote.issue))
      | NobodyWrote => Set()
    }
    starting.union(sessionsOf(facts.answered)).union(wroteHere)
  }

  pure def postsOf(facts: StepFacts): Set[Post] = facts.posts.foldl(Set(), (found, posted) => found.union(Set(posted)))

  /// With a chat thread, no post reaches a tracker session.
  pure def staysOutOfSessions(after: Routing, facts: StepFacts): bool =
    hasChat(after) implies postsOf(facts).forall(posted => sessionsOf(posted.targets).size() == 0)

  /// Without a chat thread, each ask and failure reaches the starting session, and a session gets
  /// any other post only when a person wrote there.
  pure def asksReachTheStartingSession(after: Routing, facts: StepFacts): bool =
    not(hasChat(after)) implies postsOf(facts).forall(posted => and {
      (not(STARTS_IN_CHAT) and isAskOrFailure(posted.kind)) implies posted.targets.contains(STARTING_SESSION),
      sessionsOf(posted.targets).subseteq(allowedSessions(facts, posted.kind)),
    })

  /// A person's message in the job session of a running author is a prompt for that author: it
  /// is queued during a turn or while the author is paused, and it starts the next turn of any
  /// other idle author. The step posts nothing and does not wake the agent.
  pure def reachesRunningAuthorSilently(before: Routing, after: Routing, facts: StepFacts): bool =
    match facts.wrote {
      | WroteIn(wrote) =>
          runningSessionJob(before, wrote.issue).forall(id => and {
            not(before.ended),
            if (before.jobs[id].author == Idle and not(before.jobs[id].paused)) after.jobs[id].author == InTurn
            else after.jobs[id].queued.length() == before.jobs[id].queued.length() + 1,
            facts.posts.length() == 0,
            not(facts.woke),
          })
      | NobodyWrote => true
    }

  pure def reaches(state: Routing, targets: Set[Target], wrote: Target): bool =
    if (hasChat(state)) chatThreads(state).subseteq(targets) and targets.size() > 0
    else targets.contains(wrote)

  /// A person's message in a session without a running author waits for an agent turn. Once the
  /// workflow ended, a status request or a verbal command gets a reply. Before the end, a verbal
  /// command gets its reply, or waits for an agent turn when it did not run. An agent turn's post reaches each session it answers, or the chat
  /// threads.
  pure def withoutAnAuthorIsAnswered(before: Routing, after: Routing, facts: StepFacts): bool = and {
    match facts.wrote {
      | WroteIn(wrote) =>
          runningSessionJob(before, wrote.issue).size() == 0 implies {
            val replied = postsOf(facts).exists(posted => reaches(after, posted.targets, Session(wrote.issue)))
            val waits = facts.woke and after.waiting.contains(Session(wrote.issue))
            if (before.ended and wrote.text != Question) replied
            else match wrote.text {
              | PauseCommand => replied or waits
              | CancelCommand => replied or waits
              | _ => waits
            }
          }
      | NobodyWrote => true
    },
    sessionsOf(facts.answered).forall(session =>
      postsOf(facts).exists(posted => reaches(after, posted.targets, session))),
  }

  /// True when the closing reply of the job waits on its alarm behind narration the tracker
  /// failed, and is of an accepted kind.
  pure def heldIs(facts: StepFacts, id: int, accepted: FeedKind => bool): bool =
    facts.held.select(posted => posted.job == id and accepted(posted.kind)).length() > 0

  /// Each author whose turn ended and who idles unfinished in its job session ends its feed on a
  /// response or an error, or holds it on its alarm behind narration the tracker failed.
  pure def feedEndsWhenItsAuthorIdles(after: Routing, facts: StepFacts): bool =
    facts.turnEnded.forall(id => {
      val job = after.jobs[id]
      val idlesInSession = (job.author == Idle or job.author == InReview) and hasSession(after, job.issue)
      idlesInSession implies (feedOfJob(facts, id).length() > 0 or heldIs(facts, id, _ => true))
    })

  /// Each turn that ended on its own with a closing account posts it. An author that idles in its
  /// job session ends the feed on the reply that holds it. An author that goes straight into its
  /// next turn in the same sandbox posts it as narration. A restart or a failure ends the turn on
  /// its own terms.
  pure def turnEndKeepsItsAccount(before: Routing, after: Routing, facts: StepFacts): bool =
    facts.accounts.forall(id => {
      val job = after.jobs[id]
      val idles = job.author == Idle or job.author == InReview
      val goesStraightOn = job.author == InTurn and job.restarts == before.jobs[id].restarts
      and {
        idles implies lastFeedIs(facts, id, kind => kind == ReplyActivity),
        goesStraightOn implies feedOfJob(facts, id).select(posted => posted.kind == NarratedAccount).length() > 0,
      }
    })

  /// The tracker holds each feed activity at most once, whatever the retries.
  pure def postsOnce(facts: StepFacts): bool = facts.feed.foldl(true, (once, posted) => once and posted.stored <= 1)

  /// With a chat thread, no step sets a session plan.
  pure def neverSetsASessionPlan(after: Routing, facts: StepFacts): bool =
    hasChat(after) implies facts.plans.length() == 0

  /// A step sets a session plan only in the job session of an author whose turn ended in it, and
  /// at most once for each such turn.
  pure def plansOnlyAtATurnEnd(after: Routing, facts: StepFacts): bool = and {
    facts.plans.length() <= facts.turnEnded.size(),
    facts.plans.foldl(true, (only, issue) => only and facts.turnEnded.exists(id => after.jobs[id].issue == issue)),
  }

  /// Only an author records an artifact. Once its job holds one, the author's todo list stays.
  pure def todosFixedAfterArtifact(before: Routing, after: Routing): bool = and {
    jobIds(after).forall(id => after.jobs[id].handedOver implies hasAuthor(after.jobs[id])),
    jobIds(before).forall(id => before.jobs[id].handedOver implies after.jobs[id].todos == before.jobs[id].todos),
  }

  /// A stop keeps the workflow status, posts nothing, and ends the feed of the session's author
  /// on the stopped reply, or holds that reply on its alarm behind narration the tracker failed.
  /// A cancelled turn that leaves its author idle in its job session ends the feed the same way.
  pure def stopAnswersOnlyInTheFeed(before: Routing, after: Routing, facts: StepFacts): bool = and {
    facts.stoppedIn.forall(issue => and {
      after.ended == before.ended,
      after.waitsForInput == before.waitsForInput,
      facts.posts.length() == 0,
      sessionJob(before, issue).forall(id =>
        lastFeedIs(facts, id, kind => kind == StoppedActivity) or heldIs(facts, id, kind => kind == StoppedActivity)),
    }),
    facts.cancelled.forall(id => {
      val job = after.jobs[id]
      val idlesInSession = (job.author == Idle or job.author == InReview) and hasSession(after, job.issue)
      idlesInSession implies lastFeedIs(facts, id, kind => kind == StoppedActivity)
    }),
  }

  /// A researcher turn that ended without a payload its author may take does not start the
  /// author. The researcher counts one restart, or fails once its restarts are used up.
  pure def unfinishedResearchRestartsOrFails(before: Routing, after: Routing, facts: StepFacts): bool =
    facts.researchEnded.forall(ended => {
      val job = before.jobs[ended.job]
      val afterwards = after.jobs[ended.job]
      and {
        not(hasAuthor(afterwards)),
        if (job.restarts < MAX_RESTARTS) afterwards.research == Researching and afterwards.restarts == job.restarts + 1
        else afterwards.research == ResearchFailed,
      }
    })

  /// As a job's feed closes, every closing reply of the job that waited on its alarm folds into
  /// the narration, so no closing lands ahead of an earlier one.
  pure def noReplyOvertakes(
    facts: StepFacts,
    repliesBefore: int -> CutClosingReply,
    repliesAfter: int -> CutClosingReply,
  ): bool =
    facts.feedClosed.forall(id => repliesBefore.keys().forall(reply => {
      val cut = repliesBefore.get(reply)
      (cut.job == id and cut.armed) implies not(repliesAfter.get(reply).armed)
    }))

  pure def rulesKeptBy(
    before: Routing,
    after: Routing,
    facts: StepFacts,
    repliesBefore: int -> CutClosingReply,
    repliesAfter: int -> CutClosingReply,
  ): KeptRules = {
    orchestratorStaysOutOfSessionsWhenChatExists: staysOutOfSessions(after, facts),
    linearOnlyAsksReachTheStartingSession: asksReachTheStartingSession(after, facts),
    sessionMessageReachesItsRunningAuthorSilently: reachesRunningAuthorSilently(before, after, facts),
    sessionMessageWithoutAnAuthorIsAnswered: withoutAnAuthorIsAnswered(before, after, facts),
    sessionFeedEndsWhenItsAuthorIdles: feedEndsWhenItsAuthorIdles(after, facts),
    feedActivityPostsOnce: postsOnce(facts),
    chatWorkflowNeverSetsASessionPlan: neverSetsASessionPlan(after, facts),
    sessionPlanSetsOnlyWhenATurnEnds: plansOnlyAtATurnEnd(after, facts),
    todoListIsFixedAfterFirstArtifact: todosFixedAfterArtifact(before, after),
    aStopAnswersOnlyInTheFeed: stopAnswersOnlyInTheFeed(before, after, facts),
    aResearcherThatDidNotFinishRestartsOrFails: unfinishedResearchRestartsOrFails(before, after, facts),
    aTurnEndNeverDropsItsAccount: turnEndKeepsItsAccount(before, after, facts),
    aClosingReplyNeverOvertakesAnEarlierOne: noReplyOvertakes(facts, repliesBefore, repliesAfter),
  }

  pure def narrationOf(narration: int -> FeedNarration, id: int): FeedNarration =
    if (narration.keys().contains(id)) narration.get(id) else QUIET_NARRATION

  /// `foldWaitingClosingReplies` as a feed closes: the armed closing replies of the jobs whose
  /// feed closed.
  pure def foldedAtClose(replies: int -> CutClosingReply, facts: StepFacts): Set[int] =
    replies.keys().filter(reply => replies.get(reply).armed and facts.feedClosed.contains(replies.get(reply).job))

  /// Whether narration waits for the author as the step posts it: it waited, or the step added a
  /// line, a folded closing reply, or the closing account.
  pure def narrationWaitsBeforeItsPost(
    narration: int -> FeedNarration,
    replies: int -> CutClosingReply,
    facts: StepFacts,
    id: int,
  ): bool = or {
    narrationOf(narration, id).waits,
    facts.narrationLines.contains(id),
    foldedAtClose(replies, facts).exists(reply => replies.get(reply).job == id),
    feedOfJob(facts, id).select(posted => posted.kind == NarratedAccount).length() > 0,
  }

  /// `postWaitingNarration`: a closing feed and a closing reply's alarm post the narration that
  /// waits now. A narration line posts it once the interval since the last post has passed. A
  /// tracker failure fails the post, and the narration waits on.
  pure def narrationPosts(
    narration: int -> FeedNarration,
    replies: int -> CutClosingReply,
    facts: StepFacts,
    id: int,
  ): bool = {
    val lately = narrationOf(narration, id).postedLately and not(facts.anHourPassed)
    val attempted = or {
      facts.feedClosed.contains(id),
      facts.replyAlarmFired.contains(id),
      facts.narrationLines.contains(id) and not(lately),
    }
    and {
      narrationWaitsBeforeItsPost(narration, replies, facts, id),
      attempted,
      not(TRACKER_FAILURES.contains(facts.health)),
    }
  }

  /// `startSessionFeedTurn` and `startModelTurn`: the author's next turn starts in the step, after
  /// it was not in its turn, after its turn ended, or in a fresh sandbox.
  pure def turnStarts(before: Routing, after: Routing, facts: StepFacts, id: int): bool =
    if (after.jobs[id].author != InTurn) false
    else if (id >= before.jobs.length()) true
    else or {
      before.jobs[id].author != InTurn,
      after.jobs[id].restarts > before.jobs[id].restarts,
      facts.turnEnded.contains(id),
    }

  /// `foldWaitingClosingReplies` as a turn starts: the armed closing replies of the jobs whose
  /// author's turn starts.
  pure def foldedAtTurnStart(before: Routing, after: Routing, facts: StepFacts, replies: int -> CutClosingReply): Set[int] =
    replies.keys().filter(reply => replies.get(reply).armed and turnStarts(before, after, facts, replies.get(reply).job))

  pure def foldReplies(replies: int -> CutClosingReply, folded: Set[int]): int -> CutClosingReply =
    folded.fold(replies, (sofar, reply) => sofar.set(reply, { ...sofar.get(reply), armed: false, folded: true }))

  /// The narration of each job after the step. A closing reply that folds as a turn starts waits
  /// for a later post.
  pure def narrationAfter(
    narration: int -> FeedNarration,
    replies: int -> CutClosingReply,
    facts: StepFacts,
    after: Routing,
    foldedIntoATurn: Set[int],
  ): int -> FeedNarration =
    jobIds(after).mapBy(id => {
      val posts = narrationPosts(narration, replies, facts, id)
      {
        waits: (narrationWaitsBeforeItsPost(narration, replies, facts, id) and not(posts)) or foldedIntoATurn.contains(id),
        postedLately: (narrationOf(narration, id).postedLately and not(facts.anHourPassed)) or posts,
      }
    })

  /// One step: the state after it, its facts, and the session messages and cut closing replies
  /// after it. A closing feed folds the closing replies of its job that wait on their alarm into
  /// the narration, before its own closing. A turn start folds them after the step's cuts.
  action moveMessages(
    after: Routing,
    facts: StepFacts,
    messagesAfter: int -> SessionMessage,
    toLandAfter: int -> MessageToLand,
    delivery: DeliveryWitnesses,
    repliesAfter: int -> CutClosingReply,
  ): bool = {
    val atClose = foldedAtClose(cutClosingReplies, facts)
    val closed = foldReplies(repliesAfter, atClose)
    val atTurnStart = foldedAtTurnStart(routing, after, facts, closed)
    val folded = foldReplies(closed, atTurnStart)
    val stepFacts = { ...facts, folded: atClose.union(atTurnStart) }
    all {
      routing' = after,
      lastStepKept' = rulesKeptBy(routing, after, stepFacts, cutClosingReplies, folded),
      lastStep' = stepFacts,
      sessionMessages' = messagesAfter,
      messagesToLand' = toLandAfter,
      lastDelivery' = delivery,
      cutClosingReplies' = folded,
      feedNarration' = narrationAfter(
        feedNarration,
        cutClosingReplies,
        facts,
        after,
        atTurnStart.map(reply => closed.get(reply).job),
      ),
    }
  }

  action move(after: Routing, facts: StepFacts): bool =
    moveMessages(after, facts, sessionMessages, messagesToLand, NO_DELIVERY_WITNESSES, cutClosingReplies)

  /// The session feeds live in memory, so a restart loses every kept message.
  pure def restartedRouting(state: Routing): Routing =
    { ...state, jobs: state.jobs.foldl(List(), (jobs, job) => jobs.append(forgetMessage(job))) }

  pure def failedByTheRestart(messages: int -> SessionMessage): Set[int] =
    messages.keys().filter(message => messages.get(message).inFlight > 0)

  /// A restart fails every delivery of a session message in flight, and the tracker owes it again.
  pure def messagesAfterRestart(messages: int -> SessionMessage): int -> SessionMessage =
    messages.keys().mapBy(message => {
      val sent = messages.get(message)
      if (failedByTheRestart(messages).contains(message)) { ...sent, inFlight: 0, owed: true } else sent
    })

  pure def toLandAfterRestart(messages: int -> SessionMessage, toLand: int -> MessageToLand): int -> MessageToLand =
    toLand.keys().mapBy(message => {
      val waiting = toLand.get(message)
      { ...waiting, failedByARestart: waiting.failedByARestart or failedByTheRestart(messages).contains(message) }
    })

  /// The Durable Object restarts after the step's state is written. The alarms stay armed.
  action restartAfter(after: Routing, facts: StepFacts, repliesAfter: int -> CutClosingReply): bool =
    moveMessages(
      restartedRouting(after),
      facts,
      messagesAfterRestart(sessionMessages),
      toLandAfterRestart(sessionMessages, messagesToLand),
      NO_DELIVERY_WITNESSES,
      repliesAfter,
    )

  /// The closing replies whose post a restart or a tracker failure cut, with each closing reply of
  /// `feed` added. The alarm a closing reply armed before its post stays armed.
  pure def withCutClosingReplies(replies: int -> CutClosingReply, feed: List[FeedPost]): int -> CutClosingReply =
    feed.foldl(replies, (cut, posted) =>
      cut.put(cut.keys().size(), { job: posted.job, kind: posted.kind, stored: posted.stored, armed: true, gaveUp: false, folded: false, pastItsHour: false }))

  /// A step whose feed activities are closing replies, posted last. On a restart mid post, the
  /// step's state is written and the Durable Object restarts. The notifier does not retry the
  /// activity. When the restart or a tracker failure cuts a closing reply, its alarm stays armed.
  /// A tracker failure also fails the narration that waits, and the closing reply behind it waits
  /// on its alarm without a post.
  action moveWithFeed(after: Routing, facts: StepFacts): bool =
    if (RESTARTS_MID_POST.contains(facts.health)) all {
      facts.feed.length() == 1,
      restartAfter(after, facts, withCutClosingReplies(cutClosingReplies, facts.feed)),
    }
    else if (TRACKER_FAILURES.contains(facts.health)) {
      val heldJobs = facts.feedClosed.filter(id => narrationWaitsBeforeItsPost(feedNarration, cutClosingReplies, facts, id))
      val attempted = facts.feed.foldl(List(), (cut, posted) =>
        cut.append(if (heldJobs.contains(posted.job)) { ...posted, stored: 0 } else posted))
      moveMessages(
        after,
        {
          ...facts,
          feed: facts.feed.select(posted => not(heldJobs.contains(posted.job))),
          held: facts.feed.select(posted => heldJobs.contains(posted.job)),
        },
        sessionMessages,
        messagesToLand,
        NO_DELIVERY_WITNESSES,
        withCutClosingReplies(cutClosingReplies, attempted),
      )
    }
    else move(after, facts)

  action init: bool = all {
    routing' = INITIAL_ROUTING,
    lastStepKept' = rulesKeptBy(INITIAL_ROUTING, INITIAL_ROUTING, NO_FACTS, Map(), Map()),
    lastStep' = NO_FACTS,
    sessionMessages' = Map(),
    messagesToLand' = Map(),
    lastDelivery' = NO_DELIVERY_WITNESSES,
    cutClosingReplies' = Map(),
    feedNarration' = Map(),
  }

  /// `closingWhenTheAuthorGoesOn`: the author goes straight into its next turn, so a reply that
  /// holds its last message posts as narration. Any other closing does not post.
  pure def accountWhenGoingOn(state: Routing, id: int, closing: FeedKind): List[FeedPost] =
    if (closing == ReplyActivity) feedOf(state, id, NarratedAccount, TrackerUp) else List()

  /// `settleAndResumeAuthor` and the feed closing after it. The next queued prompt goes out, and
  /// the feed posts the turn's account as narration. Without one, or while the author is paused,
  /// the author idles, or waits in review once its artifact is out, and the feed closes on
  /// `closing`.
  pure def settleAuthor(state: Routing, id: int, closing: FeedKind): TurnEnd =
    if (state.jobs[id].queued.length() > 0 and not(state.jobs[id].paused))
      {
        state: withJob(state, id, job => takeQueuedPrompt(forgetMessage(job))),
        feed: accountWhenGoingOn(state, id, closing),
        posts: List(),
      }
    else {
      val idle = withJob(state, id, job => { ...forgetMessage(job), author: if (job.handedOver) InReview else Idle })
      { state: idle, feed: feedOf(state, id, closing, TrackerUp), posts: List() }
    }

  /// `sendPrompt` with the oldest queued prompt. A harness author's turn holds an instruction it
  /// takes.
  pure def takeQueuedPrompt(job: Job): Job =
    { ...job, queued: job.queued.tail(), holdsInstruction: not(MODEL_AUTHOR) and job.queued.head() == Instruction }

  /// `onTurnEnd` drops the instruction a turn held, unless the turn was cancelled. Then it waits
  /// again at the head of the queue.
  pure def releaseInstruction(job: Job, ending: TurnEnding): Job =
    if (job.holdsInstruction and ending == Cancelled)
      { ...job, queued: List(Instruction).concat(job.queued), holdsInstruction: false }
    else { ...job, holdsInstruction: false }

  /// `restartOrFailTask` with restarts left: the author takes its next turn in a fresh sandbox,
  /// which takes the queued wake text with its resume prompt.
  pure def restartAuthor(state: Routing, id: int): Routing =
    withJob(state, id, job => { ...forgetMessage(job), author: InTurn, queued: List(), holdsInstruction: false, restarts: job.restarts + 1, nudged: false })

  /// `failTask`: the author fails, and the workflow's audience hears it.
  pure def failAuthor(state: Routing, id: int): TurnEnd =
    { state: withJob(state, id, job => { ...forgetMessage(job), author: Finished, queued: List(), holdsInstruction: false, cancelSent: false }), feed: List(), posts: List(post(state, FailedPost, Set())) }

  /// `nudgeOrRestartStalledTask` on a stall with nothing queued. A first stall queues the nudge,
  /// which goes out at once, so the feed posts the turn's account as narration. A stall after the
  /// nudge restarts the author, whose feed closes on `closing`, or fails it once its restarts are
  /// used up.
  pure def stall(state: Routing, id: int, closing: FeedKind): TurnEnd = {
    val job = state.jobs[id]
    if (not(job.nudged))
      {
        state: withJob(state, id, author => { ...forgetMessage(author), nudged: true }),
        feed: accountWhenGoingOn(state, id, closing),
        posts: List(),
      }
    else if (job.restarts < MAX_RESTARTS)
      { state: restartAuthor(state, id), feed: feedOf(state, id, closing, TrackerUp), posts: List() }
    else failAuthor(state, id)
  }

  /// `onTurnEnd` and `onRpcError` for an author's prompt: how the turn ends, what the feed shows,
  /// and what the audience hears. A turn that ends without text has no outcome from the decisions
  /// model, so it stopped early while its todo list is open and its job has no artifact.
  pure def turnEndOf(before: Routing, id: int, ending: TurnEnding): TurnEnd = {
    val state = withJob(before, id, job => releaseInstruction(job, ending))
    match ending {
      | Replies => {
          val spoke = withJob(says(state, id), id, job => { ...job, stoppedEarly: false })
          settleAuthor(spoke, id, replyClosing(spoke.jobs[id]))
        }
      | EndsSilently => {
          val job = state.jobs[id]
          val stopsEarly = isOpen(job.todos) and not(job.handedOver)
          val ended = withJob(state, id, author => { ...author, stoppedEarly: stopsEarly })
          if (stopsEarly and job.queued.length() == 0) stall(ended, id, replyClosing(ended.jobs[id]))
          else settleAuthor(ended, id, replyClosing(ended.jobs[id]))
        }
      | StopsEarly => {
          val spoke = withJob(says(state, id), id, job => { ...job, stoppedEarly: true })
          if (spoke.jobs[id].queued.length() > 0) settleAuthor(spoke, id, replyClosing(spoke.jobs[id]))
          else stall(spoke, id, replyClosing(spoke.jobs[id]))
        }
      | GivesUp => {
          val spoke = withJob(says(state, id), id, job => { ...job, stoppedEarly: false })
          if (spoke.jobs[id].queued.length() > 0) settleAuthor(spoke, id, replyClosing(spoke.jobs[id]))
          else if (spoke.jobs[id].restarts < MAX_RESTARTS) { state: restartAuthor(spoke, id), feed: List(), posts: List() }
          else {
            val failed = failAuthor(spoke, id)
            { ...failed, feed: feedOf(spoke, id, ErrorActivity, TrackerUp) }
          }
        }
      | PromptFails => {
          val job = state.jobs[id]
          if (job.stoppedEarly and job.queued.length() == 0) stall(state, id, ErrorActivity)
          else settleAuthor(state, id, ErrorActivity)
        }
      | Cancelled =>
          settleAuthor(withJob(state, id, job => { ...job, stoppedEarly: false, cancelSent: false }), id, StoppedActivity)
    }
  }

  /// `promptTask` or `instructTask` for an author. The prompt is queued. Any author that is not
  /// paused and not in its turn takes the oldest queued prompt as its next turn, and one without a
  /// container starts a fresh one, whose start flushes the board. A prompt to an author in review starts a follow-up, which
  /// flushes the board.
  pure def promptAuthor(state: Routing, id: int, prompt: QueuedPrompt): Routing = {
    val job = state.jobs[id]
    val takes = not(job.paused) and job.author != InTurn
    val prompted = withJob(state, id, author =>
      if (takes) takeQueuedPrompt({ ...author, author: InTurn, containerClosed: false, queued: author.queued.append(prompt) })
      else { ...author, queued: author.queued.append(prompt) })
    if (job.author == InReview or (takes and job.containerClosed)) flushBoard(prompted, id) else prompted
  }

  /// `pauseTask` for an author: it is paused, its board flushes, and a turn it runs gets a cancel.
  pure def pauseAuthor(state: Routing, id: int): Routing =
    flushBoard(withJob(state, id, job => { ...job, paused: true, cancelSent: job.cancelSent or job.author == InTurn }), id)

  /// `cancelTask` for the job's author or researcher. The feed of an author with a prompt in flight
  /// or queued ends on the stopped reply, and the job's board flushes.
  pure def cancelJob(state: Routing, id: int): { state: Routing, feed: List[FeedPost] } = {
    val job = state.jobs[id]
    val abandoned = job.author == InTurn or job.queued.length() > 0
    val cancelled = withJob(state, id, current =>
      if (current.research == Researching) { ...current, research: ResearchCancelled }
      else { ...forgetMessage(current), author: Finished, queued: List(), holdsInstruction: false, containerClosed: false, cancelSent: false })
    {
      state: flushBoard(cancelled, id),
      feed: if (abandoned) feedOf(state, id, StoppedActivity, TrackerUp) else List(),
    }
  }

  /// `endWorkflow`: every unfinished author and researcher is cancelled, and the workflow ends.
  pure def cancelEveryJob(state: Routing): { state: Routing, feed: List[FeedPost] } = {
    val ended = jobIds(state).fold({ state: state, feed: List() }, (sofar, id) =>
      if (isUnfinished(sofar.state.jobs[id])) {
        val cancelled = cancelJob(sofar.state, id)
        { state: cancelled.state, feed: sofar.feed.concat(cancelled.feed) }
      }
      else sofar)
    { ...ended, state: { ...ended.state, ended: true, waitsForInput: false } }
  }

  /// The jobs of the feed activities, whose feed closed.
  pure def jobsOfFeed(feed: List[FeedPost]): Set[int] = feed.foldl(Set(), (jobs, posted) => jobs.union(Set(posted.job)))

  /// A person's message waits for the agent's next turn.
  pure def wakeTheAgent(state: Routing, issue: Issue, wrote: Wrote): StepResult =
    { state: { ...state, waiting: state.waiting.union(Set(Session(issue))) }, facts: { ...NO_FACTS, wrote: wrote, woke: true } }

  /// "pause" in a session without a running author. With one unfinished job, the author of the
  /// session's last job, or of that unfinished job, is paused, and the reply answers the person.
  /// Without a pause, nothing is posted and the agent answers.
  pure def verbalPauseIn(state: Routing, issue: Issue, wrote: Wrote): StepResult = {
    val unfinished = unfinishedJobs(state)
    val owner = if (lastJobOn(state, issue).size() > 0) lastJobOn(state, issue) else unfinished
    val pausable = owner.filter(id => isAuthorUnfinished(state.jobs[id]) and not(state.jobs[id].paused))
    if (unfinished.size() == 1 and pausable.size() > 0)
      { state: pausable.fold(state, (paused, id) => pauseAuthor(paused, id)), facts: { ...NO_FACTS, wrote: wrote, posts: List(post(state, InfoPost, Set(Session(issue)))) } }
    else wakeTheAgent(state, issue, wrote)
  }

  /// "cancel" in a session without a running author. On an issue that is not the subject itself,
  /// it cancels the last job there, unless that job is over, when the agent answers. Anywhere else
  /// it cancels the workflow. The reply answers the person.
  pure def verbalCancelIn(state: Routing, issue: Issue, wrote: Wrote): StepResult = {
    val owner = lastJobOn(state, issue)
    val reply = List(post(state, InfoPost, Set(Session(issue))))
    if (owner.size() > 0 and not(isSubjectItself(state, issue))) {
      if (owner.exists(id => isUnfinished(state.jobs[id]))) {
        val cancelled = owner.fold({ state: state, feed: List() }, (sofar, id) => {
          val one = cancelJob(sofar.state, id)
          { state: one.state, feed: sofar.feed.concat(one.feed) }
        })
        { state: cancelled.state, facts: { ...NO_FACTS, wrote: wrote, posts: reply, feed: cancelled.feed, feedClosed: jobsOfFeed(cancelled.feed) } }
      }
      else wakeTheAgent(state, issue, wrote)
    } else {
      val cancelled = cancelEveryJob(state)
      { state: cancelled.state, facts: { ...NO_FACTS, wrote: wrote, posts: reply, feed: cancelled.feed, feedClosed: jobsOfFeed(cancelled.feed) } }
    }
  }

  /// What a person's message in a session does when it lands. In the job session of a running
  /// author, the message is a prompt for that author, a verbal command too. Anywhere else a verbal
  /// command runs, and any other message wakes the agent. A message other than a status request
  /// wakes a sleeping workflow. A finished workflow answers a status request or a verbal command,
  /// and a question wakes the agent.
  pure def messageLands(state: Routing, issue: Issue, text: SessionText): StepResult = {
    val session = Session(issue)
    val wrote = WroteIn({ issue: issue, text: text })
    val running = runningSessionJob(state, issue)
    val woken = { ...state, waitsForInput: state.waitsForInput and text == StatusRequest }
    if (state.ended and text == Question) wakeTheAgent(state, issue, wrote)
    else if (state.ended) {
      val kind = if (text == StatusRequest) StatusPost else InfoPost
      val reply = { kind: kind, targets: replyTargetsOf(state, session) }
      { state: state, facts: { ...NO_FACTS, wrote: wrote, posts: List(reply) } }
    } else if (running.size() > 0) {
      { state: running.fold(woken, (prompted, id) => promptAuthor(prompted, id, Instruction)), facts: { ...NO_FACTS, wrote: wrote } }
    } else match text {
      | PauseCommand => verbalPauseIn(woken, issue, wrote)
      | CancelCommand => verbalCancelIn(woken, issue, wrote)
      | _ => wakeTheAgent(woken, issue, wrote)
    }
  }

  /// A person writes in one of the workflow's tracker sessions, and the message lands in the same
  /// step. A status request does not wait on the idle clock, and a message to a finished workflow
  /// lands at once. Any other message lands here when nothing else ran while it waited on the idle
  /// clock.
  action personWritesInSession: bool = {
    nondet issue = ISSUES.oneOf()
    nondet text = SESSION_TEXTS.oneOf()
    val landed = messageLands(routing, issue, text)
    all {
      routing.replyTargets.contains(Session(issue)),
      move(landed.state, landed.facts),
    }
  }

  /// A person writes in a session of a running workflow where no author runs on the issue, so the
  /// message wakes the agent or runs a verbal command. The step also lists `personWritesInSession`,
  /// and this copy raises how often the agent answers a person in a session.
  action aPersonWritesWhereNoAuthorRuns: bool = aPersonWritesInAQuietSessionOn(ISSUES)

  /// Like `aPersonWritesWhereNoAuthorRuns`, on the sub-issue alone. This copy raises how often a
  /// person waits for the agent in a session other than the starting one.
  action aPersonWritesInTheQuietSubIssueSession: bool = aPersonWritesInAQuietSessionOn(Set(SubIssue))

  action aPersonWritesInAQuietSessionOn(issues: Set[Issue]): bool = {
    val quietIssues = issues.filter(issue =>
      routing.replyTargets.contains(Session(issue)) and runningSessionJob(routing, issue).size() == 0)
    all {
      not(routing.ended),
      quietIssues.size() > 0,
      nondet issue = quietIssues.oneOf()
      nondet text = SESSION_TEXTS.oneOf()
      val landed = messageLands(routing, issue, text)
      move(landed.state, landed.facts),
    }
  }

  /// A person sends a message other than a status request in a session of a running workflow.
  /// Its delivery waits on the idle clock, and other steps run before it lands.
  action personSendsInSession: bool = {
    nondet issue = ISSUES.oneOf()
    nondet text = SESSION_TEXTS.exclude(Set(StatusRequest)).oneOf()
    val message = sessionMessages.keys().size()
    all {
      not(routing.ended),
      routing.replyTargets.contains(Session(issue)),
      moveMessages(
        routing,
        NO_FACTS,
        sessionMessages.put(message, { inFlight: 1, owed: false, landed: 0 }),
        messagesToLand.put(message, { issue: issue, text: text, failedByARestart: false }),
        NO_DELIVERY_WITNESSES,
        cutClosingReplies,
      ),
    }
  }

  /// A session message lands with what it does, the workflow marks it seen, and it does not wait
  /// to land any more.
  action landMessage(message: int, sent: SessionMessage): bool = {
    val toLand = messagesToLand.get(message)
    val landed = messageLands(routing, toLand.issue, toLand.text)
    moveMessages(
      landed.state,
      landed.facts,
      sessionMessages.put(message, { ...sent, landed: sent.landed + 1 }),
      messagesToLand.keys().exclude(Set(message)).mapBy(other => messagesToLand.get(other)),
      { ...NO_DELIVERY_WITNESSES, aRedeliveredMessageLands: toLand.failedByARestart },
      cutClosingReplies,
    )
  }

  /// The tracker delivers a session message again: after a restart failed a delivery of it, or
  /// while a delivery of it is in flight. A delivery of a message that landed is dropped on arrival.
  /// A finished workflow does not wait on the idle clock, so the message lands at once.
  action trackerDeliversAgain: bool = {
    nondet message = sessionMessages.keys().oneOf()
    val sent = sessionMessages.get(message)
    val delivered = { ...sent, owed: false }
    all {
      sent.owed or sent.inFlight > 0,
      if (sent.landed > 0)
        moveMessages(routing, NO_FACTS, sessionMessages.put(message, delivered), messagesToLand, { ...NO_DELIVERY_WITNESSES, aSecondDeliveryIsDropped: true }, cutClosingReplies)
      else if (routing.ended)
        landMessage(message, delivered)
      else
        moveMessages(routing, NO_FACTS, sessionMessages.put(message, { ...delivered, inFlight: sent.inFlight + 1 }), messagesToLand, NO_DELIVERY_WITNESSES, cutClosingReplies),
    }
  }

  /// One delivery of a session message in flight lands. A delivery of a message that another
  /// delivery landed wakes a sleeping workflow, since the wake comes before the seen mark, and is
  /// dropped.
  action aSessionMessageLands: bool = {
    nondet message = sessionMessages.keys().oneOf()
    val sent = sessionMessages.get(message)
    val delivered = { ...sent, inFlight: sent.inFlight - 1 }
    all {
      sent.inFlight > 0,
      if (sent.landed > 0)
        moveMessages(
          { ...routing, waitsForInput: routing.waitsForInput and routing.ended },
          NO_FACTS,
          sessionMessages.put(message, delivered),
          messagesToLand,
          { ...NO_DELIVERY_WITNESSES, aSecondDeliveryIsDropped: true },
          cutClosingReplies,
        )
      else
        landMessage(message, delivered),
    }
  }

  /// The agent's turn takes the inbox and ends: its closing text answers, it asks a question, or
  /// the watchdog posts the timeout text after the turn deadline. Each reaches the people the
  /// turn answers. A question while no job is unfinished puts the workflow to sleep.
  action agentTurnEnds: bool = {
    nondet outcome = Set(Answers, Asks, TimesOut).oneOf()
    theAgentTurnEndsWith(outcome)
  }

  /// The watchdog posts the timeout text while a person waits in the session on the sub-issue. The
  /// step also lists `agentTurnEnds`, and this copy raises how often the timeout text reaches a
  /// session other than the starting one.
  action theTurnTimesOutWhileTheSubIssueSessionWaits: bool = all {
    routing.waiting.contains(Session(SubIssue)),
    theAgentTurnEndsWith(TimesOut),
  }

  action theAgentTurnEndsWith(outcome: TurnOutcome): bool = {
    val kind = match outcome {
      | Answers => InfoPost
      | Asks => QuestionPost
      | TimesOut => TurnFailedPost
    }
    val answering = routing.waiting
    val idle = routing.jobs.foldl(true, (over, job) => over and not(isUnfinished(job)))
    all {
      not(routing.ended),
      move(
        { ...routing, waiting: Set(), waitsForInput: routing.waitsForInput or (outcome == Asks and idle) },
        { ...NO_FACTS, answered: answering, posts: List(post(routing, kind, answering)) },
      ),
    }
  }

  /// The agent starts a job on an issue of the subject. A workflow without a subject refuses it. A
  /// job on the issue that is not over, or an earlier one whose artifact the host holds, refuses
  /// it in the step. A job here ends only cancelled or failed, so a start after it is a retry. A chat
  /// workflow links the issue to its chat thread the first time a job works on it, unless the
  /// issue is the subject itself, which the plan linked. The new job's board goes to every chat
  /// thread, and the workflow runs. A researcher starts first when the stage researches. A
  /// model-call author produces its page in the step, hands it over, and ends its feed on "Done.".
  action agentStartsJob: bool = {
    nondet issue = ISSUES.oneOf()
    val onIssue = jobsOn(routing, issue)
    val id = routing.jobs.length()
    val job = {
      issue: issue,
      author: if (RESEARCH) NotStarted else if (MODEL_AUTHOR) InReview else InTurn,
      queued: List(),
      holdsInstruction: false,
      handedOver: MODEL_AUTHOR,
      buffered: false,
      todos: NoTodos,
      restarts: 0,
      nudged: false,
      stoppedEarly: false,
      containerClosed: false,
      paused: false,
      cancelSent: false,
      research: if (RESEARCH) Researching else NoResearch,
      researcherTodos: NoTodos,
    }
    val started = { ...routing, jobs: routing.jobs.append(job), waitsForInput: false }
    val linked =
      if (STARTS_IN_CHAT and onIssue.size() == 0 and not(isSubjectItself(routing, issue)))
        { ...started, links: started.links.append(issue) }
      else started
    val facts =
      if (MODEL_AUTHOR) {
        ...NO_FACTS,
        posts: List(post(linked, ArtifactReadyPost, Set())),
        feed: feedOf(linked, id, DoneActivity, TrackerUp),
        turnEnded: Set(id),
      }
      else NO_FACTS
    val inWork = onIssue.exists(other => isUnfinished(routing.jobs[other]))
    val held = onIssue.exists(other => routing.jobs[other].handedOver)
    all {
      not(routing.ended),
      routing.subject != NoSubject,
      routing.jobs.length() < MAX_JOBS,
      if (inWork or held) move(routing, { ...NO_FACTS, startRefusedBesideTheIssuesJob: inWork })
      else move(flushBoard(linked, id), facts),
    }
  }

  /// The agent's plan names the subject of a chat workflow: the subject issue, which it links to
  /// the chat thread, or the tracker project. The workflow runs.
  action agentNamesTheSubject: bool = {
    nondet subject = Set(IssueSubject, ProjectSubject).oneOf()
    val named = { ...routing, subject: subject, waitsForInput: false }
    all {
      not(routing.ended),
      routing.subject == NoSubject,
      move(if (subject == IssueSubject) { ...named, links: named.links.append(SubjectIssue) } else named, NO_FACTS),
    }
  }

  /// The tracker opens an agent session on the issue of a job. It becomes a reply target, and the
  /// orchestrator does not post in it.
  action trackerOpensSession: bool = {
    nondet issue = ISSUES.oneOf()
    all {
      jobsOn(routing, issue).size() > 0,
      not(routing.replyTargets.contains(Session(issue))),
      move(addTarget(routing, Session(issue)), NO_FACTS),
    }
  }

  /// A person mentions the agent in a new chat thread about the work. The thread becomes a reply
  /// target, and the message wakes the agent and the workflow.
  action chatThreadJoins: bool = all {
    not(routing.ended),
    not(routing.replyTargets.contains(JOINED_THREAD)),
    val joined = addTarget(routing, JOINED_THREAD)
    move({ ...joined, waiting: joined.waiting.union(Set(JOINED_THREAD)), waitsForInput: false }, { ...NO_FACTS, woke: true }),
  }

  pure def inTurn(state: Routing, id: int): bool = id < state.jobs.length() and state.jobs[id].author == InTurn

  /// An author in its turn streams. The feed keeps a message for the closing reply. A tool call
  /// starts the message over and shows progress. A tool call does not post, and the message
  /// before it becomes a narration line.
  action authorStreams: bool = {
    nondet id = JOB_SLOTS.oneOf()
    nondet streamed = Set(Message, ToolCall).oneOf()
    all {
      inTurn(routing, id),
      match streamed {
        | Message => move(says(routing, id), NO_FACTS)
        | ToolCall =>
            move(
              withJob(routing, id, job => { ...forgetMessage(job), nudged: false }),
              { ...NO_FACTS, narrationLines: if (routing.jobs[id].buffered) Set(id) else Set() },
            )
      },
    }
  }

  /// An author in its turn reports its todo list, which shows progress. The list is stored unless
  /// the job's artifact is out. The job session gets it as its plan when the turn ends.
  action authorReportsTodos: bool = {
    nondet id = JOB_SLOTS.oneOf()
    nondet todos = REPORTED_TODOS.oneOf()
    all {
      inTurn(routing, id),
      val shown = withJob(routing, id, job => { ...job, nudged: false })
      if (routing.jobs[id].handedOver) move(shown, NO_FACTS)
      else {
        move(withJob(shown, id, job => { ...job, todos: todos }), NO_FACTS)
      },
    }
  }

  /// An author in its turn prints the link of its first artifact. The job records it, every entry
  /// of the author's todo list reads complete, and the artifact goes to the humans. The author
  /// stays in its turn.
  action authorRecordsArtifact: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      inTurn(routing, id),
      not(routing.jobs[id].handedOver),
      val recorded = withJob(says(routing, id), id, job => { ...job, handedOver: true, todos: completed(job.todos) })
      move(
        flushBoard(recorded, id),
        { ...NO_FACTS, posts: List(post(routing, ArtifactReadyPost, Set())) },
      ),
    }
  }

  /// An author's turn ends, and its board flushes. A turn that got a cancel ends cancelled. The
  /// job session gets the author's todo list as its plan before the closing reply. The Durable
  /// Object may restart while the closing reply is out, when the turn end posts nothing else. A
  /// restart while the narrated account is out is the session feed property's case, since the
  /// account waits with the narration until its post returns.
  action authorTurnEnds: bool = {
    nondet id = JOB_SLOTS.oneOf()
    nondet turnEnding = Set(Replies, EndsSilently, StopsEarly, GivesUp, PromptFails, Cancelled).oneOf()
    nondet health = Set(TrackerUp).union(RESTARTS_MID_POST).oneOf()
    all {
      inTurn(routing, id),
      routing.jobs[id].cancelSent iff turnEnding == Cancelled,
      val ended = turnEndOf(routing, id, turnEnding)
      val spoke = if (Set(Replies, StopsEarly, GivesUp).contains(turnEnding)) says(routing, id) else routing
      val endsOnItsOwn = Set(Replies, EndsSilently, StopsEarly, GivesUp).contains(turnEnding)
      all {
        RESTARTS_MID_POST.contains(health) implies and {
          ended.posts.length() == 0,
          ended.feed.select(posted => posted.kind == NarratedAccount).length() == 0,
        },
        moveWithFeed(
          flushBoard(ended.state, id),
          {
            ...NO_FACTS,
            posts: ended.posts,
            feed: ended.feed.foldl(List(), (feed, posted) => feed.append({ ...posted, stored: storedAcrossAttempts(health) })),
            plans: planOf(routing, id),
            turnEnded: Set(id),
            cancelled: if (turnEnding == Cancelled) Set(id) else Set(),
            health: health,
            accounts: if (endsOnItsOwn and spoke.jobs[id].buffered) Set(id) else Set(),
            feedClosed: Set(id),
          },
        ),
      },
    }
  }

  /// An author's turn passes the wall clock limit, and the author fails. Its feed ends on the
  /// error. The wall clock does not fail a paused author.
  action authorFails: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      inTurn(routing, id),
      not(routing.jobs[id].paused),
      val failed = failAuthor(routing, id)
      move(
        flushBoard(failed.state, id),
        { ...NO_FACTS, posts: failed.posts, feed: feedOf(routing, id, ErrorActivity, TrackerUp), feedClosed: Set(id) },
      ),
    }
  }

  /// A person presses Stop in a tracker session. The author of its job session drops its queued
  /// prompts and its stall mark. An author in its turn stops working and its container goes, so
  /// its next prompt starts a fresh one. The container of an idle harness author goes too, and an
  /// idle or in-review harness author's board flushes. The feed ends on the stopped reply, also on
  /// a finished workflow. The orchestrator does not post.
  action personStops: bool = {
    nondet issue = ISSUES.oneOf()
    nondet health = HEALTHS.oneOf()
    val chosen = sessionJob(routing, issue)
    val stopped = chosen.fold(routing, (state, id) => {
      val ended = withJob(state, id, job =>
        if (job.author == InTurn) { ...forgetMessage(job), queued: List(), holdsInstruction: false, stoppedEarly: false, nudged: false, author: Idle, containerClosed: true, cancelSent: false }
        else if (job.author == Idle and not(MODEL_AUTHOR)) { ...forgetMessage(job), queued: List(), stoppedEarly: false, containerClosed: true }
        else { ...forgetMessage(job), queued: List(), stoppedEarly: false })
      val harnessAtRest = not(MODEL_AUTHOR) and (state.jobs[id].author == Idle or state.jobs[id].author == InReview)
      if (state.jobs[id].author == InTurn or harnessAtRest) flushBoard(ended, id) else ended
    })
    val feed = chosen.fold(List(), (posts, id) => posts.concat(feedOf(routing, id, StoppedActivity, health)))
    all {
      hasSession(routing, issue),
      moveWithFeed(stopped, { ...NO_FACTS, feed: feed, stoppedIn: Set(issue), health: health, feedClosed: chosen }),
    }
  }

  /// The agent prompts a model-call author in review, and a person presses Stop in its job session
  /// while the model call of that turn is out. The author stays in review with its page. Its board
  /// flushes, and its feed ends on the stopped reply. The orchestrator does not post.
  action personStopsAModelCall: bool = {
    nondet id = JOB_SLOTS.oneOf()
    nondet health = HEALTHS.oneOf()
    all {
      MODEL_AUTHOR,
      not(routing.ended),
      not(routing.waitsForInput),
      id < routing.jobs.length(),
      val issue = routing.jobs[id].issue
      val stopped = withJob(routing, id, job => { ...forgetMessage(job), queued: List(), stoppedEarly: false })
      all {
        routing.jobs[id].author == InReview,
        hasSession(routing, issue),
        sessionJob(routing, issue).contains(id),
        moveWithFeed(
          flushBoard(stopped, id),
          {
            ...NO_FACTS,
            feed: feedOf(routing, id, StoppedActivity, health),
            stoppedIn: Set(issue),
            turnEnded: Set(id),
            health: health,
            feedClosed: Set(id),
          },
        ),
      },
    }
  }

  /// The Durable Object restarts between steps.
  action workflowRestarts: bool = restartAfter(routing, NO_FACTS, cutClosingReplies)

  /// The alarm of a closing reply whose post a restart or a tracker failure cut fires. It posts the
  /// narration that waits, then the reply again under its activity id, so the tracker stores it
  /// once. The alarm is done once the reply lands. A restart while the post is out keeps the alarm
  /// armed, and a failed post arms it again, so it fires again. When the tracker fails the
  /// narration, the alarm does not post the reply and arms again. Once an hour has passed since the
  /// reply's turn ended, a failed post or failed narration gives the alarm up instead.
  action closingReplyAlarmFires: bool = {
    nondet reply = cutClosingReplies.keys().oneOf()
    nondet health = Set(TrackerUp).union(RESTARTS_MID_POST).union(TRACKER_FAILURES).oneOf()
    val cut = cutClosingReplies.get(reply)
    val heldBehindNarration = narrationOf(feedNarration, cut.job).waits and TRACKER_FAILURES.contains(health)
    val posted = { ...cut, stored: if (cut.stored > 0) cut.stored else storedAcrossAttempts(health) }
    val givesUp = TRACKER_FAILURES.contains(health) and cut.pastItsHour
    val afterThePost = { ...posted, armed: TRACKER_FAILURES.contains(health) and not(givesUp), gaveUp: givesUp and posted.stored == 0 }
    val fired = { ...NO_FACTS, health: health, replyAlarmFired: Set(cut.job) }
    val facts = { ...fired, feed: List({ job: cut.job, kind: cut.kind, stored: posted.stored }) }
    all {
      cut.armed,
      if (heldBehindNarration)
        moveMessages(
          routing,
          { ...fired, held: List({ job: cut.job, kind: cut.kind, stored: cut.stored }) },
          sessionMessages,
          messagesToLand,
          NO_DELIVERY_WITNESSES,
          if (cut.pastItsHour) cutClosingReplies.set(reply, { ...cut, armed: false, gaveUp: cut.stored == 0 })
          else cutClosingReplies,
        )
      else if (RESTARTS_MID_POST.contains(health)) restartAfter(routing, facts, cutClosingReplies.set(reply, posted))
      else
        moveMessages(
          routing,
          facts,
          sessionMessages,
          messagesToLand,
          NO_DELIVERY_WITNESSES,
          cutClosingReplies.set(reply, afterThePost),
        ),
    }
  }

  /// The alarm of a closing reply that the tracker has not stored fires an hour after the reply's
  /// turn ended, and the tracker fails its post again before storing it. The alarm gives up and is
  /// not armed again. When narration waits, the tracker fails it and the alarm does not post the
  /// reply. The clock is shared, so the hour has passed for every closing reply cut so far.
  action closingReplyGivesUp: bool = {
    nondet reply = cutClosingReplies.keys().oneOf()
    val cut = cutClosingReplies.get(reply)
    val anHourLater = cutClosingReplies.keys().mapBy(other => { ...cutClosingReplies.get(other), pastItsHour: true })
    val lastTry = { job: cut.job, kind: cut.kind, stored: 0 }
    val fired = { ...NO_FACTS, health: FailsBeforeStoring, replyAlarmFired: Set(cut.job), anHourPassed: true }
    all {
      cut.armed,
      cut.stored == 0,
      moveMessages(
        routing,
        if (narrationOf(feedNarration, cut.job).waits) { ...fired, held: List(lastTry) } else { ...fired, feed: List(lastTry) },
        sessionMessages,
        messagesToLand,
        NO_DELIVERY_WITNESSES,
        anHourLater.set(reply, { ...cut, armed: false, gaveUp: true, pastItsHour: true }),
      ),
    }
  }

  /// A researcher reports its todo list.
  action researcherReportsTodos: bool = {
    nondet id = JOB_SLOTS.oneOf()
    nondet todos = REPORTED_TODOS.oneOf()
    all {
      id < routing.jobs.length(),
      routing.jobs[id].research == Researching,
      move(withJob(routing, id, job => { ...job, researcherTodos: todos }), NO_FACTS),
    }
  }

  /// A researcher's turn ends with its payload written. Its closing text links a page, which does
  /// not become the job's artifact. Every entry of its todo list reads complete, and the author
  /// starts.
  action researcherHandsOver: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      id < routing.jobs.length(),
      routing.jobs[id].research == Researching,
      val handed = withJob(routing, id, job =>
        { ...job, research: Researched, researcherTodos: completed(job.researcherTodos), author: InTurn, restarts: 0 })
      move(flushBoard(handed, id), NO_FACTS),
    }
  }

  /// A researcher's turn ends without a payload its author may take: it left none, it gave up, or
  /// the harness stopped it on a limit. It restarts in a fresh sandbox, or fails once its restarts
  /// are used up, and the workflow's audience hears it. Its board flushes.
  action researcherLeavesNoPayload: bool = {
    nondet id = JOB_SLOTS.oneOf()
    nondet researchEnding = RESEARCH_ENDINGS.oneOf()
    val ended = { ...NO_FACTS, researchEnded: Set({ job: id, ending: researchEnding }) }
    all {
      id < routing.jobs.length(),
      routing.jobs[id].research == Researching,
      if (routing.jobs[id].restarts < MAX_RESTARTS)
        move(flushBoard(withJob(routing, id, job => { ...job, restarts: job.restarts + 1 }), id), ended)
      else
        move(
          flushBoard(withJob(routing, id, job => { ...job, research: ResearchFailed }), id),
          { ...ended, posts: List(post(routing, FailedPost, Set())) },
        ),
    }
  }

  /// The agent pauses an author that runs. The reply goes to the workflow's audience.
  action agentPausesAuthor: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      not(MODEL_AUTHOR),
      not(routing.ended),
      id < routing.jobs.length(),
      isAuthorUnfinished(routing.jobs[id]),
      not(routing.jobs[id].paused),
      move(pauseAuthor(routing, id), { ...NO_FACTS, posts: List(post(routing, InfoPost, Set())) }),
    }
  }

  /// The agent pauses an author that is paused already. The author stays as it is, and nothing is
  /// posted.
  action agentPausesAPausedAuthor: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      not(MODEL_AUTHOR),
      not(routing.ended),
      id < routing.jobs.length(),
      isAuthorUnfinished(routing.jobs[id]),
      routing.jobs[id].paused,
      move(routing, NO_FACTS),
    }
  }

  /// The agent resumes a paused author. Its board flushes, the reply goes to the workflow's
  /// audience, and the author gets the continue prompt.
  action agentResumesAuthor: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      not(MODEL_AUTHOR),
      not(routing.ended),
      id < routing.jobs.length(),
      isAuthorUnfinished(routing.jobs[id]),
      routing.jobs[id].paused,
      val resumed = flushBoard(withJob(routing, id, job => { ...job, paused: false }), id)
      move(promptAuthor(resumed, id, OtherPrompt), { ...NO_FACTS, posts: List(post(routing, InfoPost, Set())) }),
    }
  }

  /// The agent resumes an author that is not paused. The author stays as it is, and nothing is
  /// posted.
  action agentResumesAnUnpausedAuthor: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      not(MODEL_AUTHOR),
      not(routing.ended),
      id < routing.jobs.length(),
      isAuthorUnfinished(routing.jobs[id]),
      not(routing.jobs[id].paused),
      move(routing, NO_FACTS),
    }
  }

  /// Whether the idle clock puts the workflow to sleep: it runs, it does not wait for input yet, and
  /// no author runs and no researcher works.
  pure def sleepsOnTheIdleClock(state: Routing): bool =
    not(state.ended) and not(state.waitsForInput) and state.jobs.foldl(true, (idle, job) => idle and not(isBusy(job)))

  /// `onIdle`: the idle clock fires on an idle workflow. The workflow sleeps, and the sleep text goes
  /// to the workflow's audience.
  action idleClockFires: bool = all {
    sleepsOnTheIdleClock(routing),
    move({ ...routing, waitsForInput: true }, { ...NO_FACTS, posts: List(post(routing, InfoPost, Set())) }),
  }

  /// `onIdle`: the idle clock fires on a running workflow that works or waits for input already.
  /// Nothing changes.
  action idleClockFiresWithoutASleep: bool = all {
    not(routing.ended),
    not(sleepsOnTheIdleClock(routing)),
    move(routing, NO_FACTS),
  }

  /// A board flush of one job.
  action boardFlushes: bool = {
    nondet id = JOB_SLOTS.oneOf()
    all {
      id < routing.jobs.length(),
      move(flushBoard(routing, id), NO_FACTS),
    }
  }

  /// The agent finishes the workflow once every job is over, or fails it. Every unfinished author
  /// and researcher is cancelled, and its board flushes. The feed of an author with a prompt in
  /// flight or queued ends on the stopped reply.
  action agentEndsWorkflow: bool = {
    nondet ending = Set(Finishes, Fails).oneOf()
    val kind = if (ending == Finishes) DonePost else WorkflowFailedPost
    val cancelled = cancelEveryJob(routing)
    all {
      not(routing.ended),
      ending == Finishes implies routing.jobs.foldl(true, (over, job) => over and not(isUnfinished(job))),
      move(cancelled.state, { ...NO_FACTS, posts: List(post(routing, kind, Set())), feed: cancelled.feed, feedClosed: jobsOfFeed(cancelled.feed) }),
    }
  }

  action step: bool = any {
    personWritesInSession,
    aPersonWritesWhereNoAuthorRuns,
    aPersonWritesInTheQuietSubIssueSession,
    personSendsInSession,
    trackerDeliversAgain,
    aSessionMessageLands,
    agentStartsJob,
    agentNamesTheSubject,
    trackerOpensSession,
    chatThreadJoins,
    authorStreams,
    authorReportsTodos,
    authorRecordsArtifact,
    authorTurnEnds,
    authorFails,
    personStops,
    personStopsAModelCall,
    theAgentTurnEndsOrTheInstanceRestarts,
    theTurnTimesOutWhileTheSubIssueSessionWaits,
    closingReplyAlarmFires,
    closingReplyGivesUp,
    researcherReportsTodos,
    researcherHandsOver,
    researcherLeavesNoPayload,
    aResearcherTurnEnds,
    theAgentPausesAnAuthor,
    theAgentResumesAnAuthor,
    theIdleClockFires,
    boardFlushes,
  }

  /// The agent pauses an author, which may be paused already.
  action theAgentPausesAnAuthor: bool = any { agentPausesAuthor, agentPausesAPausedAuthor }

  /// The agent resumes an author, which may not be paused.
  action theAgentResumesAnAuthor: bool = any { agentResumesAuthor, agentResumesAnUnpausedAuthor }

  /// The idle clock fires, and the workflow sleeps or goes on.
  action theIdleClockFires: bool = any { idleClockFires, idleClockFiresWithoutASleep }

  /// A researcher's turn ends: it hands over, or it leaves no payload. The step also lists each
  /// ending alone, so a researcher reaches its restart limit before the person's messages end
  /// most traces.
  action aResearcherTurnEnds: bool = any { researcherHandsOver, researcherLeavesNoPayload }

  /// The agent's turn ends with a reply, or the agent ends the workflow.
  action theAgentTurnEnds: bool = any { agentTurnEnds, agentEndsWorkflow }

  /// The agent's turn ends, or the instance restarts. Each can happen at any step, so they share one
  /// pick, and a trace gets to the steps a long session takes before the workflow ends.
  action theAgentTurnEndsOrTheInstanceRestarts: bool = any { theAgentTurnEnds, workflowRestarts }

  /// With a chat thread, the orchestrator does not post to any tracker session.
  val orchestratorStaysOutOfSessionsWhenChatExists: bool =
    lastStepKept.orchestratorStaysOutOfSessionsWhenChatExists

  /// Without a chat thread, every ask and failure reaches the starting session. A session gets any
  /// other post only after a person wrote there.
  val linearOnlyAsksReachTheStartingSession: bool = lastStepKept.linearOnlyAsksReachTheStartingSession

  /// A person's message in the job session of an author in its turn reaches the running turn as a
  /// steer. A paused author holds it in its queue. The orchestrator does not post and does not
  /// wake the agent. The person's receipt is a thought in the feed, which this spec does not model.
  val sessionMessageReachesItsRunningAuthorSilently: bool =
    lastStepKept.sessionMessageReachesItsRunningAuthorSilently

  /// A person's message in a session without a running author wakes the agent, and the answer
  /// reaches that session or the chat thread. A verbal command that runs answers the person
  /// itself.
  val sessionMessageWithoutAnAuthorIsAnswered: bool = lastStepKept.sessionMessageWithoutAnAuthorIsAnswered

  /// When an author's turn ends and it idles unfinished in its job session, its feed's last post
  /// is a response or an error.
  val sessionFeedEndsWhenItsAuthorIdles: bool = lastStepKept.sessionFeedEndsWhenItsAuthorIdles

  /// The tracker stores each feed activity at most once across retries.
  val feedActivityPostsOnce: bool = lastStepKept.feedActivityPostsOnce

  /// A turn end with a closing account posts it as the closing reply, or as narration when the
  /// author goes straight on.
  val aTurnEndNeverDropsItsAccount: bool = lastStepKept.aTurnEndNeverDropsItsAccount

  /// A researcher turn that left no payload, gave up, or stopped on a limit does not start the
  /// author. The researcher counts one restart, or fails once its restarts are used up.
  val aResearcherThatDidNotFinishRestartsOrFails: bool = lastStepKept.aResearcherThatDidNotFinishRestartsOrFails

  /// A workflow with a chat thread does not set a session plan.
  val chatWorkflowNeverSetsASessionPlan: bool = lastStepKept.chatWorkflowNeverSetsASessionPlan

  /// A session plan is set only when the turn of the author of its job session ends, once for
  /// that turn. A todo list change does not set it.
  val sessionPlanSetsOnlyWhenATurnEnds: bool = lastStepKept.sessionPlanSetsOnlyWhenATurnEnds

  /// An artifact needs an author on its job. Once the job records it, the author's todo list does
  /// not change.
  val todoListIsFixedAfterFirstArtifact: bool = lastStepKept.todoListIsFixedAfterFirstArtifact

  /// A stop leaves the workflow status as it was, the orchestrator does not post, and the author's
  /// feed ends on the stopped reply, on a finished workflow too. A cancelled turn that leaves its
  /// author idle in its job session ends the feed the same way.
  val aStopAnswersOnlyInTheFeed: bool = lastStepKept.aStopAnswersOnlyInTheFeed

  /// Once a job's author exists, every entry of its researcher's todo list reads complete.
  val researchReadsCompleteOnceTheAuthorStarts: bool =
    routing.jobs.foldl(true, (complete, job) => complete and (hasAuthor(job) implies not(isOpen(job.researcherTodos))))

  /// In a workflow that started from a chat thread, an issue subject and every issue a job works on
  /// get exactly one link request to that thread. A workflow that started in the tracker sends
  /// none.
  val eachIssueLinksTheChatThreadOnce: bool = ISSUES.forall(issue => {
    val worked = isSubjectItself(routing, issue) or jobsOn(routing, issue).size() > 0
    linksOf(routing, issue) == (if (STARTS_IN_CHAT and worked) 1 else 0)
  })

  /// Every board lives in a chat thread the workflow replies to.
  val boardsLiveOnlyInChat: bool =
    routing.boards.forall(board => routing.replyTargets.contains(ChatThread(board.thread)))

  /// An issue has at most one job that is not over, and a job does not start on an issue whose job
  /// completed. A job here ends only cancelled or failed, so every job on an issue but the last
  /// one is over.
  val oneJobAtATimePerIssueUntilOneCompletes: bool = ISSUES.forall(issue => {
    val onIssue = jobsOn(routing, issue)
    onIssue.forall(earlier => onIssue.forall(later => earlier < later implies not(isUnfinished(routing.jobs[earlier]))))
  })

  /// Witness for `oneJobAtATimePerIssueUntilOneCompletes`: a job start names an issue whose job is
  /// not over, and it is refused.
  val aStartBesideAnIssuesJobIsRefused: bool = lastStep.startRefusedBesideTheIssuesJob

  /// The jobs the workflow started, which model checking bounds.
  val jobsStarted: int = routing.jobs.length()

  /// Every session message lands once, unless a delivery of it is in flight or the tracker still
  /// owes one after a restart failed it.
  val everySessionMessageLandsOnce: bool = sessionMessages.keys().forall(message => {
    val sent = sessionMessages.get(message)
    and {
      sent.landed <= 1,
      (sent.inFlight == 0 and not(sent.owed)) implies sent.landed == 1,
    }
  })

  /// Every closing reply whose post an instance restart or a tracker failure cut is stored once,
  /// unless its alarm is still armed, gave up an hour after its turn ended, or the reply folded
  /// into the narration of its author.
  val closingReplyLandsOnce: bool = cutClosingReplies.keys().forall(reply => {
    val cut = cutClosingReplies.get(reply)
    and {
      cut.stored <= 1,
      not(cut.armed) implies (cut.stored == 1 or cut.gaveUp or cut.folded),
    }
  })

  /// A closing reply waits on its alarm only while its author is between turns. A turn start folds
  /// it into the narration, so a response does not mark the job session complete while the author
  /// works, and it does not land after the reply of the next turn.
  val aClosingReplyWaitsOnlyBetweenTurns: bool = cutClosingReplies.keys().forall(reply => {
    val cut = cutClosingReplies.get(reply)
    cut.armed implies routing.jobs[cut.job].author != InTurn
  })

  /// As a job's feed closes, no closing reply of the job that waited on its alarm stays armed, so
  /// the new closing does not land ahead of it.
  val aClosingReplyNeverOvertakesAnEarlierOne: bool = lastStepKept.aClosingReplyNeverOvertakesAnEarlierOne

  /// The closing replies whose post an instance restart or a tracker failure cut, which model
  /// checking bounds.
  val closingRepliesCut: int = cutClosingReplies.keys().size()

  /// The session messages sent, which model checking bounds.
  val sessionMessagesSent: int = sessionMessages.keys().size()

  /// The deliveries of session messages in flight, which model checking bounds.
  val messageDeliveriesInFlight: int =
    sessionMessages.keys().fold(0, (total, message) => total + sessionMessages.get(message).inFlight)

  /// Witness for `everySessionMessageLandsOnce`: a session message lands after a restart failed a
  /// delivery of it.
  val aRedeliveredMessageLands: bool = lastDelivery.aRedeliveredMessageLands

  /// Witness for `everySessionMessageLandsOnce`: a second delivery of a session message that
  /// landed is dropped.
  val aSecondDeliveryIsDropped: bool = lastDelivery.aSecondDeliveryIsDropped

  /// The prompts that wait for an author, which model checking bounds.
  val promptsWaiting: int = routing.jobs.foldl(0, (total, job) => total + job.queued.length())

  /// The fresh sandboxes the current tasks of the jobs took, which model checking bounds.
  val restartsTaken: int = routing.jobs.foldl(0, (total, job) => total + job.restarts)

  pure def hasFeedState(job: Job): bool =
    job.buffered or job.todos != NoTodos or job.restarts > 0 or job.nudged or job.stoppedEarly or job.paused or job.cancelSent

  /// The authors whose feed, todo list, stall marks or pause moved from where they started, which
  /// model checking bounds.
  val authorsWithFeedState: int = routing.jobs.foldl(0, (total, job) => if (hasFeedState(job)) total + 1 else total)

  /// The authors paused or with a cancel out, which model checking bounds.
  val pausedAuthors: int = routing.jobs.foldl(0, (total, job) => if (job.paused or job.cancelSent) total + 1 else total)

  pure def wroteIn(facts: StepFacts): Set[Issue] = match facts.wrote {
    | WroteIn(wrote) => Set(wrote.issue)
    | NobodyWrote => Set()
  }

  /// Witness for `sessionMessageReachesItsRunningAuthorSilently`: a message in a session reached its running author.
  val aMessageReachesARunningAuthor: bool = wroteIn(lastStep).size() > 0 and not(lastStep.woke) and lastStep.posts.length() == 0

  /// Witness for `sessionMessageReachesItsRunningAuthorSilently`: a message in a session started the next turn of its idle author.
  val aMessageStartsAnIdleAuthorsTurn: bool = wroteIn(lastStep).exists(issue =>
    runningSessionJob(routing, issue).exists(id => routing.jobs[id].author == InTurn and routing.jobs[id].queued.length() == 0))

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: a message in a session woke the agent.
  val aMessageWakesTheAgent: bool = wroteIn(lastStep).size() > 0 and lastStep.woke

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: an agent turn answered a person who wrote in a session.
  val anAgentTurnAnswersASession: bool = sessionsOf(lastStep.answered).size() > 0

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: a finished workflow replied to a person in a session.
  val aFinishedWorkflowReplies: bool = wroteIn(lastStep).size() > 0 and lastStep.posts.length() > 0

  /// Witness for `linearOnlyAsksReachTheStartingSession`: an ask or failure reached the starting session.
  val anAskReachesTheStartingSession: bool =
    postsOf(lastStep).exists(posted => isAskOrFailure(posted.kind) and posted.targets.contains(STARTING_SESSION))

  /// Witness for `linearOnlyAsksReachTheStartingSession`: the timeout text reached the starting session.
  val theTimeoutTextReachesTheStartingSession: bool =
    postsOf(lastStep).exists(posted => posted.kind == TurnFailedPost and posted.targets.contains(STARTING_SESSION))

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: the timeout text reached a person in the session on the sub-issue.
  val theTimeoutTextReachesASubIssueSession: bool =
    postsOf(lastStep).exists(posted => posted.kind == TurnFailedPost and posted.targets.contains(Session(SubIssue)))

  /// Witness for `orchestratorStaysOutOfSessionsWhenChatExists`: a workflow with a chat thread and a session posted.
  val aPostLandsBesideASession: bool =
    lastStep.posts.length() > 0 and hasChat(routing) and sessionsOf(routing.replyTargets).size() > 0

  /// Witness for `boardsLiveOnlyInChat`: a chat thread joined later.
  val aChatThreadJoinsLater: bool = routing.replyTargets.contains(JOINED_THREAD)

  /// Witness for `boardsLiveOnlyInChat`: a job has a board in the chat thread that joined later.
  val aBoardFollowsTheJoinedThread: bool = routing.boards.exists(board => ChatThread(board.thread) == JOINED_THREAD)

  /// Witness for `eachIssueLinksTheChatThreadOnce`: a job works on the sub-issue in a chat workflow.
  val aSubIssueGetsItsLink: bool = linksOf(routing, SubIssue) > 0

  /// Witness for `eachIssueLinksTheChatThreadOnce`: a job works on the subject issue under a project subject, which links it.
  val aProjectIssueGetsItsLink: bool = routing.subject == ProjectSubject and linksOf(routing, SubjectIssue) > 0

  /// Witness for `eachIssueLinksTheChatThreadOnce` and `oneJobAtATimePerIssueUntilOneCompletes`: a
  /// second job started on an issue, as a retry after the first was cancelled or failed.
  val aJobStartsAgainOnItsIssue: bool = ISSUES.exists(issue => jobsOn(routing, issue).size() > 1)

  /// The tracker opened a session on the sub-issue.
  val aSessionOpensOnTheSubIssue: bool = routing.replyTargets.contains(Session(SubIssue))

  pure def feedHas(facts: StepFacts, kind: FeedKind): bool = facts.feed.foldl(false, (found, posted) => found or posted.kind == kind)

  /// Witness for `sessionFeedEndsWhenItsAuthorIdles` and `aTurnEndNeverDropsItsAccount`: an author idles in its job session on the reply that holds its message.
  val anAuthorRepliesInItsSession: bool = feedHas(lastStep, ReplyActivity) and lastStep.turnEnded.size() > 0

  /// Witness for `sessionFeedEndsWhenItsAuthorIdles`: an author whose message the feed lost idles on "Done.".
  val anAuthorIdlesOnDone: bool = feedHas(lastStep, DoneActivity) and lastStep.turnEnded.size() > 0

  /// Witness for `sessionFeedEndsWhenItsAuthorIdles`: a failed prompt leaves an author idle on the error.
  val aFailedPromptEndsTheFeed: bool =
    feedHas(lastStep, ErrorActivity) and lastStep.turnEnded.exists(id => routing.jobs[id].author == Idle)

  /// Witness for `aTurnEndNeverDropsItsAccount`: a turn ends while a prompt waits, and the author's account posts as narration.
  val aTurnEndNarratesItsAccount: bool =
    feedHas(lastStep, NarratedAccount) and lastStep.turnEnded.exists(id => routing.jobs[id].author == InTurn)

  /// Witness for `sessionFeedEndsWhenItsAuthorIdles`: a turn ends while a prompt waits, so the author goes on.
  val aQueuedPromptKeepsTheFeedOpen: bool =
    lastStep.turnEnded.exists(id => routing.jobs[id].author == InTurn and hasSession(routing, routing.jobs[id].issue))

  /// Witness for `sessionFeedEndsWhenItsAuthorIdles`: a stall after the nudge restarts an author in its job session.
  val aStalledAuthorRestarts: bool = lastStep.turnEnded.exists(id => routing.jobs[id].restarts > 0 and routing.jobs[id].author == InTurn)

  /// Witness for `feedActivityPostsOnce`: the tracker stored an activity and then failed, and the retries stored it once.
  val aRetriedActivityIsStoredOnce: bool = lastStep.health == FailsAfterStoring and lastStep.feed.length() > 0

  /// Witness for `closingReplyLandsOnce`: the Durable Object restarts before the tracker stores a closing reply.
  val aRestartCutsAClosingReplyBeforeItIsStored: bool =
    lastStep.health == RestartsBeforeStoring and lastStep.turnEnded.size() > 0 and lastStep.feed.length() > 0

  /// Witness for `closingReplyLandsOnce`: the Durable Object restarts after the tracker stores a closing reply.
  val aRestartFollowsAStoredClosingReply: bool =
    lastStep.health == RestartsAfterStoring and lastStep.turnEnded.size() > 0 and lastStep.feed.length() > 0

  /// Witness for `closingReplyLandsOnce`: the alarm of a closing reply that a restart or a tracker failure cut posts it.
  val aCutClosingReplyPostsOnItsAlarm: bool =
    cutClosingReplies.keys().exists(reply => {
      val cut = cutClosingReplies.get(reply)
      not(cut.armed) and not(cut.gaveUp) and not(cut.folded)
    })

  /// Witness for `closingReplyLandsOnce`: the alarm of a closing reply fires while the tracker fails the narration that waits, so the reply does not post.
  val anAlarmHoldsItsReplyBehindNarration: bool = lastStep.replyAlarmFired.size() > 0 and lastStep.held.length() > 0

  /// Witness for `aClosingReplyWaitsOnlyBetweenTurns`: a closing reply that waited on its alarm folds into the narration as its author's next turn starts.
  val aWaitingReplyFoldsAtTheNextTurn: bool =
    lastStep.folded.exists(reply => routing.jobs[cutClosingReplies.get(reply).job].author == InTurn)

  /// Witness for `aClosingReplyNeverOvertakesAnEarlierOne`: a feed closes while an earlier closing reply of its job waits on its alarm, and that reply folds into the narration.
  val aClosingFoldsAWaitingReply: bool = lastStep.folded.exists(reply => {
    val id = cutClosingReplies.get(reply).job
    lastStep.feedClosed.contains(id) and routing.jobs[id].author != InTurn
  })

  /// Witness for `aStopAnswersOnlyInTheFeed`: the tracker fails the narration that waits as a stop closes the feed, so the stopped reply waits behind it on its alarm.
  val aStopHoldsItsReplyBehindNarration: bool = lastStep.stoppedIn.size() > 0 and lastStep.held.length() > 0

  /// Witness for `closingReplyLandsOnce`: the tracker fails the closing reply of a stop, and its alarm stays armed.
  val aFailedStopArmsItsClosingReply: bool =
    TRACKER_FAILURES.contains(lastStep.health) and lastStep.stoppedIn.size() > 0 and lastStep.feed.length() > 0

  /// Witness for `closingReplyLandsOnce`: the alarm of a closing reply gives up an hour after its turn ended.
  val aClosingReplyGivesUp: bool =
    cutClosingReplies.keys().exists(reply => cutClosingReplies.get(reply).gaveUp)

  /// Witness for `closingReplyLandsOnce`: the Durable Object restarts while the alarm of a closing reply posts it.
  val aRestartCutsTheAlarmOfAClosingReply: bool =
    RESTARTS_MID_POST.contains(lastStep.health) and lastStep.turnEnded.size() == 0 and lastStep.feed.length() > 0

  /// Witness for `chatWorkflowNeverSetsASessionPlan`: a session gets a plan.
  val aSessionGetsAPlan: bool = lastStep.plans.length() > 0

  /// Witness for `sessionPlanSetsOnlyWhenATurnEnds`: an author's turn ends and its job session gets its todo list as the plan.
  val aTurnEndSetsThePlan: bool = lastStep.plans.length() > 0 and lastStep.turnEnded.size() > 0

  /// Witness for `sessionPlanSetsOnlyWhenATurnEnds`: an author reports its todo list during its turn.
  val anAuthorReportsTodosInItsTurn: bool =
    not(hasChat(routing)) and jobIds(routing).exists(id => routing.jobs[id].author == InTurn and routing.jobs[id].todos != NoTodos and hasSession(routing, routing.jobs[id].issue))

  /// Witness for `chatWorkflowNeverSetsASessionPlan`: a chat workflow with a job session holds a todo list.
  val aChatWorkflowReportsTodosBesideASession: bool =
    hasChat(routing) and jobIds(routing).exists(id => routing.jobs[id].todos != NoTodos and hasSession(routing, routing.jobs[id].issue))

  /// Witness for `todoListIsFixedAfterFirstArtifact`: an author with an open todo list records its artifact.
  val anArtifactCompletesTheTodoList: bool =
    jobIds(routing).exists(id => routing.jobs[id].handedOver and routing.jobs[id].todos == Todos(TODO_ENTRIES) and routing.jobs[id].author == InTurn)

  /// Witness for `aStopAnswersOnlyInTheFeed`: a stop ends the turn of an author.
  val aStopEndsATurn: bool = lastStep.stoppedIn.size() > 0 and feedHas(lastStep, StoppedActivity)

  /// Witness for `aStopAnswersOnlyInTheFeed`: a stop ends the model call of an author in review.
  val aStopEndsAModelCall: bool =
    lastStep.stoppedIn.size() > 0 and lastStep.turnEnded.size() > 0 and feedHas(lastStep, StoppedActivity)

  /// Witness for `aStopAnswersOnlyInTheFeed`: a stop on a finished workflow ends the author's feed.
  val aStopReachesAFinishedWorkflow: bool = lastStep.stoppedIn.size() > 0 and routing.ended and feedHas(lastStep, StoppedActivity)

  /// Witness for `aStopAnswersOnlyInTheFeed`: a stop lands while the workflow sleeps.
  val aStopLandsWhileTheWorkflowSleeps: bool = lastStep.stoppedIn.size() > 0 and routing.waitsForInput

  /// Witness for `researchReadsCompleteOnceTheAuthorStarts`: a researcher with an open todo list hands over.
  val aResearcherHandsOver: bool = jobIds(routing).exists(id => routing.jobs[id].research == Researched and routing.jobs[id].researcherTodos != NoTodos)

  /// Witness for `researchReadsCompleteOnceTheAuthorStarts`: a researcher with an open todo list runs.
  val aResearcherHasOpenTodos: bool = jobIds(routing).exists(id => isOpen(routing.jobs[id].researcherTodos))

  /// Witness for `sessionFeedEndsWhenItsAuthorIdles`: a model-call author's first turn ends its feed.
  val aModelCallAuthorEndsItsFeed: bool = MODEL_AUTHOR and feedHas(lastStep, DoneActivity)

  pure def wroteText(facts: StepFacts, text: SessionText): bool = match facts.wrote {
    | WroteIn(wrote) => wrote.text == text
    | NobodyWrote => false
  }

  /// Witness for `aStopAnswersOnlyInTheFeed`: a pause cancels a turn, and the author idles on the stopped reply.
  val aPauseCancelsATurn: bool =
    lastStep.cancelled.exists(id => routing.jobs[id].paused) and feedHas(lastStep, StoppedActivity)

  /// Witness for `aStopAnswersOnlyInTheFeed`: a turn that a pause cancelled ends after the resume, and the author goes on.
  val aResumedAuthorGoesOnAfterTheCancel: bool =
    lastStep.cancelled.exists(id => not(routing.jobs[id].paused) and routing.jobs[id].author == InTurn)

  /// Witness for `sessionMessageReachesItsRunningAuthorSilently`: a message waits in the queue of a paused author.
  val aMessageWaitsForAPausedAuthor: bool = wroteIn(lastStep).exists(issue =>
    runningSessionJob(routing, issue).exists(id => routing.jobs[id].paused and routing.jobs[id].queued.length() > 0))

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: "pause" in a session pauses an author and answers the person.
  val aVerbalPausePausesAnAuthor: bool =
    wroteText(lastStep, PauseCommand) and not(routing.ended) and lastStep.posts.length() > 0 and jobIds(routing).exists(id => routing.jobs[id].paused)

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: "cancel" in a session cancels a job and answers the person.
  val aVerbalCancelCancelsAJob: bool = wroteText(lastStep, CancelCommand) and lastStep.posts.length() > 0 and not(routing.ended)

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: "cancel" in the session on the subject issue under a project subject leaves the workflow running.
  val aVerbalCancelKeepsAProjectWorkflow: bool =
    wroteText(lastStep, CancelCommand) and wroteIn(lastStep).contains(SubjectIssue) and routing.subject == ProjectSubject and not(routing.ended)

  /// Witness for `sessionMessageWithoutAnAuthorIsAnswered`: "cancel" in a session cancels the workflow and answers the person.
  val aVerbalCancelCancelsTheWorkflow: bool =
    wroteText(lastStep, CancelCommand) and lastStep.posts.length() > 0 and routing.ended and feedHas(lastStep, StoppedActivity)

  /// Witness for `orchestratorStaysOutOfSessionsWhenChatExists`: the workflow goes to sleep and says so.
  val theWorkflowSleeps: bool =
    routing.waitsForInput and lastStep.posts.length() > 0 and wroteIn(lastStep).size() == 0 and lastStep.answered.size() == 0

  pure def researchEndedOn(facts: StepFacts, ending: ResearchEnding): Set[int] =
    facts.researchEnded.filter(ended => ended.ending == ending).map(ended => ended.job)

  /// Witness for `aResearcherThatDidNotFinishRestartsOrFails`: a researcher that gave up restarts.
  val aResearcherThatGaveUpRestarts: bool =
    researchEndedOn(lastStep, ResearcherGivesUp).exists(id => routing.jobs[id].research == Researching)

  /// Witness for `aResearcherThatDidNotFinishRestartsOrFails`: a researcher the harness stopped on a limit restarts.
  val aResearcherStoppedOnALimitRestarts: bool =
    researchEndedOn(lastStep, StopsOnALimit).exists(id => routing.jobs[id].research == Researching)

  /// Witness for `aResearcherThatDidNotFinishRestartsOrFails`: a researcher that gave up after its restarts fails.
  val aResearcherThatGaveUpFails: bool =
    researchEndedOn(lastStep, ResearcherGivesUp).exists(id => routing.jobs[id].research == ResearchFailed)

  /// Witness for `linearOnlyAsksReachTheStartingSession`: a researcher fails and the starting session hears it.
  val aResearcherFails: bool =
    jobIds(routing).exists(id => routing.jobs[id].research == ResearchFailed) and anAskReachesTheStartingSession
}
