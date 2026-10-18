/// How the workflow routes a person's feedback on the artifact of its one author. Each feedback
/// is screened when it carries text the screen reads, marked read on the host, and then routed:
/// to the author, to nobody, or to the agent, which tells the humans. A failed decisions call
/// routes to the agent. Each action is one delivery or one change to the author, run to its end.
module feedbackRouting {
  /// The artifact the author works on.
  type ArtifactKind = PullRequest | Page

  /// What a person posts. A review comment is a person's review, review comment, or comment on
  /// the pull request. An app review is a review an app files on it, which the screen reads
  /// first. A page mention is a page comment that mentions the bot. It sends the held comments.
  type FeedbackForm = ReviewComment | AppReview | PageMention

  /// What the screen decides about the text it reads. Unreadable when the decisions call fails.
  type ScreenOutcome = Admitted | NotAdmitted | Unreadable

  /// Whether the host marks the feedback read. A pull request host that fails only logs it. A
  /// page host that fails leaves the mention unsent.
  type Acknowledge = AckSucceeds | AckFails

  /// Whether the page host shows the held comments a mention asks for.
  type HeldRead = HeldReadable | HeldUnreadable

  /// What the decisions model answers about where the feedback goes. An unsure answer and a
  /// failed call both route to the agent.
  type RouteAnswer = ForTheAuthor | AsksForNothing | BeyondTheAuthor | Unsure | CallFails

  /// The one routing decision a feedback ends in.
  type RoutingDecision = ToTheAuthor | ToNobody | ToTheAgent

  /// Where the author stands. Running while its turn runs, idle between turns. A pause holds
  /// every prompt until the end of this spec.
  type AuthorStatus = Running | Idle | Paused | Finished

  /// The author and the prompts that wait in its queue.
  type Author = { status: AuthorStatus, promptsWaiting: int }

  type WorkflowStatus = WorkflowRunning | WorkflowEnded

  /// Whose words a text is. A person's words are a review comment or a mention. An app's words
  /// and the held comments are the text the screen reads before a model may.
  type Words = PersonWords | AppWords | HeldWords

  /// What the agent's note about the feedback says.
  type NoteKind =
    | NoNote
    | NotAdmittedNote
    | HeldUnreadableNote
    | NotMarkedReadNote
    | AuthorFinishedNote
    | SentToAuthorNote
    | AsksForNothingNote
    | ForTheAgentNote

  /// Whether the note wakes the agent to tell the humans.
  type Wake = NoWake | WakesForTheHumans

  /// What one feedback showed: the prompts the author got and the words they carried, the note
  /// the agent got and its wake, and the words the agent read with it.
  type Shown = {
    promptsAdded: int,
    prompted: Set[Words],
    note: NoteKind,
    wake: Wake,
    heard: Set[Words],
  }

  /// The picks of one feedback.
  type Picks = {
    form: FeedbackForm,
    screen: ScreenOutcome,
    ack: Acknowledge,
    heldRead: HeldRead,
    answer: RouteAnswer,
  }

  /// One feedback: what was picked, whether its workflow ran, the words the screen did not
  /// admit, and what it showed.
  type Arrival = { picks: Picks, onARunningWorkflow: bool, unadmitted: Set[Words], shown: Shown }

  /// The feedback the last step delivered, if it delivered one.
  type LastFeedback = NoFeedback | FeedbackArrived(Arrival)

  /// The workflow and its author as the last step left them.
  type World = {
    workflow: WorkflowStatus,
    author: Author,
    recorded: bool,
    heldOnPage: bool,
    arrivals: int,
  }

  /// For each rule over a step, whether the last step kept it. Each step writes it anew.
  type RulesKept = { oneRoutingDecision: bool, unadmittedReachesNobody: bool }

  /// For each witness that reads a step, whether the last step showed it.
  type StepWitnesses = {
    aFeedbackGoesToTheAuthor: bool,
    aFeedbackAsksForNothing: bool,
    aFeedbackGoesToTheAgent: bool,
    aFailedRouteCallGoesToTheAgent: bool,
    aFailedAcknowledgeStillRoutes: bool,
    aFailedAcknowledgeLeavesItUnsent: bool,
    anUnadmittedPullReview: bool,
    anUncheckedAppReview: bool,
    anAdmittedAppReviewGoesToTheAuthor: bool,
    aRunningAuthorQueuesIt: bool,
    anIdleAuthorTakesIt: bool,
    aPausedAuthorHoldsIt: bool,
    aFinishedAuthorGetsNothing: bool,
    anEndedWorkflowIgnoresIt: bool,
    anUnrecordedPullRequestGetsIt: bool,
    unadmittedHeldCommentsStayOut: bool,
    heldCommentsCannotBeRead: bool,
    aMentionCarriesTheHeldComments: bool,
    aMentionWithNothingHeldIsNotScreened: bool,
  }

  /// Whether the author works on a page. Otherwise it works on a pull request.
  const ON_A_PAGE: bool

  /// The artifact of the setup.
  pure val KIND: ArtifactKind = if (ON_A_PAGE) Page else PullRequest

  /// How many feedbacks arrive.
  const FEEDBACKS: int

  var world: World
  var lastFeedback: LastFeedback
  var rulesKept: RulesKept
  var stepWitnesses: StepWitnesses

  /// The author's first turn runs. A page is recorded before the spec starts, and it may hold a
  /// comment already. A pull request is recorded once the author prints its link.
  pure def initialWorld(heldAtStart: bool): World = {
    workflow: WorkflowRunning,
    author: { status: Running, promptsWaiting: 0 },
    recorded: KIND == Page,
    heldOnPage: heldAtStart,
    arrivals: 0,
  }

  pure val QUIET: Shown =
    { promptsAdded: 0, prompted: Set(), note: NoNote, wake: NoWake, heard: Set() }

  pure def formsOf(kind: ArtifactKind): Set[FeedbackForm] =
    if (kind == PullRequest) Set(ReviewComment, AppReview) else Set(PageMention)

  pure def heldReadsOf(kind: ArtifactKind): Set[HeldRead] =
    if (kind == Page) Set(HeldReadable, HeldUnreadable) else Set(HeldReadable)

  /// The words of the feedback itself.
  pure def ownWords(form: FeedbackForm): Words = if (form == AppReview) AppWords else PersonWords

  /// The words the agent reads with the event itself. An app review's text is left out.
  pure def eventWords(form: FeedbackForm): Set[Words] =
    if (form == AppReview) Set() else Set(PersonWords)

  pure def decisionOf(answer: RouteAnswer): RoutingDecision = match answer {
    | ForTheAuthor => ToTheAuthor
    | AsksForNothing => ToNobody
    | BeyondTheAuthor => ToTheAgent
    | Unsure => ToTheAgent
    | CallFails => ToTheAgent
  }

  /// The author takes a prompt: an idle one runs it now, any other one queues it.
  pure def withAPrompt(author: Author): Author =
    if (author.status == Idle) { ...author, status: Running }
    else { ...author, promptsWaiting: author.promptsWaiting + 1 }

  /// What one feedback does to the world, and what it shows. A page mention that does not reach
  /// the author leaves itself held, and only the author route sends the held comments.
  pure def delivered(before: World, picks: Picks): { after: World, arrival: Arrival } = {
    val counted = { ...before, arrivals: before.arrivals + 1 }
    val mention = picks.form == PageMention
    val carriesHeld = mention and before.heldOnPage
    val read = Set(ownWords(picks.form)).union(if (carriesHeld) Set(HeldWords) else Set())
    val screened =
      if (picks.form == AppReview) Set(AppWords) else if (carriesHeld) Set(HeldWords) else Set()
    val heardWithNotes = eventWords(picks.form).union(read)
    val left = { ...counted, heldOnPage: before.heldOnPage or mention }
    val running = before.workflow == WorkflowRunning
    val arrival = { picks: picks, onARunningWorkflow: running, unadmitted: Set(), shown: QUIET }
    val toTheHumans = { ...QUIET, wake: WakesForTheHumans, heard: heardWithNotes }
    if (not(running))
      { after: left, arrival: arrival }
    else if (mention and picks.heldRead == HeldUnreadable)
      {
        after: left,
        arrival: { ...arrival, shown: { ...toTheHumans, note: HeldUnreadableNote, heard: eventWords(picks.form) } },
      }
    else if (screened != Set() and picks.screen != Admitted)
      {
        after: left,
        arrival: {
          ...arrival,
          unadmitted: screened,
          shown: { ...toTheHumans, note: NotAdmittedNote, heard: eventWords(picks.form) },
        },
      }
    else if (KIND == Page and picks.ack == AckFails)
      { after: left, arrival: { ...arrival, shown: { ...toTheHumans, note: NotMarkedReadNote } } }
    else if (before.author.status == Finished)
      { after: counted, arrival: { ...arrival, shown: { ...toTheHumans, note: AuthorFinishedNote } } }
    else match decisionOf(picks.answer) {
      | ToTheAuthor => {
        after: { ...counted, author: withAPrompt(before.author), heldOnPage: false },
        arrival: {
          ...arrival,
          shown: { ...QUIET, promptsAdded: 1, prompted: read, note: SentToAuthorNote, heard: heardWithNotes },
        },
      }
      | ToNobody => {
        after: counted,
        arrival: { ...arrival, shown: { ...QUIET, note: AsksForNothingNote, heard: heardWithNotes } },
      }
      | ToTheAgent => {
        after: counted,
        arrival: { ...arrival, shown: { ...toTheHumans, note: ForTheAgentNote } },
      }
    }
  }

  /// The routing decisions a feedback showed: a prompt to its author, a note that wakes the
  /// agent for the humans, and a note that it asks for nothing.
  pure def decisionsShown(shown: Shown): Set[RoutingDecision] = Set(
    if (shown.promptsAdded > 0) Set(ToTheAuthor) else Set(),
    if (shown.wake == WakesForTheHumans) Set(ToTheAgent) else Set(),
    if (shown.note == AsksForNothingNote) Set(ToNobody) else Set(),
  ).flatten()

  pure def oneRoutingDecision(last: LastFeedback): bool = match last {
    | FeedbackArrived(arrival) =>
      arrival.onARunningWorkflow implies and {
        arrival.shown.promptsAdded <= 1,
        decisionsShown(arrival.shown).size() == 1,
      }
    | NoFeedback => true
  }

  pure def unadmittedReachesNobody(last: LastFeedback): bool = match last {
    | FeedbackArrived(arrival) => arrival.unadmitted.forall(words => and {
        arrival.shown.promptsAdded == 0,
        not(arrival.shown.prompted.contains(words)),
        not(arrival.shown.heard.contains(words)),
      })
    | NoFeedback => true
  }

  pure def rulesKeptIn(last: LastFeedback): RulesKept = {
    oneRoutingDecision: oneRoutingDecision(last),
    unadmittedReachesNobody: unadmittedReachesNobody(last),
  }

  pure def stepWitnessesOf(before: World, last: LastFeedback): StepWitnesses = match last {
    | FeedbackArrived(arrival) => {
      val picks = arrival.picks
      val note = arrival.shown.note
      {
        aFeedbackGoesToTheAuthor: note == SentToAuthorNote,
        aFeedbackAsksForNothing: note == AsksForNothingNote,
        aFeedbackGoesToTheAgent: note == ForTheAgentNote and picks.answer != CallFails,
        aFailedRouteCallGoesToTheAgent: note == ForTheAgentNote and picks.answer == CallFails,
        aFailedAcknowledgeStillRoutes:
          picks.ack == AckFails and note.in(Set(SentToAuthorNote, AsksForNothingNote, ForTheAgentNote)),
        aFailedAcknowledgeLeavesItUnsent: note == NotMarkedReadNote,
        anUnadmittedPullReview: picks.form == AppReview and picks.screen == NotAdmitted and note == NotAdmittedNote,
        anUncheckedAppReview: picks.form == AppReview and picks.screen == Unreadable and note == NotAdmittedNote,
        anAdmittedAppReviewGoesToTheAuthor: picks.form == AppReview and note == SentToAuthorNote,
        aRunningAuthorQueuesIt: note == SentToAuthorNote and before.author.status == Running,
        anIdleAuthorTakesIt: note == SentToAuthorNote and before.author.status == Idle,
        aPausedAuthorHoldsIt: note == SentToAuthorNote and before.author.status == Paused,
        aFinishedAuthorGetsNothing: note == AuthorFinishedNote,
        anEndedWorkflowIgnoresIt: not(arrival.onARunningWorkflow),
        anUnrecordedPullRequestGetsIt:
          not(before.recorded) and note.in(Set(SentToAuthorNote, AsksForNothingNote, ForTheAgentNote)),
        unadmittedHeldCommentsStayOut: picks.form == PageMention and note == NotAdmittedNote,
        heldCommentsCannotBeRead: note == HeldUnreadableNote,
        aMentionCarriesTheHeldComments: note == SentToAuthorNote and arrival.shown.prompted.contains(HeldWords),
        aMentionWithNothingHeldIsNotScreened:
          picks.form == PageMention and not(before.heldOnPage) and picks.screen != Admitted and note == SentToAuthorNote,
      }
    }
    | NoFeedback => NO_STEP_WITNESS
  }

  pure val NO_STEP_WITNESS: StepWitnesses = {
    aFeedbackGoesToTheAuthor: false,
    aFeedbackAsksForNothing: false,
    aFeedbackGoesToTheAgent: false,
    aFailedRouteCallGoesToTheAgent: false,
    aFailedAcknowledgeStillRoutes: false,
    aFailedAcknowledgeLeavesItUnsent: false,
    anUnadmittedPullReview: false,
    anUncheckedAppReview: false,
    anAdmittedAppReviewGoesToTheAuthor: false,
    aRunningAuthorQueuesIt: false,
    anIdleAuthorTakesIt: false,
    aPausedAuthorHoldsIt: false,
    aFinishedAuthorGetsNothing: false,
    anEndedWorkflowIgnoresIt: false,
    anUnrecordedPullRequestGetsIt: false,
    unadmittedHeldCommentsStayOut: false,
    heldCommentsCannotBeRead: false,
    aMentionCarriesTheHeldComments: false,
    aMentionWithNothingHeldIsNotScreened: false,
  }

  /// Write the world after a step, the feedback it delivered, and the rules and witnesses it kept and showed.
  action recordStep(after: World, last: LastFeedback): bool = all {
    world' = after,
    lastFeedback' = last,
    rulesKept' = rulesKeptIn(last),
    stepWitnesses' = stepWitnessesOf(world, last),
  }

  action init: bool = {
    nondet heldAtStart = (if (KIND == Page) Set(true, false) else Set(false)).oneOf()
    all {
      world' = initialWorld(heldAtStart),
      lastFeedback' = NoFeedback,
      rulesKept' = rulesKeptIn(NoFeedback),
      stepWitnesses' = NO_STEP_WITNESS,
    }
  }

  /// A person posts feedback on the artifact, and the host delivers it to the workflow.
  action personPostsFeedback: bool = {
    nondet form = formsOf(KIND).oneOf()
    nondet screen = Set(Admitted, NotAdmitted, Unreadable).oneOf()
    nondet ack = Set(AckSucceeds, AckFails).oneOf()
    nondet heldRead = heldReadsOf(KIND).oneOf()
    nondet answer = Set(ForTheAuthor, AsksForNothing, BeyondTheAuthor, Unsure, CallFails).oneOf()
    val result = delivered(world, { form: form, screen: screen, ack: ack, heldRead: heldRead, answer: answer })
    all {
      world.arrivals < FEEDBACKS,
      recordStep(result.after, FeedbackArrived(result.arrival)),
    }
  }

  /// A person comments on the page without a mention. The comment waits there, held.
  action personLeavesAPageComment: bool = all {
    KIND == Page,
    not(world.heldOnPage),
    recordStep({ ...world, heldOnPage: true }, NoFeedback),
  }

  /// The running author prints the link of its pull request, which records it.
  action authorRecordsItsPullRequest: bool = all {
    not(world.recorded),
    world.author.status == Running,
    recordStep({ ...world, recorded: true }, NoFeedback),
  }

  /// The author's turn ends on a recorded artifact. A waiting prompt starts the next turn.
  action authorTurnEnds: bool = {
    val author = world.author
    all {
      world.recorded,
      author.status == Running,
      recordStep(
        {
          ...world,
          author: if (author.promptsWaiting > 0) { ...author, promptsWaiting: author.promptsWaiting - 1 }
            else { ...author, status: Idle },
        },
        NoFeedback,
      ),
    }
  }

  /// The agent pauses the author. Its prompts wait.
  action agentPausesAuthor: bool = all {
    world.author.status.in(Set(Running, Idle)),
    recordStep({ ...world, author: { ...world.author, status: Paused } }, NoFeedback),
  }

  /// The agent cancels the author's job, which drops its prompts.
  action agentCancelsJob: bool = all {
    world.author.status != Finished,
    recordStep({ ...world, author: { status: Finished, promptsWaiting: 0 } }, NoFeedback),
  }

  /// A person cancels the workflow, which finishes the author.
  action workflowEnds: bool = all {
    world.workflow == WorkflowRunning,
    recordStep(
      { ...world, workflow: WorkflowEnded, author: { status: Finished, promptsWaiting: 0 } },
      NoFeedback,
    ),
  }

  action step: bool = any {
    personPostsFeedback,
    personLeavesAPageComment,
    authorRecordsItsPullRequest,
    authorTurnEnds,
    agentPausesAuthor,
    agentCancelsJob,
    workflowEnds,
  }

  /// Each feedback on a running workflow ends in exactly one of: a prompt to its author, a note
  /// that wakes the agent for the humans, or a note that it asks for nothing.
  val everyFeedbackGetsOneRoutingDecision: bool = rulesKept.oneRoutingDecision

  /// Feedback the screen does not admit does not reach the author's prompts, a note, or the
  /// agent's reads, for every feedback form.
  val unadmittedFeedbackReachesNobody: bool = rulesKept.unadmittedReachesNobody

  /// The feedbacks that arrived, which model checking bounds.
  val feedbacksArrived: int = world.arrivals

  val aFeedbackGoesToTheAuthor: bool = stepWitnesses.aFeedbackGoesToTheAuthor
  val aFeedbackAsksForNothing: bool = stepWitnesses.aFeedbackAsksForNothing
  val aFeedbackGoesToTheAgent: bool = stepWitnesses.aFeedbackGoesToTheAgent
  val aFailedRouteCallGoesToTheAgent: bool = stepWitnesses.aFailedRouteCallGoesToTheAgent
  val aFailedAcknowledgeStillRoutes: bool = stepWitnesses.aFailedAcknowledgeStillRoutes
  val aFailedAcknowledgeLeavesItUnsent: bool = stepWitnesses.aFailedAcknowledgeLeavesItUnsent
  val anUnadmittedPullReview: bool = stepWitnesses.anUnadmittedPullReview
  val anUncheckedAppReview: bool = stepWitnesses.anUncheckedAppReview
  val anAdmittedAppReviewGoesToTheAuthor: bool = stepWitnesses.anAdmittedAppReviewGoesToTheAuthor
  val aRunningAuthorQueuesIt: bool = stepWitnesses.aRunningAuthorQueuesIt
  val anIdleAuthorTakesIt: bool = stepWitnesses.anIdleAuthorTakesIt
  val aPausedAuthorHoldsIt: bool = stepWitnesses.aPausedAuthorHoldsIt
  val aFinishedAuthorGetsNothing: bool = stepWitnesses.aFinishedAuthorGetsNothing
  val anEndedWorkflowIgnoresIt: bool = stepWitnesses.anEndedWorkflowIgnoresIt
  val anUnrecordedPullRequestGetsIt: bool = stepWitnesses.anUnrecordedPullRequestGetsIt
  val unadmittedHeldCommentsStayOut: bool = stepWitnesses.unadmittedHeldCommentsStayOut
  val heldCommentsCannotBeRead: bool = stepWitnesses.heldCommentsCannotBeRead
  val aMentionCarriesTheHeldComments: bool = stepWitnesses.aMentionCarriesTheHeldComments
  val aMentionWithNothingHeldIsNotScreened: bool = stepWitnesses.aMentionWithNothingHeldIsNotScreened
}
