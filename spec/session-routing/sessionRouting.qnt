/// Where the orchestrator's posts go in one workflow, and what a person's message in a tracker
/// session reaches. The surfaces are the chat threads, the starting session, and the sessions the
/// tracker opens on the issues of jobs. Each action is one step of the orchestrator that runs to
/// its end before the next event lands. An agent turn folds into one step that takes the inbox and
/// posts its answer, its question, or the timeout text. Prompt text, model output and the order of
/// the reply targets are left out.
module sessionRoutingTypes {
  /// The subject issue of the workflow, and one of its sub-issues.
  type Issue = SubjectIssue | SubIssue

  /// A reply target: a chat thread by number, or the tracker session on one issue. Thread 0 is
  /// the chat thread a chat workflow started from. Thread 1 joins later. Without a chat origin,
  /// the session on the subject issue is the starting session.
  type Target = ChatThread(int) | Session(Issue)

  /// The author of a job. `Running` covers queued, provisioning and working. `InReview` is an
  /// author whose artifact is out. `Finished` covers failed and cancelled.
  type AuthorStatus = Running | InReview | Finished

  /// A job on one issue. `queued` counts the prompts that wait for the author's next turn.
  /// `handedOver` holds once its artifact went to the humans.
  type Job = { issue: Issue, author: AuthorStatus, queued: int, handedOver: bool }

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

  /// What a person types in a session: a question, or a status request.
  type SessionText = Question | StatusRequest

  /// How an agent turn ends: closing text that answers, a question, or the watchdog's timeout text.
  type TurnOutcome = Answers | Asks | TimesOut

  /// How the agent ends the workflow.
  type Ending = Finishes | Fails

  /// A board of one job in one chat thread.
  type Board = { job: int, thread: int }

  /// The workflow as routing sees it. `waiting` holds where the people who wrote since the last
  /// agent turn wait for its answer. `links` holds the issue of each request to link an issue to
  /// the chat thread, in the order they went out.
  type Routing = {
    replyTargets: Set[Target],
    jobs: List[Job],
    waiting: Set[Target],
    links: List[Issue],
    boards: Set[Board],
    ended: bool,
  }

  /// Where a person wrote in this step, and what they wrote.
  type Wrote = NobodyWrote | WroteIn({ issue: Issue, text: SessionText })

  /// What one step did. `answered` holds where the people its agent turn answers wrote from.
  /// `woke` holds when a person's message waits for an agent turn.
  type StepFacts = {
    wrote: Wrote,
    answered: Set[Target],
    posts: List[Post],
    woke: bool,
  }

  /// Whether the last step kept each rule that spans a step.
  type KeptRules = {
    orchestratorStaysOutOfSessionsWhenChatExists: bool,
    linearOnlyAsksReachTheStartingSession: bool,
    sessionMessageReachesItsRunningAuthorSilently: bool,
    sessionMessageWithoutAnAuthorIsAnswered: bool,
  }
}

/// Routing in a workflow that starts from a chat thread or from a tracker session.
module sessionRouting {
  import sessionRoutingTypes.*

  /// True when the workflow started from a chat thread, false when it started from the tracker
  /// session on its subject issue.
  const STARTS_IN_CHAT: bool

  /// How many jobs the workflow starts at most.
  pure val MAX_JOBS: int = 3

  /// The chat thread that joins later.
  pure val JOINED_THREAD: Target = ChatThread(1)

  /// The session the workflow started from, in a workflow that started from the tracker.
  pure val STARTING_SESSION: Target = Session(SubjectIssue)

  pure val ISSUES: Set[Issue] = Set(SubjectIssue, SubIssue)

  pure val JOB_SLOTS: Set[int] = 0.to(MAX_JOBS - 1)

  pure val ORIGIN: Target = if (STARTS_IN_CHAT) ChatThread(0) else STARTING_SESSION

  /// A chat workflow's plan names the subject issue, which links it to the chat thread.
  pure val INITIAL_ROUTING: Routing = {
    replyTargets: Set(ORIGIN),
    jobs: List(),
    waiting: Set(),
    links: if (STARTS_IN_CHAT) List(SubjectIssue) else List(),
    boards: Set(),
    ended: false,
  }

  pure val NO_FACTS: StepFacts = { wrote: NobodyWrote, answered: Set(), posts: List(), woke: false }

  var routing: Routing
  var lastStepKept: KeptRules
  var lastStep: StepFacts

  pure def isChatThread(target: Target): bool = match target {
    | ChatThread(_) => true
    | Session(_) => false
  }

  pure def isSession(target: Target): bool = not(isChatThread(target))

  pure def threadOf(target: Target): int = match target {
    | ChatThread(thread) => thread
    | Session(_) => -1
  }

  pure def chatThreads(state: Routing): Set[Target] = state.replyTargets.filter(isChatThread)

  pure def hasChat(state: Routing): bool = chatThreads(state).size() > 0

  pure def sessionsOf(targets: Set[Target]): Set[Target] = targets.filter(isSession)

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

  pure def linksOf(state: Routing, issue: Issue): int =
    state.links.foldl(0, (count, linked) => if (linked == issue) count + 1 else count)

  pure def isUnfinished(job: Job): bool = job.author != Finished

  pure def jobIds(state: Routing): Set[int] = JOB_SLOTS.filter(id => id < state.jobs.length())

  pure def jobsOn(state: Routing, issue: Issue): Set[int] = jobIds(state).filter(id => state.jobs[id].issue == issue)

  /// `authorInSession`: the unfinished author of the session's issue, else its last author.
  pure def sessionJob(state: Routing, issue: Issue): Set[int] = {
    val onIssue = jobsOn(state, issue)
    val unfinished = onIssue.filter(id => isUnfinished(state.jobs[id]))
    val last = onIssue.filter(id => onIssue.forall(other => other <= id))
    if (unfinished.size() > 0) unfinished else last
  }

  /// `runningAuthorInSession`: the job whose author runs in the session of the issue, if any.
  pure def runningSessionJob(state: Routing, issue: Issue): Set[int] =
    sessionJob(state, issue).filter(id => state.jobs[id].author == Running)

  pure def withJob(state: Routing, id: int, change: Job => Job): Routing =
    { ...state, jobs: state.jobs.replaceAt(id, change(state.jobs[id])) }

  /// A board flush writes the job's board in every chat thread among the reply targets.
  pure def flushBoard(state: Routing, id: int): Routing =
    { ...state, boards: state.boards.union(chatThreads(state).map(thread => { job: id, thread: threadOf(thread) })) }

  pure def addTarget(state: Routing, target: Target): Routing =
    { ...state, replyTargets: state.replyTargets.union(Set(target)) }

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

  /// A person's message in the job session of a running author is queued for that author. The
  /// step posts nothing and does not wake the agent.
  pure def reachesRunningAuthorSilently(before: Routing, after: Routing, facts: StepFacts): bool =
    match facts.wrote {
      | WroteIn(wrote) =>
          runningSessionJob(before, wrote.issue).forall(id => and {
            not(before.ended),
            after.jobs[id].queued == before.jobs[id].queued + 1,
            facts.posts.length() == 0,
            not(facts.woke),
          })
      | NobodyWrote => true
    }

  pure def reaches(state: Routing, targets: Set[Target], wrote: Target): bool =
    if (hasChat(state)) chatThreads(state).subseteq(targets) and targets.size() > 0
    else targets.contains(wrote)

  /// A person's message in a session without a running author waits for an agent turn, or gets
  /// a reply when the workflow ended. An agent turn's post reaches each session it answers, or
  /// the chat threads.
  pure def withoutAnAuthorIsAnswered(before: Routing, after: Routing, facts: StepFacts): bool = and {
    match facts.wrote {
      | WroteIn(wrote) =>
          runningSessionJob(before, wrote.issue).size() == 0 implies {
            if (before.ended) postsOf(facts).exists(posted => reaches(after, posted.targets, Session(wrote.issue)))
            else facts.woke and after.waiting.contains(Session(wrote.issue))
          }
      | NobodyWrote => true
    },
    sessionsOf(facts.answered).forall(session =>
      postsOf(facts).exists(posted => reaches(after, posted.targets, session))),
  }

  pure def rulesKeptBy(before: Routing, after: Routing, facts: StepFacts): KeptRules = {
    orchestratorStaysOutOfSessionsWhenChatExists: staysOutOfSessions(after, facts),
    linearOnlyAsksReachTheStartingSession: asksReachTheStartingSession(after, facts),
    sessionMessageReachesItsRunningAuthorSilently: reachesRunningAuthorSilently(before, after, facts),
    sessionMessageWithoutAnAuthorIsAnswered: withoutAnAuthorIsAnswered(before, after, facts),
  }

  action move(after: Routing, facts: StepFacts): bool = all {
    routing' = after,
    lastStepKept' = rulesKeptBy(routing, after, facts),
    lastStep' = facts,
  }

  action init: bool = all {
    routing' = INITIAL_ROUTING,
    lastStepKept' = rulesKeptBy(INITIAL_ROUTING, INITIAL_ROUTING, NO_FACTS),
    lastStep' = NO_FACTS,
  }

  /// A person writes in one of the workflow's tracker sessions. In the job session of a running
  /// author, the message is queued for that author. Anywhere else it wakes the agent. A finished
  /// workflow answers it at once.
  action personWritesInSession: bool = {
    nondet issue = ISSUES.oneOf()
    nondet text = Set(Question, StatusRequest).oneOf()
    val session = Session(issue)
    val wrote = WroteIn({ issue: issue, text: text })
    val running = runningSessionJob(routing, issue)
    all {
      routing.replyTargets.contains(session),
      if (routing.ended) {
        val kind = if (text == Question) InfoPost else StatusPost
        val reply = { kind: kind, targets: replyTargetsOf(routing, session) }
        move(routing, { ...NO_FACTS, wrote: wrote, posts: List(reply) })
      } else if (running.size() > 0) {
        val prompted = running.fold(routing, (state, id) => withJob(state, id, job => { ...job, queued: job.queued + 1 }))
        move(prompted, { ...NO_FACTS, wrote: wrote })
      } else {
        move({ ...routing, waiting: routing.waiting.union(Set(session)) }, { ...NO_FACTS, wrote: wrote, woke: true })
      },
    }
  }

  /// The agent's turn takes the inbox and ends: its closing text answers, it asks a question, or
  /// the watchdog posts the timeout text after the turn deadline. Each reaches the people the
  /// turn answers.
  action agentTurnEnds: bool = {
    nondet outcome = Set(Answers, Asks, TimesOut).oneOf()
    val kind = match outcome {
      | Answers => InfoPost
      | Asks => QuestionPost
      | TimesOut => TurnFailedPost
    }
    val answering = routing.waiting
    all {
      not(routing.ended),
      move(
        { ...routing, waiting: Set() },
        { ...NO_FACTS, answered: answering, posts: List(post(routing, kind, answering)) },
      ),
    }
  }

  /// The agent starts a job on an issue of the subject. A job already on the issue, or an earlier
  /// one whose artifact the host holds, refuses it. A chat workflow links the issue to its chat
  /// thread the first time a job works on it, unless the issue is the subject, which the plan
  /// linked. The new job's board goes to every chat thread.
  action agentStartsJob: bool = {
    nondet issue = ISSUES.oneOf()
    val onIssue = jobsOn(routing, issue)
    val id = routing.jobs.length()
    val started = { ...routing, jobs: routing.jobs.append({ issue: issue, author: Running, queued: 0, handedOver: false }) }
    val linked =
      if (STARTS_IN_CHAT and onIssue.size() == 0 and issue != SubjectIssue)
        { ...started, links: started.links.append(issue) }
      else started
    all {
      not(routing.ended),
      routing.jobs.length() < MAX_JOBS,
      onIssue.forall(other => not(isUnfinished(routing.jobs[other])) and not(routing.jobs[other].handedOver)),
      move(flushBoard(linked, id), NO_FACTS),
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
  /// target, and the message wakes the agent.
  action chatThreadJoins: bool = all {
    not(routing.ended),
    not(routing.replyTargets.contains(JOINED_THREAD)),
    val joined = addTarget(routing, JOINED_THREAD)
    move({ ...joined, waiting: joined.waiting.union(Set(JOINED_THREAD)) }, { ...NO_FACTS, woke: true }),
  }

  /// A running author hands its first artifact over to the humans. It takes its next queued prompt
  /// when one waits, else it waits in review.
  action authorHandsOver: bool = {
    nondet job = JOB_SLOTS.oneOf()
    all {
      job < routing.jobs.length(),
      routing.jobs[job].author == Running,
      not(routing.jobs[job].handedOver),
      val handed = withJob(routing, job, author =>
        if (author.queued > 0) { ...author, handedOver: true, queued: author.queued - 1 }
        else { ...author, handedOver: true, author: InReview })
      move(flushBoard(handed, job), { ...NO_FACTS, posts: List(post(routing, ArtifactReadyPost, Set())) }),
    }
  }

  /// A running author's turn passes the wall clock limit, and the author fails.
  action authorFails: bool = {
    nondet job = JOB_SLOTS.oneOf()
    all {
      job < routing.jobs.length(),
      routing.jobs[job].author == Running,
      val failed = withJob(routing, job, author => { ...author, author: Finished, queued: 0 })
      move(flushBoard(failed, job), { ...NO_FACTS, posts: List(post(routing, FailedPost, Set())) }),
    }
  }

  /// A board flush of one job.
  action boardFlushes: bool = {
    nondet job = JOB_SLOTS.oneOf()
    all {
      job < routing.jobs.length(),
      move(flushBoard(routing, job), NO_FACTS),
    }
  }

  /// The agent finishes the workflow once every job is over, or fails it. Every unfinished author
  /// is cancelled, and its board flushes.
  action agentEndsWorkflow: bool = {
    nondet ending = Set(Finishes, Fails).oneOf()
    val kind = if (ending == Finishes) DonePost else WorkflowFailedPost
    val cancelled = jobIds(routing).fold(routing, (state, id) =>
      if (isUnfinished(state.jobs[id])) flushBoard(withJob(state, id, job => { ...job, author: Finished, queued: 0 }), id)
      else state)
    all {
      not(routing.ended),
      ending == Finishes implies routing.jobs.foldl(true, (over, job) => over and not(isUnfinished(job))),
      move({ ...cancelled, ended: true }, { ...NO_FACTS, posts: List(post(routing, kind, Set())) }),
    }
  }

  action step: bool = any {
    personWritesInSession,
    agentTurnEnds,
    agentStartsJob,
    trackerOpensSession,
    chatThreadJoins,
    authorHandsOver,
    authorFails,
    boardFlushes,
    agentEndsWorkflow,
  }

  /// With a chat thread, the orchestrator does not post to any tracker session.
  val orchestratorStaysOutOfSessionsWhenChatExists: bool =
    lastStepKept.orchestratorStaysOutOfSessionsWhenChatExists

  /// Without a chat thread, every ask and failure reaches the starting session. A session gets any
  /// other post only after a person wrote there.
  val linearOnlyAsksReachTheStartingSession: bool = lastStepKept.linearOnlyAsksReachTheStartingSession

  /// A person's message in the job session of a running author reaches that author as a prompt.
  /// The orchestrator does not post and does not wake the agent.
  val sessionMessageReachesItsRunningAuthorSilently: bool =
    lastStepKept.sessionMessageReachesItsRunningAuthorSilently

  /// A person's message in a session without a running author wakes the agent, and the answer
  /// reaches that session or the chat thread.
  val sessionMessageWithoutAnAuthorIsAnswered: bool = lastStepKept.sessionMessageWithoutAnAuthorIsAnswered

  /// A chat workflow links each issue it works on, and its subject issue, to the chat thread once.
  /// A tracker workflow does not link any.
  val eachIssueLinksTheChatThreadOnce: bool = ISSUES.forall(issue => {
    val worked = issue == SubjectIssue or jobsOn(routing, issue).size() > 0
    linksOf(routing, issue) == (if (STARTS_IN_CHAT and worked) 1 else 0)
  })

  /// Every board lives in a chat thread the workflow replies to.
  val boardsLiveOnlyInChat: bool =
    routing.boards.forall(board => routing.replyTargets.contains(ChatThread(board.thread)))

  /// The jobs the workflow started, which model checking bounds.
  val jobsStarted: int = routing.jobs.length()

  /// The prompts that wait for an author, which model checking bounds.
  val promptsWaiting: int = routing.jobs.foldl(0, (total, job) => total + job.queued)

  pure def wroteIn(facts: StepFacts): Set[Issue] = match facts.wrote {
    | WroteIn(wrote) => Set(wrote.issue)
    | NobodyWrote => Set()
  }

  /// Witness for `sessionMessageReachesItsRunningAuthorSilently`: a message in a session reached its running author.
  val aMessageReachesARunningAuthor: bool = wroteIn(lastStep).size() > 0 and not(lastStep.woke) and lastStep.posts.length() == 0

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
  val aBoardFollowsTheJoinedThread: bool = routing.boards.exists(board => board.thread == threadOf(JOINED_THREAD))

  /// Witness for `eachIssueLinksTheChatThreadOnce`: a job works on the sub-issue in a chat workflow.
  val aSubIssueGetsItsLink: bool = linksOf(routing, SubIssue) > 0

  /// Witness for `eachIssueLinksTheChatThreadOnce`: a second job started on an issue.
  val aJobStartsAgainOnItsIssue: bool = ISSUES.exists(issue => jobsOn(routing, issue).size() > 1)

  /// The tracker opened a session on the sub-issue.
  val aSessionOpensOnTheSubIssue: bool = routing.replyTargets.contains(Session(SubIssue))
}
