/// The agent review of one output artifact, from the first artifact of its author to the handover.
/// Each action is one stretch of the orchestrator that runs to its end before the next event lands.
/// A judge run splits in two: its turn ends, then code rules on its conclusion with the decisions model.
/// On a page, it also holds the comments: the ones a review posts, the ones people leave, and how
/// they reach the author.
module reviewLoopTypes {
  /// One refiner of the stage. The reviewers come first, then the polishers.
  type Refiner = FindingsReviewer | Judge | Polisher

  /// The kind of the output artifact: a pull request on the code host, or a page on the document host.
  type ArtifactKind = PullRequest | Page

  /// What a judge files on the artifact.
  type Ruling = Approved | Rejected

  /// Where a refiner run stands. Every status but `Unfinished` is final.
  type RunStatus = Unfinished | Done | Cancelled | Failed

  /// How the lookups of the revision on the host go in one step: they give it, or they fail.
  type RevisionLookup = RevisionKnown | RevisionUnknown

  /// A revision as a review, a ruling or a handover recorded it: the one the host gave, or
  /// unknown when the lookup failed.
  type FiledRevision = ReadRevision(int) | UnknownRevision

  /// What a refiner run filed: a review of one revision, a ruling on one, or the agent's ask for
  /// a person's ruling on a judge run.
  type RefinerResult =
    | NoResult
    | FiledReview({ revision: FiledRevision, findings: bool })
    | FiledRuling({ ruling: Ruling, revision: FiledRevision })
    | RulingAsked

  /// Why a refiner run hits a failure it may recover from: its closing text says it gave up, its
  /// turn stopped before the work was complete, it stalled again after its nudge, its harness
  /// went away, or the harness refused its prompt.
  type RestartCause = GivesUp | UnfinishedStop | Stalled | SandboxGone | PromptFails

  /// The refiner run that hit a failure it may recover from in a step, and why, if one did.
  type RecoverableFailure = NoRecoverableFailure | RefinerRunHit({ refinerRun: int, cause: RestartCause })

  /// One execution of a refiner on the artifact.
  type RefinerRun = { refinerIndex: int, status: RunStatus, result: RefinerResult, restarts: int }

  /// `Drafted` while the refiners hold the artifact. `Ready` once the humans have it, with the
  /// revision the handover recorded.
  type ArtifactStatus = Drafted | Ready({ deliveredRevision: FiledRevision })

  /// The refiner run the artifact is on, or the last one that ran.
  type RefinerRunOfArtifact = NoRefinerRun | OnRefinerRun(int)

  /// The output artifact. A revision is a number here. The host gives it a name.
  type Artifact = { status: ArtifactStatus, revision: int, refinerRun: RefinerRunOfArtifact }

  /// A part of the page an edit rewrites. A person comment on a block sits on `TheBlock`. No edit
  /// rewrites the block that holds the passage a review quotes.
  type PagePart = Title | Body | TheBlock

  /// The author task: whether a turn runs or starts, whether it failed, the prompts that wait for
  /// it with the person comments each carries, the comments the prompt of a model-call author's
  /// turn carries, the parts of the page a person rewrote since that turn read it, the judge
  /// entries whose rejection it got, and the refiner runs whose findings it got in a prompt.
  type Author = {
    atWork: bool,
    failed: bool,
    queuedPrompts: List[Set[int]],
    turnComments: Set[int],
    pageEditsDuringTurn: Set[PagePart],
    rejectedBy: Set[int],
    findingsFrom: Set[int],
  }

  /// The review again decision over a model-call author's closing text. A harness author does
  /// not get one, and neither does a model-call author when the decisions model cannot say.
  /// Then the agent routes.
  type ReviewAgainDecision = ReviewAgain | NoReviewAgain | AgentRoutes

  /// The passage a finding of a page review quotes. A review with findings holds one finding of each.
  type Passage = QuotesThePage | QuotesMissingText | WithoutPassage

  /// How the document host takes the comments of one page review. `DropsInline` posts no inline
  /// finding, `InlineThrows` fails the call that posts them, and `HostDown` fails every comment.
  type Commenting = TakesAll | DropsInline | InlineThrows | HostDown

  /// Whether the document host takes one write.
  type HostWrite = HostTakes | HostFails

  /// A comment code posted on the page for a refiner run: an inline finding, the outcome comment
  /// of a review, or the reason of a judge's rejection.
  type ReviewComment =
    | InlineFinding({ refinerRun: int, passage: Passage })
    | OutcomeComment({ refinerRun: int, findings: Set[Passage], approves: bool })
    | RejectionComment(int)

  /// The comment thread a person comment sits in: the one a person comment opened, or the one
  /// under a comment code posted for a review.
  type CommentThread = OpenedBy(int) | UnderReviewComment(int)

  /// A comment a person left on the page. It is acknowledged once code marked it read on the page,
  /// gone once an edit rewrote the block it sits on, sent once a prompt for the author carried it,
  /// and answered once the author posted its comment reply.
  type PersonComment = {
    commentThread: CommentThread,
    onTheBlock: bool,
    mentions: bool,
    acknowledged: bool,
    gone: bool,
    sent: bool,
    answered: bool,
  }

  /// Where a person leaves a comment: on the page as a whole, on the block, in the comment thread
  /// of a person comment, or under a comment code posted for a review.
  type CommentPlace =
    | OnThePageAsAWhole
    | OnTheBlock
    | InTheCommentThreadOf(int)
    | UnderTheReviewComment(int)

  /// How the held comments read in one step: the host cannot be read, the screen does not admit
  /// them, or the screen admits them and their acknowledgement lands or fails.
  type HeldRead = HostCannotBeRead | ScreenRefuses | AdmittedAndAcknowledged | AdmittedButAcknowledgementFails

  /// What lands while the screen reads the held comments.
  type WhileScreened = NothingLands | APersonReplies

  /// Who the decisions model routes a person's feedback to.
  type FeedbackRoute = ToTheAuthor | ToNobody | ToTheAgent

  /// Whether the host says that a new comment mentions the bot.
  type MentionLookup = TheHostSays | TheHostCannotSay

  /// How the host fails a write of a model-call author's revise turn: its first comment reply, the
  /// page text change before it lands, or the answer after the change landed.
  type HostFailure = RepliesFail | UpdateFails | UpdateLandsThenFails

  /// Whether the host takes the writes of a model-call author's revise turn.
  type PageWrite = WritesLand | WriteFails(HostFailure)

  /// Why a model-call author's revise turn failed.
  type TurnFailure = ReplyRefused | UpdateRefused | UpdateLandedThenFailed

  /// Who asked for the held comments to go to the author.
  type Asker = TheAgent | APersonsRevisionRequest | AMention

  /// What the agent read in a step about page comments: that the held ones stay held, the text of
  /// a held one, or the text of the mention that came in.
  type AgentNote = HeldCommentsStayHeld | HeldCommentText | MentionText

  /// What happened on the document host in a step, for the invariants that read it.
  type PageFact =
    | NoPageFact
    | PageReviewPosted(Commenting)
    | RejectionPosted(HostWrite)
    | HeldCommentsAsked({ by: Asker, read: HeldRead, carried: Set[int] })
    | APersonEditedThePage

  /// The review of one artifact, the done judge runs whose conclusion code is ruling on, and the
  /// comments on a page.
  type ReviewLoop = {
    author: Author,
    artifact: Artifact,
    refinerRuns: List[RefinerRun],
    judgeRunsCodeRulesOn: Set[int],
    reviewComments: List[ReviewComment],
    personComments: List[PersonComment],
  }

  /// The turn that ended in a step, if one did, with the revision the host gave at an author's
  /// turn end. A model-call author's turn starts over when a person changed the page text while
  /// its model call ran.
  type TurnEnd =
    | NoTurnEnd
    | AuthorTurnEnded({ revision: FiledRevision })
    | AuthorTurnFailed(TurnFailure)
    | AuthorTurnStartsOver
    | RefinerTurnEnded(int)

  /// What an observer knows about the last step besides the reviews around it: the turn that
  /// ended, what happened on the document host, whether the host took a model-call author's
  /// writes, what the agent read about page comments, whether a new instance took over, the
  /// refiner run that hit a failure it may recover from, and how the lookups of the revision went.
  type StepKind = {
    turnEnd: TurnEnd,
    page: PageFact,
    write: PageWrite,
    agentHeard: Set[AgentNote],
    instanceRestarted: bool,
    recoverableFailure: RecoverableFailure,
    revisionLookup: RevisionLookup,
  }

  /// One step: the review before it, the review after it, and what an observer knows of it.
  type Transition = { before: ReviewLoop, after: ReviewLoop, kind: StepKind }

  /// Whether the last step kept each before-and-after rule, by the name of the invariant that reads
  /// it. Each step writes it again, so the state does not keep the review before the step.
  type KeptRules = {
    judgeRulesAtMostOnce: bool,
    refinerRunIsDoneOnlyAfterItsTurnEnded: bool,
    refinersRunAgainOnlyOnChangedRevision: bool,
    reviewerRunsOnlyOnAnUnreviewedRevision: bool,
    authorGetsEveryPullFinding: bool,
    authorGetsEveryPageFinding: bool,
    pageReviewPostsEachFindingOnce: bool,
    aPromptToAPageAuthorCarriesItsHeldComments: bool,
    unadmittedFeedbackReachesNobody: bool,
    sentCommentIsAnsweredBeforeItsLineGoes: bool,
    failedReplyLeavesThePage: bool,
    aJudgeRejectionPostsItsReasonOnce: bool,
    aModelCallAuthorFailsOnlyOnAHostError: bool,
    aRefinerRunRestartsAtMostTwice: bool,
    aFinishedRefinerRunKeepsItsStatus: bool,
  }

  /// Whether the last step reached each before-and-after witness, by the name of the witness. Only
  /// witnesses read it, so model checking leaves it out of the state.
  type ReachedWitnesses = {
    aRulingLandsOnARuledJudgeRun: bool,
    aReviewerRunsAgainOnANewRevision: bool,
    aRefinerRunEndsDone: bool,
    aRefinerRunStartsAfterAHandover: bool,
    aRefinerRunStartsPastFindings: bool,
    aRefinerRunStartsPastAJudgeWithFindings: bool,
    aPageAuthorGetsTheFindingsOfItsReviewer: bool,
    aStaleReviewRunsTheSegmentAgain: bool,
    aPageReviewPostsAnInlineFinding: bool,
    aPageReviewMovesInlineFindingsIntoItsOutcome: bool,
    aPageReviewMeetsAHostThatIsDown: bool,
    heldCommentsGoToThePageAuthor: bool,
    heldCommentsStayHeld: bool,
    theHostKeepsHeldCommentsHeld: bool,
    theScreenKeepsHeldComments: bool,
    aMentionRoutedAwayLeavesHeldComments: bool,
    aPersonRepliesWhileTheScreenReads: bool,
    aHeldCommentReachesTheAuthor: bool,
    aRevisionRewritesTheBlockOfAnAnsweredComment: bool,
    aRevisionAnswersAQueuedComment: bool,
    aCommentReplyFails: bool,
    aRejectionLandsOnThePage: bool,
    theHostFailsARejection: bool,
    theHostFailsAModelCallAuthor: bool,
    aPersonEditsDuringAModelCallTurn: bool,
    aModelCallTurnStartsOver: bool,
    aRulingCallIsLostWithTheInstance: bool,
    aJudgeClosesWithoutAConclusion: bool,
    aRefinerRunFailsPastItsRestarts: bool,
    aRefinerRunStartsAfterAFailedOrCancelledOne: bool,
    aReviewerRunsAgainOnAnUnknownRevision: bool,
    aRefinerRunStartsAfterAnUnknownRevision: bool,
    aRefinerRunStartsAfterAnUnknownHandover: bool,
  }

  /// A model-call author's turn end: the review after it and how the turn ended.
  type ModelCallTurnEnd = { loop: ReviewLoop, turnEnd: TurnEnd }

  /// What an author's turn end meets: whether the host takes a model-call author's writes, the
  /// review again decision, and how the lookups of the revision go.
  type TurnEndAnswers = { write: PageWrite, decision: ReviewAgainDecision, lookup: RevisionLookup }

  /// What a read of the held comments did: the review after it, the comments a prompt carried, and
  /// what the agent read.
  type HeldCommentsSent = { loop: ReviewLoop, carried: Set[int], agentHeard: Set[AgentNote] }

  /// What a mention did: the review after it, what happened on the host, and what the agent read.
  type MentionHandled = { loop: ReviewLoop, page: PageFact, agentHeard: Set[AgentNote] }
}

/// The review loop over one stage's refiner list.
module reviewLoop {
  import reviewLoopTypes.*

  /// The refiner list of the stage.
  const ENTRIES: List[Refiner]

  /// True when the author is a model-call author, false for a harness author. A model-call
  /// author writes a page.
  const MODEL_CALL_AUTHOR: bool

  /// The kind of the artifact the author writes.
  const ARTIFACT: ArtifactKind

  /// True when a new Durable Object instance can take over the workflow.
  const INSTANCE_RESTARTS: bool

  /// True when a lookup of the revision on the host can fail.
  const UNREADABLE_REVISIONS: bool

  /// How often one reviewer runs on one artifact. The config default.
  pure val MAX_REVIEW_RUNS: int = 3

  /// How often a refiner run starts over after it gave up. The next time it fails.
  pure val MAX_RESTARTS: int = 2

  /// How many person comments a page holds at most, so an exhaustive check ends.
  pure val MAX_PERSON_COMMENTS: int = 6

  /// How many prompts wait for the author at most, so an exhaustive check ends.
  pure val MAX_QUEUED_PROMPTS: int = 3

  /// Every id a person comment can have.
  pure val PERSON_COMMENT_IDS: Set[int] = 0.to(MAX_PERSON_COMMENTS - 1)

  /// More ids than the comments code posts in any run of the loop.
  pure val REVIEW_COMMENT_IDS: Set[int] = 0.to(63)

  pure val REFINER_COUNT: int = ENTRIES.length()

  pure val REVIEWER_COUNT: int =
    ENTRIES.foldl(0, (count, refiner) => if (refiner == Polisher) count else count + 1)

  pure val ON_A_PAGE: bool = ARTIFACT == Page

  /// The comment a person left on the page before the review began. It is held.
  pure val COMMENT_HELD_AT_OPEN: PersonComment = {
    commentThread: OpenedBy(0),
    onTheBlock: false,
    mentions: false,
    acknowledged: false,
    gone: false,
    sent: false,
    answered: false,
  }

  pure val INITIAL_REVIEW: ReviewLoop = {
    author: {
      atWork: true,
      failed: false,
      queuedPrompts: List(),
      turnComments: Set(),
      pageEditsDuringTurn: Set(),
      rejectedBy: Set(),
      findingsFrom: Set(),
    },
    artifact: { status: Drafted, revision: 0, refinerRun: NoRefinerRun },
    refinerRuns: List(),
    judgeRunsCodeRulesOn: Set(),
    reviewComments: List(),
    personComments: if (ON_A_PAGE) List(COMMENT_HELD_AT_OPEN) else List(),
  }

  pure val REVIEW_AGAIN_DECISIONS: Set[ReviewAgainDecision] =
    if (MODEL_CALL_AUTHOR) Set(ReviewAgain, NoReviewAgain, AgentRoutes) else Set(AgentRoutes)

  /// The parts of the artifact a revision of the author or a polisher rewrites. A pull request
  /// counts as one body.
  pure val REVISION_PARTS: Set[PagePart] = if (ON_A_PAGE) Set(Body, TheBlock) else Set(Body)

  /// The parts of the page a person rewrites.
  pure val PERSON_EDIT_PARTS: Set[PagePart] = Set(Title, Body, TheBlock)

  pure val COMMENTINGS: Set[Commenting] =
    if (ON_A_PAGE) Set(TakesAll, DropsInline, InlineThrows, HostDown) else Set(TakesAll)

  pure val HOST_WRITES: Set[HostWrite] = if (ON_A_PAGE) Set(HostTakes, HostFails) else Set(HostTakes)

  pure val HELD_READS: Set[HeldRead] =
    if (ON_A_PAGE) Set(HostCannotBeRead, ScreenRefuses, AdmittedAndAcknowledged, AdmittedButAcknowledgementFails)
    else Set(AdmittedAndAcknowledged)

  pure val WHILE_SCREENED: Set[WhileScreened] =
    if (ON_A_PAGE) Set(NothingLands, APersonReplies) else Set(NothingLands)

  pure val FEEDBACK_ROUTES: Set[FeedbackRoute] = Set(ToTheAuthor, ToNobody, ToTheAgent)

  pure val MENTION_LOOKUPS: Set[MentionLookup] = Set(TheHostSays, TheHostCannotSay)

  /// The passages of the findings of a page review with findings.
  pure val REVIEW_PASSAGES: Set[Passage] = Set(QuotesThePage, QuotesMissingText, WithoutPassage)

  pure val RESTART_CAUSES: Set[RestartCause] = Set(GivesUp, UnfinishedStop, Stalled, SandboxGone, PromptFails)

  pure val REVISION_LOOKUPS: Set[RevisionLookup] =
    if (UNREADABLE_REVISIONS) Set(RevisionKnown, RevisionUnknown) else Set(RevisionKnown)

  var review: ReviewLoop
  var lastStepKept: KeptRules
  var lastStepReached: ReachedWitnesses
  /// What the agent read about page comments in the last step. Only the replay reads it, so model
  /// checking leaves it out of the state.
  var agentHeard: Set[AgentNote]
  /// How often a new instance took over the workflow, a counter that model checking bounds.
  var instanceRestartCount: int

  pure def larger(left: int, right: int): int = if (left > right) left else right

  pure def smaller(left: int, right: int): int = if (left < right) left else right

  pure def largest(numbers: Set[int], floor: int): int =
    numbers.fold(floor, (found, number) => larger(found, number))

  pure def smallest(numbers: Set[int], ceiling: int): int =
    numbers.fold(ceiling, (found, number) => smaller(found, number))

  pure def refinerOf(refinerRun: RefinerRun): Refiner = ENTRIES[refinerRun.refinerIndex]

  pure def endsSegment(index: int): bool =
    index < REVIEWER_COUNT and (ENTRIES[index] == Judge or index == REVIEWER_COUNT - 1)

  pure def segmentStartOf(index: int): int =
    largest(ENTRIES.indices().filter(start => start <= index and (start == 0 or endsSegment(start - 1))), 0)

  pure def isRuling(result: RefinerResult): bool =
    match result { | FiledRuling(_) => true | _ => false }

  pure def isRejection(result: RefinerResult): bool =
    match result { | FiledRuling(filed) => filed.ruling == Rejected | _ => false }

  pure def filedOnRevision(result: RefinerResult, revision: FiledRevision): bool =
    match result {
      | FiledReview(filed) => filed.revision == revision
      | FiledRuling(filed) => filed.revision == revision
      | NoResult => false
      | RulingAsked => false
    }

  pure def isReview(result: RefinerResult): bool =
    match result { | FiledReview(_) => true | _ => false }

  pure def reviewHasFindings(result: RefinerResult): bool =
    match result { | FiledReview(filed) => filed.findings | _ => false }

  pure def reviewedRevisionIsNot(result: RefinerResult, revision: FiledRevision): bool =
    match result { | FiledReview(filed) => filed.revision != revision | _ => false }

  pure def runIds(loop: ReviewLoop): Set[int] = loop.refinerRuns.indices()

  /// What the host gives as the revision of the artifact when its lookups go `lookup`.
  pure def hostRevision(loop: ReviewLoop, lookup: RevisionLookup): FiledRevision =
    if (lookup == RevisionKnown) ReadRevision(loop.artifact.revision) else UnknownRevision

  pure def unfinishedRunIds(loop: ReviewLoop): Set[int] =
    runIds(loop).filter(id => loop.refinerRuns[id].status == Unfinished)

  /// The unfinished refiner run the agent and the sandboxes act on. Only defined while one exists.
  pure def lastUnfinishedRun(loop: ReviewLoop): int = largest(unfinishedRunIds(loop), 0)

  /// True when an unfinished refiner run of `refiner` is the one the sandboxes act on.
  pure def unfinishedRunIs(loop: ReviewLoop, refiner: Refiner): bool = and {
    unfinishedRunIds(loop).size() > 0,
    refinerOf(loop.refinerRuns[lastUnfinishedRun(loop)]) == refiner,
  }

  pure def isOnRun(loop: ReviewLoop, id: int): bool =
    loop.artifact.refinerRun == OnRefinerRun(id)

  pure def holdsARun(loop: ReviewLoop): bool = loop.artifact.refinerRun != NoRefinerRun

  /// The refiner run the artifact is on. Only defined while it is on one.
  pure def heldRun(loop: ReviewLoop): int =
    match loop.artifact.refinerRun { | OnRefinerRun(id) => id | NoRefinerRun => 0 }

  pure def drafted(loop: ReviewLoop): bool = loop.artifact.status == Drafted

  pure def authorQuiet(loop: ReviewLoop): bool =
    not(loop.author.atWork) and loop.author.queuedPrompts.length() == 0

  pure def refinerInFlight(loop: ReviewLoop): bool =
    match loop.artifact.refinerRun {
      | NoRefinerRun => false
      | OnRefinerRun(id) => loop.refinerRuns[id].status == Unfinished
    }

  pure def polisherRunning(loop: ReviewLoop): bool =
    match loop.artifact.refinerRun {
      | NoRefinerRun => false
      | OnRefinerRun(id) =>
        refinerOf(loop.refinerRuns[id]) == Polisher and loop.refinerRuns[id].status == Unfinished
    }

  pure def judgeRuledOn(loop: ReviewLoop, index: int): bool = and {
    index < REVIEWER_COUNT,
    ENTRIES[index] == Judge,
    runIds(loop).exists(id =>
      loop.refinerRuns[id].refinerIndex == index and isRuling(loop.refinerRuns[id].result)),
  }

  /// True when a run of the entry at `index` filed a review or a ruling of the current revision.
  /// No entry read an unknown revision.
  pure def entryReadRevision(loop: ReviewLoop, index: int, lookup: RevisionLookup): bool =
    lookup == RevisionKnown and runIds(loop).exists(id =>
      loop.refinerRuns[id].refinerIndex == index and
      filedOnRevision(loop.refinerRuns[id].result, hostRevision(loop, lookup)))

  /// The entry that ends the segment `index` sits in.
  pure def segmentEndOf(index: int): int =
    smallest(ENTRIES.indices().filter(end => end >= index and endsSegment(end)), REVIEWER_COUNT - 1)

  /// True when the entry at `index` still has a say on the revision. An entry that reviewed or
  /// ruled on it has not, and neither has a judge entry that ruled on any revision.
  pure def hasASay(loop: ReviewLoop, index: int, lookup: RevisionLookup): bool =
    not(judgeRuledOn(loop, index)) and not(entryReadRevision(loop, index, lookup))

  /// The entries from `from` to the end of its segment that still have a say on the revision.
  pure def unreviewedEntriesFrom(loop: ReviewLoop, from: int, lookup: RevisionLookup): Set[int] =
    ENTRIES.indices().filter(index => and {
      index >= from,
      index < REVIEWER_COUNT,
      index <= segmentEndOf(from),
      hasASay(loop, index, lookup),
    })

  /// The latest run of the entry at `index`. Only defined while the entry has one.
  pure def latestRunOf(loop: ReviewLoop, index: int): int =
    largest(runIds(loop).filter(id => loop.refinerRuns[id].refinerIndex == index), 0)

  pure def runNumberOf(loop: ReviewLoop, id: int): int =
    runIds(loop)
      .filter(earlier =>
        earlier <= id and
        loop.refinerRuns[earlier].refinerIndex == loop.refinerRuns[id].refinerIndex)
      .size()

  pure def reviewLimitReached(loop: ReviewLoop, id: int): bool =
    runNumberOf(loop, id) >= MAX_REVIEW_RUNS

  pure def withRun(loop: ReviewLoop, id: int, refinerRun: RefinerRun): ReviewLoop =
    { ...loop, refinerRuns: loop.refinerRuns.replaceAt(id, refinerRun) }

  pure def withStatus(loop: ReviewLoop, id: int, status: RunStatus): ReviewLoop =
    withRun(loop, id, { ...loop.refinerRuns[id], status: status })

  pure def withoutRefinerRun(loop: ReviewLoop): ReviewLoop =
    { ...loop, artifact: { ...loop.artifact, refinerRun: NoRefinerRun } }

  /// The humans get the artifact, and the handover records the revision the host gives. A ready
  /// artifact keeps the revision they already have.
  pure def handOver(loop: ReviewLoop, lookup: RevisionLookup): ReviewLoop = {
    val status = match loop.artifact.status {
      | Drafted => Ready({ deliveredRevision: hostRevision(loop, lookup) })
      | Ready(handed) => Ready(handed)
    }
    { ...loop, artifact: { ...loop.artifact, status: status, refinerRun: NoRefinerRun } }
  }

  pure def startRefiner(loop: ReviewLoop, index: int): ReviewLoop = {
    val refinerRun = { refinerIndex: index, status: Unfinished, result: NoResult, restarts: 0 }
    {
      ...loop,
      refinerRuns: loop.refinerRuns.append(refinerRun),
      artifact: { ...loop.artifact, refinerRun: OnRefinerRun(loop.refinerRuns.length()) },
    }
  }

  /// Run the first entry at or after `index` that still has a say, or hand the artifact over.
  pure def runRefinersFrom(loop: ReviewLoop, index: int, lookup: RevisionLookup): ReviewLoop = {
    val nextIndex = smallest(
      ENTRIES.indices().filter(candidate => candidate >= index and hasASay(loop, candidate, lookup)),
      REFINER_COUNT,
    )
    if (nextIndex >= REFINER_COUNT) handOver(loop, lookup) else startRefiner(loop, nextIndex)
  }

  /// Change every person comment with `change`, which reads the comment's id.
  pure def changeComments(loop: ReviewLoop, change: (int, PersonComment) => PersonComment): ReviewLoop = {
    ...loop,
    personComments: loop.personComments.foldl(List(), (changed, comment) =>
      changed.append(change(changed.length(), comment))),
  }

  pure def isHeld(comment: PersonComment): bool = not(comment.acknowledged) and not(comment.gone)

  /// The person comments the host shows as held.
  pure def heldCommentIds(loop: ReviewLoop): Set[int] =
    personCommentIds(loop).filter(id => isHeld(loop.personComments[id]))

  /// Mark these comments read on the page, and no other. Each is the earliest held comment of its
  /// comment thread, so a reply that landed in the thread after the read stays held.
  pure def acknowledge(loop: ReviewLoop, ids: Set[int]): ReviewLoop =
    changeComments(loop, (id, comment) => if (ids.contains(id)) { ...comment, acknowledged: true } else comment)

  pure def markSent(loop: ReviewLoop, ids: Set[int]): ReviewLoop =
    changeComments(loop, (id, comment) => if (ids.contains(id)) { ...comment, sent: true } else comment)

  pure def markAnswered(loop: ReviewLoop, ids: Set[int]): ReviewLoop =
    changeComments(loop, (id, comment) => if (ids.contains(id)) { ...comment, answered: true } else comment)

  /// A person comment, held, in `commentThread`.
  pure def newComment(commentThread: CommentThread, onTheBlock: bool, mentions: bool): PersonComment = {
    commentThread: commentThread,
    onTheBlock: onTheBlock,
    mentions: mentions,
    acknowledged: false,
    gone: false,
    sent: false,
    answered: false,
  }

  /// The ids of the person comments on the page.
  pure def personCommentIds(loop: ReviewLoop): Set[int] =
    PERSON_COMMENT_IDS.filter(id => id < loop.personComments.length())

  /// Room on the page for `count` more person comments.
  pure def roomForComments(loop: ReviewLoop, count: int): bool =
    loop.personComments.length() + count <= MAX_PERSON_COMMENTS

  /// Room in the author's queue for one more prompt.
  pure def roomForAPrompt(loop: ReviewLoop): bool =
    loop.author.queuedPrompts.length() < MAX_QUEUED_PROMPTS

  /// A person leaves a comment at `place`.
  pure def withPersonComment(loop: ReviewLoop, place: CommentPlace): ReviewLoop = {
    val id = loop.personComments.length()
    val comment = match place {
      | OnThePageAsAWhole => newComment(OpenedBy(id), false, false)
      | OnTheBlock => newComment(OpenedBy(id), true, false)
      | InTheCommentThreadOf(earlier) =>
        newComment(loop.personComments[earlier].commentThread, loop.personComments[earlier].onTheBlock, false)
      | UnderTheReviewComment(posted) => newComment(UnderReviewComment(posted), false, false)
    }
    { ...loop, personComments: loop.personComments.append(comment) }
  }

  /// Where a person can comment now: on the page, on the block, in the comment thread of a comment
  /// whose block is there, or under a comment code posted.
  pure def commentPlaces(loop: ReviewLoop): Set[CommentPlace] =
    Set(OnThePageAsAWhole, OnTheBlock)
      .union(personCommentIds(loop)
        .filter(id => not(loop.personComments[id].gone))
        .map(id => InTheCommentThreadOf(id)))
      .union(REVIEW_COMMENT_IDS
        .filter(id => id < loop.reviewComments.length())
        .map(id => UnderTheReviewComment(id)))

  /// An edit rewrites `part` of the artifact. A comment on the rewritten block goes with it.
  pure def pageChanged(loop: ReviewLoop, part: PagePart): ReviewLoop = {
    val edited = { ...loop, artifact: { ...loop.artifact, revision: loop.artifact.revision + 1 } }
    if (part == TheBlock)
      changeComments(edited, (_, comment) => if (comment.onTheBlock) { ...comment, gone: true } else comment)
    else edited
  }

  /// Send the oldest queued prompt when the author can take it. A model-call author's turn reads
  /// the page as it starts.
  pure def drainQueue(loop: ReviewLoop): ReviewLoop =
    if (not(loop.author.atWork) and loop.author.queuedPrompts.length() > 0 and not(polisherRunning(loop)))
      {
        ...loop,
        author: {
          ...loop.author,
          atWork: true,
          queuedPrompts: loop.author.queuedPrompts.tail(),
          turnComments: if (MODEL_CALL_AUTHOR) loop.author.queuedPrompts.head() else Set(),
          pageEditsDuringTurn: Set(),
        },
      }
    else loop

  /// Queue a prompt for the author that carries these person comments.
  pure def promptAuthorWith(loop: ReviewLoop, comments: Set[int]): ReviewLoop = {
    val queued = { ...loop, author: { ...loop.author, queuedPrompts: loop.author.queuedPrompts.append(comments) } }
    drainQueue(markSent(queued, comments))
  }

  pure def promptAuthor(loop: ReviewLoop): ReviewLoop = promptAuthorWith(loop, Set())

  /// The author gets one prompt that carries the findings of these reviews.
  pure def sendFindingsToAuthor(loop: ReviewLoop, reviewRuns: Set[int]): ReviewLoop = {
    val withFindings = reviewRuns.filter(id => reviewHasFindings(loop.refinerRuns[id].result))
    promptAuthor({ ...loop, author: { ...loop.author, findingsFrom: loop.author.findingsFrom.union(withFindings) } })
  }

  /// The refiner runs whose reviews the segment that ends at `end` filed: the latest run of each
  /// of its entries, when that run filed a review.
  pure def segmentReviewRuns(loop: ReviewLoop, end: int): Set[int] =
    runIds(loop).filter(id => and {
      loop.refinerRuns[id].refinerIndex >= segmentStartOf(end),
      loop.refinerRuns[id].refinerIndex <= end,
      id == latestRunOf(loop, loop.refinerRuns[id].refinerIndex),
      isReview(loop.refinerRuns[id].result),
    })

  /// Point the artifact at the latest run of the last findings entry of the segment that ends at
  /// `end`, so the author's answer to the segment's review is routed from there.
  pure def pointAtLastReviewerOfSegment(loop: ReviewLoop, end: int): ReviewLoop = {
    val lastReviewer = if (ENTRIES[end] == Judge) end - 1 else end
    val runs = runIds(loop).filter(id => loop.refinerRuns[id].refinerIndex == lastReviewer)
    if (runs.size() == 0) loop
    else { ...loop, artifact: { ...loop.artifact, refinerRun: OnRefinerRun(largest(runs, 0)) } }
  }

  /// A working author stops the refiners. They run again once its turn ends.
  pure def advancePastEntry(loop: ReviewLoop, index: int, lookup: RevisionLookup): ReviewLoop =
    if (authorQuiet(loop)) runRefinersFrom(loop, index + 1, lookup) else withoutRefinerRun(loop)

  /// Run the open segment again from its first entry that still has a say on the revision. Hand the
  /// artifact on when no entry of it still has a say.
  pure def reviewSegmentAgain(loop: ReviewLoop, index: int, lookup: RevisionLookup): ReviewLoop = {
    val unreviewed = unreviewedEntriesFrom(loop, segmentStartOf(index), lookup)
    if (unreviewed.size() == 0) advancePastEntry(loop, index, lookup)
    else startRefiner(loop, smallest(unreviewed, REFINER_COUNT))
  }

  /// A findings reviewer's artifact goes where the review again decision says. Without one, the
  /// agent routes it.
  pure def routeFindingsReviewer(
    loop: ReviewLoop,
    index: int,
    decision: ReviewAgainDecision,
    lookup: RevisionLookup,
  ): ReviewLoop =
    match decision {
      | ReviewAgain => reviewSegmentAgain(loop, index, lookup)
      | NoReviewAgain => advancePastEntry(loop, index, lookup)
      | AgentRoutes => loop
    }

  pure def settleHeldRun(
    loop: ReviewLoop,
    id: int,
    decision: ReviewAgainDecision,
    lookup: RevisionLookup,
  ): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    if (refinerOf(refinerRun) == Polisher) runRefinersFrom(withoutRefinerRun(loop), 0, lookup)
    else if (refinerOf(refinerRun) == FindingsReviewer)
      (if (reviewLimitReached(loop, id)) advancePastEntry(loop, refinerRun.refinerIndex, lookup)
       else routeFindingsReviewer(loop, refinerRun.refinerIndex, decision, lookup))
    else if (isRejection(refinerRun.result)) runRefinersFrom(loop, refinerRun.refinerIndex + 1, lookup)
    else loop
  }

  /// The refiners settle once the author is quiet.
  pure def settleRefiners(loop: ReviewLoop, decision: ReviewAgainDecision, lookup: RevisionLookup): ReviewLoop =
    if (not(drafted(loop)) or refinerInFlight(loop) or not(authorQuiet(loop))) loop
    else match loop.artifact.refinerRun {
      | NoRefinerRun => runRefinersFrom(loop, 0, lookup)
      | OnRefinerRun(id) => settleHeldRun(loop, id, decision, lookup)
    }

  /// A ready artifact stays with the humans only when the host gives the revision they have. A
  /// changed or unknown revision makes it a draft again.
  pure def reopenChangedArtifact(loop: ReviewLoop, lookup: RevisionLookup): ReviewLoop =
    match loop.artifact.status {
      | Drafted => loop
      | Ready(handed) =>
        if (lookup == RevisionKnown and handed.deliveredRevision == hostRevision(loop, lookup)) loop
        else { ...loop, artifact: { ...loop.artifact, status: Drafted, refinerRun: NoRefinerRun } }
    }

  /// The author's turn ends on the revision `loop` holds.
  pure def authorTurnEnded(loop: ReviewLoop, decision: ReviewAgainDecision, lookup: RevisionLookup): ReviewLoop = {
    val ended = {
      ...loop,
      author: { ...loop.author, atWork: false, turnComments: Set(), pageEditsDuringTurn: Set() },
    }
    drainQueue(settleRefiners(reopenChangedArtifact(ended, lookup), decision, lookup))
  }

  /// The author fails. Its queued prompts go, its unfinished refiner run is cancelled, and the
  /// humans get the artifact.
  pure def failAuthor(loop: ReviewLoop, lookup: RevisionLookup): ReviewLoop = {
    val stopped = {
      ...loop,
      author: {
        ...loop.author,
        atWork: false,
        failed: true,
        queuedPrompts: List(),
        turnComments: Set(),
        pageEditsDuringTurn: Set(),
      },
    }
    handOver(if (refinerInFlight(stopped)) withStatus(stopped, heldRun(stopped), Cancelled) else stopped, lookup)
  }

  pure def turnFailed(loop: ReviewLoop, failure: TurnFailure, lookup: RevisionLookup): ModelCallTurnEnd =
    { loop: failAuthor(loop, lookup), turnEnd: AuthorTurnFailed(failure) }

  pure def turnEnded(loop: ReviewLoop, decision: ReviewAgainDecision, lookup: RevisionLookup): ModelCallTurnEnd = {
    val ended = authorTurnEnded(loop, decision, lookup)
    { loop: ended, turnEnd: AuthorTurnEnded({ revision: hostRevision(ended, lookup) }) }
  }

  /// The person comments the prompts that wait for the author carry.
  pure def queuedComments(loop: ReviewLoop): Set[int] =
    loop.author.queuedPrompts.foldl(Set(), (comments, prompt) => comments.union(prompt))

  /// True when a person changed the page text since the author's turn read it.
  pure def pageTextEditedDuringTurn(loop: ReviewLoop): bool =
    loop.author.pageEditsDuringTurn.size() > 0

  /// The comment replies a model-call author's revise turn posts: one to each comment its prompt
  /// carries that is still on the page, then one to each comment a queued prompt carries on the
  /// block the change rewrites.
  pure def turnReplies(loop: ReviewLoop, changed: bool, part: PagePart): Set[int] = {
    val rewritten =
      if (changed and part == TheBlock)
        queuedComments(loop).filter(id => loop.personComments[id].onTheBlock)
      else Set()
    loop.author.turnComments.union(rewritten).filter(id => not(loop.personComments[id].gone))
  }

  /// The turn runs again on the current page: it keeps its prompt and drops what it read.
  pure def startOver(loop: ReviewLoop): ModelCallTurnEnd =
    { loop: { ...loop, author: { ...loop.author, pageEditsDuringTurn: Set() } }, turnEnd: AuthorTurnStartsOver }

  /// A model-call author's revise turn ends. When a person changed the page text while its model
  /// call ran, it starts over on the current page without a write. Otherwise it posts its comment
  /// replies and stops at the first the host does not take. Then it writes the page text change.
  pure def modelCallTurnEnds(
    loop: ReviewLoop,
    changed: bool,
    part: PagePart,
    answers: TurnEndAnswers,
  ): ModelCallTurnEnd = {
    val write = answers.write
    val lookup = answers.lookup
    val replies = turnReplies(loop, changed, part)
    val replied = markAnswered(loop, replies)
    if (pageTextEditedDuringTurn(loop)) startOver(loop)
    else if (write == WriteFails(RepliesFail) and replies.size() > 0) turnFailed(loop, ReplyRefused, lookup)
    else if (not(changed)) turnEnded(replied, answers.decision, lookup)
    else if (write == WriteFails(UpdateFails)) turnFailed(replied, UpdateRefused, lookup)
    else if (write == WriteFails(UpdateLandsThenFails))
      turnFailed(pageChanged(replied, part), UpdateLandedThenFailed, lookup)
    else turnEnded(pageChanged(replied, part), answers.decision, lookup)
  }

  /// The author's turn ends, after it changed `part` of the artifact or without a change.
  pure def authorTurnEnds(loop: ReviewLoop, changed: bool, part: PagePart, answers: TurnEndAnswers): ModelCallTurnEnd =
    if (MODEL_CALL_AUTHOR) modelCallTurnEnds(loop, changed, part, answers)
    else turnEnded(if (changed) pageChanged(loop, part) else loop, answers.decision, answers.lookup)

  /// A ruling settles the judge's segment. A rejection posts its reason on a page when the host
  /// takes it, and reaches the author with the findings of the reviewers before the judge. An
  /// approval sends those findings on their own, or moves on.
  pure def applyJudgeRuling(
    loop: ReviewLoop,
    id: int,
    ruling: Ruling,
    post: HostWrite,
    lookup: RevisionLookup,
  ): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    val index = refinerRun.refinerIndex
    val filed = FiledRuling({ ruling: ruling, revision: hostRevision(loop, lookup) })
    val ruled = withRun(loop, id, { ...refinerRun, result: filed })
    val reviewRuns = segmentReviewRuns(ruled, index)
    val findingsBeforeJudge = reviewRuns.exists(reviewRun => reviewHasFindings(ruled.refinerRuns[reviewRun].result))
    if (ruling == Rejected) {
      val rejectedBy = ruled.author.rejectedBy.union(Set(index))
      val posted =
        if (ON_A_PAGE and post == HostTakes) ruled.reviewComments.append(RejectionComment(id))
        else ruled.reviewComments
      sendFindingsToAuthor({ ...ruled, reviewComments: posted, author: { ...ruled.author, rejectedBy: rejectedBy } }, reviewRuns)
    }
    else if (findingsBeforeJudge) sendFindingsToAuthor(pointAtLastReviewerOfSegment(ruled, index), reviewRuns)
    else advancePastEntry(ruled, index, lookup)
  }

  /// A segment settles on the review of the latest run of each entry. A stale review runs the
  /// list again from the segment's first entry that still has a say on the revision. No review is
  /// stale against an unknown revision.
  pure def settleSegment(loop: ReviewLoop, end: int, lookup: RevisionLookup): ReviewLoop = {
    val start = segmentStartOf(end)
    val filed = segmentReviewRuns(loop, end)
    val stale = lookup == RevisionKnown and filed.exists(id =>
      reviewedRevisionIsNot(loop.refinerRuns[id].result, hostRevision(loop, lookup)))
    if (filed.size() == 0) advancePastEntry(loop, end, lookup)
    else if (stale and not(authorQuiet(loop))) settleRefiners(loop, AgentRoutes, lookup)
    else if (stale) runRefinersFrom(loop, start, lookup)
    else if (filed.exists(id => reviewHasFindings(loop.refinerRuns[id].result))) sendFindingsToAuthor(loop, filed)
    else advancePastEntry(loop, end, lookup)
  }

  /// The comments a page review posts: each finding that quotes a passage the page holds on its
  /// block, then one outcome comment with every other finding. A host that fails the inline call
  /// or drops the inline findings moves them into the outcome comment.
  pure def pageReviewComments(id: int, findings: bool, commenting: Commenting): List[ReviewComment] =
    if (commenting == HostDown) List()
    else if (not(findings)) List(OutcomeComment({ refinerRun: id, findings: Set(), approves: true }))
    else if (commenting == TakesAll)
      List(
        InlineFinding({ refinerRun: id, passage: QuotesThePage }),
        OutcomeComment({ refinerRun: id, findings: Set(QuotesMissingText, WithoutPassage), approves: false }),
      )
    else List(OutcomeComment({ refinerRun: id, findings: REVIEW_PASSAGES, approves: false }))

  /// A finished reviewer posts its review on a page first. Then it hands on while a later entry of
  /// its segment still has a say. Otherwise the segment settles, on the last findings entry of
  /// it. A judge that ruled has no say. A pull request review names the commit it read. A page
  /// review reads the revision from the host after its post.
  pure def findingsReviewerFinished(
    loop: ReviewLoop,
    id: int,
    findings: bool,
    commenting: Commenting,
    lookup: RevisionLookup,
  ): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    val index = refinerRun.refinerIndex
    val reviewed = if (ON_A_PAGE) hostRevision(loop, lookup) else ReadRevision(loop.artifact.revision)
    val filed = FiledReview({ revision: reviewed, findings: findings })
    val posted =
      if (ON_A_PAGE) loop.reviewComments.concat(pageReviewComments(id, findings, commenting))
      else loop.reviewComments
    val done = withRun({ ...loop, reviewComments: posted }, id, { ...refinerRun, status: Done, result: filed })
    val end = segmentEndOf(index)
    val handsOn = index != end and unreviewedEntriesFrom(done, index + 1, lookup).size() > 0
    if (not(isOnRun(loop, id)) or not(drafted(loop))) done
    else if (handsOn) advancePastEntry(done, index, lookup)
    else settleSegment(pointAtLastReviewerOfSegment(done, end), end, lookup)
  }

  pure def judgeFinished(loop: ReviewLoop, id: int): ReviewLoop = {
    val done = withStatus(loop, id, Done)
    if (isOnRun(loop, id) and drafted(loop))
      { ...done, judgeRunsCodeRulesOn: done.judgeRunsCodeRulesOn.union(Set(id)) }
    else done
  }

  /// True when a ruling the decisions model gives on this judge run lands.
  pure def rulingLands(loop: ReviewLoop, id: int): bool =
    isOnRun(loop, id) and drafted(loop) and not(isRuling(loop.refinerRuns[id].result))

  /// A ruling lands only on the judge run the artifact is still on, and only once.
  pure def decisionsModelRuled(
    loop: ReviewLoop,
    id: int,
    ruling: Ruling,
    post: HostWrite,
    lookup: RevisionLookup,
  ): ReviewLoop = {
    val answered = {
      ...loop,
      judgeRunsCodeRulesOn: loop.judgeRunsCodeRulesOn.exclude(Set(id)),
    }
    if (rulingLands(answered, id)) applyJudgeRuling(answered, id, ruling, post, lookup)
    else answered
  }

  pure def canPersonRuleOn(loop: ReviewLoop, id: int): bool = and {
    drafted(loop),
    refinerOf(loop.refinerRuns[id]) == Judge,
    loop.refinerRuns[id].status != Unfinished,
    not(isRuling(loop.refinerRuns[id].result)),
  }

  pure def polisherFinished(
    loop: ReviewLoop,
    id: int,
    pushed: bool,
    part: PagePart,
    lookup: RevisionLookup,
  ): ReviewLoop = {
    val changed = if (pushed) pageChanged(loop, part) else loop
    val done = withStatus(changed, id, Done)
    val handedOn =
      if (isOnRun(done, id) and drafted(done)) advancePastEntry(done, loop.refinerRuns[id].refinerIndex, lookup)
      else done
    drainQueue(handedOn)
  }

  /// A polisher that stops early gives the artifact to the humans with what it pushed.
  pure def polisherStopped(loop: ReviewLoop, id: int, lookup: RevisionLookup): ReviewLoop =
    drainQueue(if (isOnRun(loop, id)) handOver(loop, lookup) else loop)

  pure def reviewerFailed(loop: ReviewLoop, id: int, lookup: RevisionLookup): ReviewLoop =
    if (not(isOnRun(loop, id))) loop
    else if (drafted(loop)) handOver(loop, lookup)
    else withoutRefinerRun(loop)

  pure def refinerRunFailed(loop: ReviewLoop, id: int, lookup: RevisionLookup): ReviewLoop = {
    val failed = withStatus(loop, id, Failed)
    if (refinerOf(loop.refinerRuns[id]) == Polisher) polisherStopped(failed, id, lookup)
    else reviewerFailed(failed, id, lookup)
  }

  pure def canRequestReviewOn(loop: ReviewLoop, id: int, lookup: RevisionLookup): bool = and {
    loop.refinerRuns[id].refinerIndex < REVIEWER_COUNT,
    refinerOf(loop.refinerRuns[id]) != Judge or loop.refinerRuns[id].status == Cancelled,
    not(reviewLimitReached(loop, id)),
    unreviewedEntriesFrom(loop, segmentStartOf(loop.refinerRuns[id].refinerIndex), lookup).size() > 0,
  }

  pure def agentCanRoute(loop: ReviewLoop): bool = and {
    drafted(loop),
    not(polisherRunning(loop)),
    not(refinerInFlight(loop)),
    authorQuiet(loop),
  }

  /// A person replies in the comment thread of the comment `id` while the screen reads.
  pure def personRepliesTo(loop: ReviewLoop, id: int): ReviewLoop =
    withPersonComment(loop, InTheCommentThreadOf(id))

  pure def admits(read: HeldRead): bool =
    read == AdmittedAndAcknowledged or read == AdmittedButAcknowledgementFails

  /// Read the held comments and screen them. Admitted, they are marked read on the page, and the
  /// ones the host marked go to the author in a prompt. Otherwise they stay held and the agent is
  /// told so. `agentText` is true when the agent's own text goes to the author whatever the read
  /// found.
  pure def sendHeldComments(
    loop: ReviewLoop,
    read: HeldRead,
    meanwhile: WhileScreened,
    agentText: bool,
  ): HeldCommentsSent = {
    val held = heldCommentIds(loop)
    val screened = read != HostCannotBeRead and held.size() > 0
    val during =
      if (screened and meanwhile == APersonReplies) personRepliesTo(loop, smallest(held, loop.personComments.length())) else loop
    val marked = screened and read == AdmittedAndAcknowledged
    val carried = if (marked) held else Set()
    val acknowledged = acknowledge(during, carried)
    val prompted = if (agentText or marked) promptAuthorWith(acknowledged, carried) else acknowledged
    val stayHeld = read == HostCannotBeRead or (screened and not(marked))
    { loop: prompted, carried: carried, agentHeard: if (stayHeld) Set(HeldCommentsStayHeld) else Set() }
  }

  /// A person's comment mentions the bot. When the host says so, the held comments go out with
  /// it as one feedback: screened, then routed. The mention is marked read on the page. The held
  /// comments are marked read only on the author route, which prompts the author with the
  /// comments the host marked. On every other route they stay held. The agent reads the mention
  /// with the event in every case. When the host cannot say, the comment waits as a held comment.
  pure def mentionArrives(
    loop: ReviewLoop,
    lookup: MentionLookup,
    read: HeldRead,
    meanwhile: WhileScreened,
    route: FeedbackRoute,
  ): MentionHandled = {
    val mention = loop.personComments.length()
    val withMention = { ...loop, personComments: loop.personComments.append(newComment(OpenedBy(mention), false, true)) }
    val held = heldCommentIds(withMention).exclude(Set(mention))
    val screened = held.size() > 0
    val during =
      if (screened and meanwhile == APersonReplies) personRepliesTo(withMention, smallest(held, mention)) else withMention
    val refused = screened and read == ScreenRefuses
    val readHeld = if (read == ScreenRefuses and not(screened)) AdmittedAndAcknowledged else read
    val marks = readHeld == AdmittedAndAcknowledged
    val toTheAuthor = route == ToTheAuthor and not(loop.author.failed)
    val carried = if (marks and toTheAuthor) held.union(Set(mention)) else Set()
    val acknowledged = acknowledge(during, if (marks) carried.union(Set(mention)) else Set())
    val stayHeld = screened and not(marks and toTheAuthor)
    val asked = HeldCommentsAsked({ by: AMention, read: readHeld, carried: carried })
    if (lookup == TheHostCannotSay) { loop: withMention, page: NoPageFact, agentHeard: Set() }
    else if (read == HostCannotBeRead) {
      loop: withMention,
      page: asked,
      agentHeard: Set(HeldCommentsStayHeld, MentionText),
    }
    else if (refused) { loop: during, page: asked, agentHeard: Set(MentionText) }
    else {
      loop: if (carried.size() > 0) promptAuthorWith(acknowledged, carried) else acknowledged,
      page: asked,
      agentHeard: Set(MentionText)
        .union(if (screened) Set(HeldCommentText) else Set())
        .union(if (stayHeld) Set(HeldCommentsStayHeld) else Set()),
    }
  }

  /// What an observer knows of a step that does not touch page comments or a model-call author's
  /// writes.
  pure def quietStep(turnEnd: TurnEnd): StepKind =
    {
      turnEnd: turnEnd,
      page: NoPageFact,
      write: WritesLand,
      agentHeard: Set(),
      instanceRestarted: false,
      recoverableFailure: NoRecoverableFailure,
      revisionLookup: RevisionKnown,
    }

  action moveWith(after: ReviewLoop, kind: StepKind): bool = {
    val step = { before: review, after: after, kind: kind }
    all {
      review' = after,
      lastStepKept' = rulesKeptBy(step),
      lastStepReached' = witnessesReachedBy(step),
      agentHeard' = kind.agentHeard,
      instanceRestartCount' = if (kind.instanceRestarted) instanceRestartCount + 1 else instanceRestartCount,
    }
  }

  action move(after: ReviewLoop, turnEnd: TurnEnd): bool = moveWith(after, quietStep(turnEnd))

  /// A step whose lookups of the revision go `lookup`.
  action moveOnLookup(after: ReviewLoop, turnEnd: TurnEnd, lookup: RevisionLookup): bool =
    moveWith(after, { ...quietStep(turnEnd), revisionLookup: lookup })

  /// A step on the page: what happened on the host and what the agent read.
  action moveOnThePage(after: ReviewLoop, page: PageFact, heard: Set[AgentNote]): bool =
    moveWith(after, { ...quietStep(NoTurnEnd), page: page, agentHeard: heard })

  action init: bool = {
    val step = { before: INITIAL_REVIEW, after: INITIAL_REVIEW, kind: quietStep(NoTurnEnd) }
    all {
      review' = INITIAL_REVIEW,
      lastStepKept' = rulesKeptBy(step),
      lastStepReached' = witnessesReachedBy(step),
      agentHeard' = Set(),
      instanceRestartCount' = 0,
    }
  }

  /// The agent sends the author a prompt of its own. On a page, it carries the held comments.
  action agentPromptsAuthor: bool = all {
    not(review.author.failed),
    roomForComments(review, 1),
    roomForAPrompt(review),
    nondet read = HELD_READS.oneOf()
    nondet meanwhile = WHILE_SCREENED.oneOf()
    val sent = sendHeldComments(review, read, meanwhile, true)
    val page =
      if (ON_A_PAGE) HeldCommentsAsked({ by: TheAgent, read: read, carried: sent.carried }) else NoPageFact
    moveOnThePage(sent.loop, page, sent.agentHeard),
  }

  /// The author's turn ends after it changed the artifact.
  action authorTurnEndsOnANewRevision: bool = all {
    review.author.atWork,
    nondet decision = REVIEW_AGAIN_DECISIONS.oneOf()
    nondet part = REVISION_PARTS.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val ended = authorTurnEnds(review, true, part, { write: WritesLand, decision: decision, lookup: revisionLookup })
    moveOnLookup(ended.loop, ended.turnEnd, revisionLookup),
  }

  /// The author's turn ends without a change.
  action authorTurnEndsOnTheSameRevision: bool = all {
    review.author.atWork,
    nondet decision = REVIEW_AGAIN_DECISIONS.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val ended = authorTurnEnds(review, false, Body, { write: WritesLand, decision: decision, lookup: revisionLookup })
    moveOnLookup(ended.loop, ended.turnEnd, revisionLookup),
  }

  /// The model call of a model-call author's turn answers with a changed page, and the host fails
  /// one of its writes.
  action theHostFailsAModelCallAuthorsWrite: bool = all {
    MODEL_CALL_AUTHOR,
    review.author.atWork,
    nondet part = REVISION_PARTS.oneOf()
    val failures =
      if (turnReplies(review, true, part).size() > 0) Set(RepliesFail, UpdateFails, UpdateLandsThenFails)
      else Set(UpdateFails, UpdateLandsThenFails)
    nondet failure = failures.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val answers = { write: WriteFails(failure), decision: AgentRoutes, lookup: revisionLookup }
    val ended = modelCallTurnEnds(review, true, part, answers)
    moveWith(ended.loop, { ...quietStep(ended.turnEnd), write: WriteFails(failure), revisionLookup: revisionLookup }),
  }

  /// A findings reviewer files a review with findings, and its turn ends.
  action findingsReviewerLeavesFindings: bool = all {
    unfinishedRunIs(review, FindingsReviewer),
    nondet commenting = COMMENTINGS.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val id = lastUnfinishedRun(review)
    val page = if (ON_A_PAGE) PageReviewPosted(commenting) else NoPageFact
    moveWith(
      findingsReviewerFinished(review, id, true, commenting, revisionLookup),
      { ...quietStep(RefinerTurnEnded(id)), page: page, revisionLookup: revisionLookup },
    ),
  }

  /// A findings reviewer files an approving review, and its turn ends.
  action findingsReviewerApproves: bool = all {
    unfinishedRunIs(review, FindingsReviewer),
    nondet commenting = COMMENTINGS.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val id = lastUnfinishedRun(review)
    val page = if (ON_A_PAGE) PageReviewPosted(commenting) else NoPageFact
    moveWith(
      findingsReviewerFinished(review, id, false, commenting, revisionLookup),
      { ...quietStep(RefinerTurnEnded(id)), page: page, revisionLookup: revisionLookup },
    ),
  }

  /// A judge closes with its conclusion. The decisions model starts to read it.
  action judgeTurnEnds: bool = all {
    unfinishedRunIs(review, Judge),
    val id = lastUnfinishedRun(review)
    move(judgeFinished(review, id), RefinerTurnEnded(id)),
  }

  /// A judge closes without a conclusion. Code does not call the decisions model, and the agent
  /// is asked to get a person's ruling in the same step.
  action judgeClosesWithoutAConclusion: bool = all {
    unfinishedRunIs(review, Judge),
    val id = lastUnfinishedRun(review)
    move(decisionsModelCannotRuleOn(judgeFinished(review, id), id), RefinerTurnEnded(id)),
  }

  pure def rejectionFact(loop: ReviewLoop, id: int, ruling: Ruling, post: HostWrite): PageFact =
    if (ON_A_PAGE and ruling == Rejected and rulingLands(loop, id)) RejectionPosted(post) else NoPageFact

  action decisionsModelRules(ruling: Ruling): bool = {
    nondet judgeRun = review.judgeRunsCodeRulesOn.oneOf()
    nondet post = HOST_WRITES.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    moveWith(
      decisionsModelRuled(review, judgeRun, ruling, post, revisionLookup),
      { ...quietStep(NoTurnEnd), page: rejectionFact(review, judgeRun, ruling, post), revisionLookup: revisionLookup },
    )
  }

  /// The decisions model reads approval in a conclusion.
  action decisionsModelApproves: bool = decisionsModelRules(Approved)

  /// The decisions model reads a rejection in a conclusion.
  action decisionsModelRejects: bool = decisionsModelRules(Rejected)

  /// The decisions model cannot tell. The agent is asked to get a person's ruling when the
  /// artifact still waits on the judge run.
  pure def decisionsModelCannotRuleOn(loop: ReviewLoop, id: int): ReviewLoop = {
    val answered = { ...loop, judgeRunsCodeRulesOn: loop.judgeRunsCodeRulesOn.exclude(Set(id)) }
    if (rulingLands(answered, id)) withRun(answered, id, { ...answered.refinerRuns[id], result: RulingAsked })
    else answered
  }

  /// The decisions model cannot tell, so the agent asks a person to rule.
  action decisionsModelCannotRule: bool = {
    nondet judgeRun = review.judgeRunsCodeRulesOn.oneOf()
    move(decisionsModelCannotRuleOn(review, judgeRun), NoTurnEnd)
  }

  action personRules(ruling: Ruling): bool = all {
    holdsARun(review),
    canPersonRuleOn(review, heldRun(review)),
    nondet post = HOST_WRITES.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val page = if (ON_A_PAGE and ruling == Rejected) RejectionPosted(post) else NoPageFact
    moveWith(
      applyJudgeRuling(review, heldRun(review), ruling, post, revisionLookup),
      { ...quietStep(NoTurnEnd), page: page, revisionLookup: revisionLookup },
    ),
  }

  /// A person approves the judge run the artifact is on, through the agent.
  action personApproves: bool = personRules(Approved)

  /// A person rejects the judge run the artifact is on, through the agent.
  action personRejects: bool = personRules(Rejected)

  /// A polisher changes the artifact, and its turn ends.
  action polisherPushes: bool = all {
    unfinishedRunIs(review, Polisher),
    nondet part = REVISION_PARTS.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val id = lastUnfinishedRun(review)
    moveOnLookup(polisherFinished(review, id, true, part, revisionLookup), RefinerTurnEnded(id), revisionLookup),
  }

  /// A polisher's turn ends without a change.
  action polisherPushesNothing: bool = all {
    unfinishedRunIs(review, Polisher),
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val id = lastUnfinishedRun(review)
    moveOnLookup(polisherFinished(review, id, false, Body, revisionLookup), RefinerTurnEnded(id), revisionLookup),
  }

  /// The agent runs the open segment again from its first entry that still has a say on the revision.
  action agentRequestsReview: bool = all {
    agentCanRoute(review),
    holdsARun(review),
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val start = segmentStartOf(review.refinerRuns[heldRun(review)].refinerIndex)
    all {
      canRequestReviewOn(review, heldRun(review), revisionLookup),
      moveOnLookup(
        startRefiner(review, smallest(unreviewedEntriesFrom(review, start, revisionLookup), REFINER_COUNT)),
        NoTurnEnd,
        revisionLookup,
      ),
    },
  }

  /// The agent ends the open segment and hands the artifact on.
  action agentFinishesReview: bool = all {
    agentCanRoute(review),
    holdsARun(review),
    refinerOf(review.refinerRuns[heldRun(review)]) != Judge,
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val index = review.refinerRuns[heldRun(review)].refinerIndex
    moveOnLookup(advancePastEntry(review, index, revisionLookup), NoTurnEnd, revisionLookup),
  }

  /// The agent cancels the unfinished refiner run.
  action agentCancelsRefinerRun: bool = all {
    unfinishedRunIds(review).size() > 0,
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val id = lastUnfinishedRun(review)
    val cancelled = withStatus(review, id, Cancelled)
    moveOnLookup(
      if (refinerOf(review.refinerRuns[id]) == Polisher) polisherStopped(cancelled, id, revisionLookup) else cancelled,
      NoTurnEnd,
      revisionLookup,
    ),
  }

  /// The sandbox of the unfinished refiner run dies.
  action refinerRunFails: bool = all {
    unfinishedRunIds(review).size() > 0,
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    moveOnLookup(refinerRunFailed(review, lastUnfinishedRun(review), revisionLookup), NoTurnEnd, revisionLookup),
  }

  /// The unfinished refiner run hits a failure it may recover from. It restarts while it has
  /// restarts left, and fails after that.
  action refinerRunHitsARecoverableFailure: bool = all {
    unfinishedRunIds(review).size() > 0,
    nondet cause = RESTART_CAUSES.oneOf()
    nondet revisionLookup = REVISION_LOOKUPS.oneOf()
    val id = lastUnfinishedRun(review)
    val refinerRun = review.refinerRuns[id]
    moveWith(
      if (refinerRun.restarts < MAX_RESTARTS) withRun(review, id, { ...refinerRun, restarts: refinerRun.restarts + 1 })
      else refinerRunFailed(review, id, revisionLookup),
      {
        ...quietStep(NoTurnEnd),
        recoverableFailure: RefinerRunHit({ refinerRun: id, cause: cause }),
        revisionLookup: revisionLookup,
      },
    ),
  }

  /// A person comments on the page without mentioning the bot. The comment is held.
  action personCommentsOnThePage: bool = all {
    ON_A_PAGE,
    roomForComments(review, 1),
    nondet place = commentPlaces(review).oneOf()
    move(withPersonComment(review, place), NoTurnEnd),
  }

  /// A person comments on the page and mentions the bot.
  action personMentionsTheBot: bool = all {
    ON_A_PAGE,
    roomForComments(review, 2),
    roomForAPrompt(review),
    nondet lookup = MENTION_LOOKUPS.oneOf()
    nondet read = HELD_READS.oneOf()
    nondet meanwhile = WHILE_SCREENED.oneOf()
    nondet route = FEEDBACK_ROUTES.oneOf()
    val handled = mentionArrives(review, lookup, read, meanwhile, route)
    moveOnThePage(handled.loop, handled.page, handled.agentHeard),
  }

  /// A person tells the agent they finished reviewing. The held comments go to a running author.
  action personAsksForRevision: bool = all {
    ON_A_PAGE,
    roomForComments(review, 1),
    roomForAPrompt(review),
    nondet read = HELD_READS.oneOf()
    nondet meanwhile = WHILE_SCREENED.oneOf()
    if (review.author.failed) move(review, NoTurnEnd)
    else {
      val sent = sendHeldComments(review, read, meanwhile, false)
      val page = HeldCommentsAsked({ by: APersonsRevisionRequest, read: read, carried: sent.carried })
      moveOnThePage(sent.loop, page, sent.agentHeard)
    },
  }

  /// A person rewrites a part of the page on the host. A model-call author's turn in flight read
  /// the page before.
  action personEditsThePage: bool = all {
    ON_A_PAGE,
    nondet part = PERSON_EDIT_PARTS.oneOf()
    val edited = pageChanged(review, part)
    val noted =
      if (MODEL_CALL_AUTHOR and review.author.atWork)
        { ...edited, author: { ...edited.author, pageEditsDuringTurn: edited.author.pageEditsDuringTurn.union(Set(part)) } }
      else edited
    moveOnThePage(noted, APersonEditedThePage, Set()),
  }

  /// The done judge runs the artifact waits on whose ruling neither code nor a person is asked
  /// for. The start step of a new instance asks the decisions model again for each one.
  pure def judgeRunsWithoutARulingAsked(loop: ReviewLoop): Set[int] =
    runIds(loop).filter(id => and {
      drafted(loop),
      isOnRun(loop, id),
      refinerOf(loop.refinerRuns[id]) == Judge,
      loop.refinerRuns[id].status == Done,
      loop.refinerRuns[id].result == NoResult,
    })

  /// A new Durable Object instance takes over the workflow with the store. The ruling calls in
  /// flight are lost, and the start step asks the decisions model again for each done judge run
  /// the artifact waits on. Queued prompts and harness refiner runs stay.
  action instanceRestarts: bool = all {
    INSTANCE_RESTARTS,
    moveWith(
      { ...review, judgeRunsCodeRulesOn: judgeRunsWithoutARulingAsked(review) },
      { ...quietStep(NoTurnEnd), instanceRestarted: true },
    ),
  }

  action step: bool = any {
    agentPromptsAuthor,
    authorTurnEndsOnANewRevision,
    authorTurnEndsOnTheSameRevision,
    theHostFailsAModelCallAuthorsWrite,
    findingsReviewerLeavesFindings,
    findingsReviewerApproves,
    judgeTurnEnds,
    judgeClosesWithoutAConclusion,
    decisionsModelApproves,
    decisionsModelRejects,
    decisionsModelCannotRule,
    personApproves,
    personRejects,
    polisherPushes,
    polisherPushesNothing,
    agentRequestsReview,
    agentFinishesReview,
    agentCancelsRefinerRun,
    refinerRunFails,
    refinerRunHitsARecoverableFailure,
    personCommentsOnThePage,
    personMentionsTheBot,
    personAsksForRevision,
    personEditsThePage,
    instanceRestarts,
  }

  /// True when an author turn ended on a revision other than `delivered`. An unknown revision
  /// counts as another one.
  pure def endedOnRevisionOtherThan(turnEnd: TurnEnd, delivered: FiledRevision): bool =
    match turnEnd {
      | AuthorTurnEnded(ended) => ended.revision == UnknownRevision or ended.revision != delivered
      | _ => false
    }

  pure def startedOnAChangedRevision(before: ReviewLoop, turnEnd: TurnEnd): bool =
    match before.artifact.status {
      | Drafted => true
      | Ready(handed) => endedOnRevisionOtherThan(turnEnd, handed.deliveredRevision)
    }

  /// True when a run of the same entry before `id` filed a review of the revision the host gave
  /// in the step.
  pure def reviewedByAnEarlierRun(loop: ReviewLoop, id: int, lookup: RevisionLookup): bool =
    lookup == RevisionKnown and runIds(loop).exists(earlier => and {
      earlier < id,
      loop.refinerRuns[earlier].refinerIndex == loop.refinerRuns[id].refinerIndex,
      isReview(loop.refinerRuns[earlier].result),
      filedOnRevision(loop.refinerRuns[earlier].result, hostRevision(loop, lookup)),
    })

  /// True when a run of the same entry before `id` filed a ruling.
  pure def ruledByAnEarlierRun(loop: ReviewLoop, id: int): bool =
    runIds(loop).exists(earlier => and {
      earlier < id,
      loop.refinerRuns[earlier].refinerIndex == loop.refinerRuns[id].refinerIndex,
      isRuling(loop.refinerRuns[earlier].result),
    })

  /// The latest run of each findings entry whose segment ends before `index`, when that run filed
  /// a review with findings.
  pure def findingsBefore(loop: ReviewLoop, index: int): Set[int] =
    runIds(loop).filter(id => and {
      refinerOf(loop.refinerRuns[id]) == FindingsReviewer,
      segmentEndOf(loop.refinerRuns[id].refinerIndex) < index,
      id == latestRunOf(loop, loop.refinerRuns[id].refinerIndex),
      reviewHasFindings(loop.refinerRuns[id].result),
    })

  /// The refiner runs that started in a step.
  pure def startedRuns(step: Transition): Set[int] =
    runIds(step.after).filter(id => id >= step.before.refinerRuns.length())

  /// True when the author got a prompt in a step with findings it did not have before.
  pure def gotNewFindings(step: Transition): bool =
    step.after.author.findingsFrom != step.before.author.findingsFrom

  /// The review comments posted in a step.
  pure def postedIn(step: Transition): List[ReviewComment] =
    step.after.reviewComments.slice(step.before.reviewComments.length(), step.after.reviewComments.length())

  pure def isOutcomeComment(comment: ReviewComment): bool =
    match comment { | OutcomeComment(_) => true | _ => false }

  pure def isRejectionComment(comment: ReviewComment): bool =
    match comment { | RejectionComment(_) => true | _ => false }

  pure def approves(comment: ReviewComment): bool =
    match comment { | OutcomeComment(outcome) => outcome.approves | _ => false }

  /// How often a finding with `passage` sits in the comments.
  pure def findingLanded(comments: List[ReviewComment], passage: Passage): int =
    comments.foldl(0, (count, comment) => match comment {
      | InlineFinding(inline) => if (inline.passage == passage) count + 1 else count
      | OutcomeComment(outcome) => if (outcome.findings.contains(passage)) count + 1 else count
      | RejectionComment(_) => count
    })

  pure def countOf(comments: List[ReviewComment], counted: ReviewComment => bool): int =
    comments.foldl(0, (count, comment) => if (counted(comment)) count + 1 else count)

  /// True when the comment `id` was held before a step, or a person left it in the step.
  pure def heldBeforeOrNew(step: Transition, id: int): bool =
    id >= step.before.personComments.length() or isHeld(step.before.personComments[id])

  /// True when a step ended or started over a model-call author's revise turn.
  pure def endsAModelCallTurn(step: Transition): bool =
    MODEL_CALL_AUTHOR and match step.kind.turnEnd {
      | AuthorTurnEnded(_) => true
      | AuthorTurnFailed(_) => true
      | AuthorTurnStartsOver => true
      | _ => false
    }

  /// A ruling a judge run filed stays as it is.
  pure def keepsEveryRuling(step: Transition): bool =
    step.before.refinerRuns.indices().forall(id =>
      isRuling(step.before.refinerRuns[id].result)
        implies step.after.refinerRuns[id].result == step.before.refinerRuns[id].result)

  /// A refiner run ends `Done` only in the step its turn ended, or it was already done.
  pure def endsDoneOnlyWithItsTurn(step: Transition): bool =
    runIds(step.after).forall(id =>
      step.after.refinerRuns[id].status == Done implies or {
        id < step.before.refinerRuns.length() and step.before.refinerRuns[id].status == Done,
        step.kind.turnEnd == RefinerTurnEnded(id),
      })

  /// A refiner run starts on an artifact the humans hold only after an author turn ended on a
  /// changed revision. An unknown revision counts as changed.
  pure def runsAgainOnlyOnAChangedRevision(step: Transition): bool =
    startedRuns(step).size() == 0 or startedOnAChangedRevision(step.before, step.kind.turnEnd)

  /// A findings reviewer starts a run only on a revision it has not filed a review on. An unknown
  /// revision counts as one it has not reviewed. A judge entry that ruled does not start a run
  /// again.
  pure def reviewsOnlyAnUnreviewedRevision(step: Transition): bool =
    startedRuns(step).forall(id =>
      match refinerOf(step.after.refinerRuns[id]) {
        | FindingsReviewer => not(reviewedByAnEarlierRun(step.after, id, step.kind.revisionLookup))
        | Judge => not(ruledByAnEarlierRun(step.after, id))
        | Polisher => true
      })

  /// A refiner run that starts past a pull request review with findings finds them sent.
  pure def sendsEveryPullFinding(step: Transition): bool =
    ARTIFACT == Page or startedRuns(step).forall(started =>
      findingsBefore(step.after, step.after.refinerRuns[started].refinerIndex)
        .forall(id => step.after.author.findingsFrom.contains(id)))

  /// A review prompt in the step a page reviewer ended carries that reviewer's findings.
  pure def sendsEveryPageFinding(step: Transition): bool =
    ARTIFACT == PullRequest or match step.kind.turnEnd {
      | RefinerTurnEnded(id) =>
        (gotNewFindings(step) and reviewHasFindings(step.after.refinerRuns[id].result))
          implies step.after.author.findingsFrom.contains(id)
      | _ => true
    }

  /// A page review that reached the host posts each finding once and one outcome comment.
  pure def postsEachFindingOnce(step: Transition): bool =
    match step.kind.page {
      | PageReviewPosted(commenting) => match step.kind.turnEnd {
        | RefinerTurnEnded(id) => {
          val result = step.after.refinerRuns[id].result
          val posted = postedIn(step)
          val hostUp = commenting != HostDown
          val findings = if (reviewHasFindings(result)) REVIEW_PASSAGES else Set()
          if (not(isReview(result))) posted.length() == 0
          else and {
            not(hostUp) or countOf(posted, isOutcomeComment) == 1,
            posted.foldl(true, (opensWithTheLine, comment) =>
              opensWithTheLine and (isOutcomeComment(comment) implies approves(comment) == not(reviewHasFindings(result)))),
            findings.forall(passage => and {
              findingLanded(posted, passage) <= 1,
              hostUp implies findingLanded(posted, passage) == 1,
            }),
            REVIEW_PASSAGES.exclude(findings).forall(passage => findingLanded(posted, passage) == 0),
          }
        }
        | _ => true
      }
      | _ => true
    }

  /// A prompt the agent sends or a revision request carries every held comment the host marked
  /// read. A held comment it does not mark stays held, and the agent is told so.
  pure def carriesTheHeldComments(step: Transition): bool =
    match step.kind.page {
      | HeldCommentsAsked(asked) => {
        val heldBefore = heldCommentIds(step.before)
        or {
          asked.by == AMention,
          step.after.author.failed,
          heldBefore.size() == 0,
          if (asked.read == AdmittedAndAcknowledged)
            heldBefore.forall(id => asked.carried.contains(id) and not(isHeld(step.after.personComments[id])))
          else and {
            heldBefore.forall(id => not(asked.carried.contains(id)) and isHeld(step.after.personComments[id])),
            not(step.kind.agentHeard.contains(HeldCommentText)),
            step.kind.agentHeard.contains(HeldCommentsStayHeld),
          },
        }
      }
      | _ => true
    }

  /// Unadmitted held comments of a revision request or a mention reach neither the agent nor the
  /// author.
  pure def unadmittedReachesNobody(step: Transition): bool =
    match step.kind.page {
      | HeldCommentsAsked(asked) =>
        (asked.by != TheAgent and not(admits(asked.read))) implies and {
          step.after.author.queuedPrompts == step.before.author.queuedPrompts,
          step.after.author.atWork == step.before.author.atWork,
          not(step.kind.agentHeard.contains(HeldCommentText)),
        }
      | _ => true
    }

  /// A model-call author's write removes the block of a sent comment only after its reply.
  pure def answersBeforeTheLineGoes(step: Transition): bool =
    not(endsAModelCallTurn(step)) or personCommentIds(step.after).forall(id => and {
      id < step.before.personComments.length(),
      step.before.personComments[id].sent,
      not(step.before.personComments[id].gone),
      step.after.personComments[id].gone,
    } implies step.after.personComments[id].answered)

  /// A revise turn that did not reply to every comment its prompt carries that is still on the
  /// page leaves the page as it was.
  pure def failedReplyLeavesItAsItWas(step: Transition): bool =
    not(endsAModelCallTurn(step)) or
      step.before.author.turnComments.forall(id =>
        step.before.personComments[id].gone or step.after.personComments[id].answered) or
      step.after.artifact.revision == step.before.artifact.revision

  /// The refiner runs whose rejection landed in a step.
  pure def rejectedIn(step: Transition): Set[int] =
    step.before.refinerRuns.indices().filter(id => and {
      not(isRuling(step.before.refinerRuns[id].result)),
      isRejection(step.after.refinerRuns[id].result),
    })

  /// A judge rejection on a page posts its reason once when the host takes it, and reaches the
  /// author either way: a prompt for the author carries the rejection of that judge entry.
  pure def postsTheRejectionOnce(step: Transition): bool =
    match step.kind.page {
      | RejectionPosted(post) => and {
        countOf(postedIn(step), isRejectionComment) == (if (post == HostTakes) 1 else 0),
        rejectedIn(step).size() > 0,
        rejectedIn(step).forall(id => {
          val index = step.after.refinerRuns[id].refinerIndex
          not(step.before.author.rejectedBy.contains(index)) and step.after.author.rejectedBy.contains(index)
        }),
      }
      | _ => true
    }

  /// A model-call author's turn fails only in a step where the host did not take a write.
  pure def failsOnlyOnAHostError(step: Transition): bool =
    match step.kind.turnEnd {
      | AuthorTurnFailed(_) => step.kind.write != WritesLand
      | _ => true
    }

  /// True when the refiner run `id` hit a failure it may recover from in the step.
  pure def hitARecoverableFailure(step: Transition, id: int): bool =
    match step.kind.recoverableFailure {
      | RefinerRunHit(hit) => hit.refinerRun == id
      | NoRecoverableFailure => false
    }

  /// A refiner run restarts only in a step where it hit a failure it may recover from, once per
  /// such step while it has restarts left. Such a failure after that fails it.
  pure def restartsOnlyWhileItHasRestarts(step: Transition): bool =
    step.before.refinerRuns.indices().forall(id => {
      val before = step.before.refinerRuns[id]
      val after = step.after.refinerRuns[id]
      if (not(hitARecoverableFailure(step, id))) after.restarts == before.restarts
      else if (before.restarts < MAX_RESTARTS) after.restarts == before.restarts + 1 and after.status == Unfinished
      else after.restarts == before.restarts and after.status == Failed
    })

  /// A refiner run that is done, cancelled or failed before a step keeps that status after it.
  pure def keepsEveryFinishedStatus(step: Transition): bool =
    step.before.refinerRuns.indices().forall(id =>
      step.before.refinerRuns[id].status != Unfinished
        implies step.after.refinerRuns[id].status == step.before.refinerRuns[id].status)

  /// Whether one step kept each before-and-after rule.
  pure def rulesKeptBy(step: Transition): KeptRules = {
    judgeRulesAtMostOnce: keepsEveryRuling(step),
    refinerRunIsDoneOnlyAfterItsTurnEnded: endsDoneOnlyWithItsTurn(step),
    refinersRunAgainOnlyOnChangedRevision: runsAgainOnlyOnAChangedRevision(step),
    reviewerRunsOnlyOnAnUnreviewedRevision: reviewsOnlyAnUnreviewedRevision(step),
    authorGetsEveryPullFinding: sendsEveryPullFinding(step),
    authorGetsEveryPageFinding: sendsEveryPageFinding(step),
    pageReviewPostsEachFindingOnce: postsEachFindingOnce(step),
    aPromptToAPageAuthorCarriesItsHeldComments: carriesTheHeldComments(step),
    unadmittedFeedbackReachesNobody: unadmittedReachesNobody(step),
    sentCommentIsAnsweredBeforeItsLineGoes: answersBeforeTheLineGoes(step),
    failedReplyLeavesThePage: failedReplyLeavesItAsItWas(step),
    aJudgeRejectionPostsItsReasonOnce: postsTheRejectionOnce(step),
    aModelCallAuthorFailsOnlyOnAHostError: failsOnlyOnAHostError(step),
    aRefinerRunRestartsAtMostTwice: restartsOnlyWhileItHasRestarts(step),
    aFinishedRefinerRunKeepsItsStatus: keepsEveryFinishedStatus(step),
  }

  /// The held comments read in a step whose host marks them read, when some were held.
  pure def heldCommentsAskedFor(step: Transition, matches: { by: Asker, read: HeldRead, carried: Set[int] } => bool): bool =
    match step.kind.page {
      | HeldCommentsAsked(asked) => heldCommentIds(step.before).size() > 0 and matches(asked)
      | _ => false
    }

  /// Whether one step reached each before-and-after witness.
  pure def witnessesReachedBy(step: Transition): ReachedWitnesses = {
    aRulingLandsOnARuledJudgeRun:
      step.before.judgeRunsCodeRulesOn.exists(id =>
        not(step.after.judgeRunsCodeRulesOn.contains(id)) and isRuling(step.before.refinerRuns[id].result)),
    aReviewerRunsAgainOnANewRevision:
      startedRuns(step).exists(id => and {
        refinerOf(step.after.refinerRuns[id]) != Polisher,
        runIds(step.after).exists(earlier =>
          earlier < id and step.after.refinerRuns[earlier].refinerIndex == step.after.refinerRuns[id].refinerIndex),
      }),
    aRefinerRunEndsDone: match step.kind.turnEnd {
      | RefinerTurnEnded(id) => step.after.refinerRuns[id].status == Done
      | _ => false
    },
    aRefinerRunStartsAfterAHandover:
      step.before.artifact.status != Drafted and startedRuns(step).size() > 0,
    aRefinerRunStartsPastFindings:
      startedRuns(step).exists(started =>
        findingsBefore(step.after, step.after.refinerRuns[started].refinerIndex).size() > 0),
    aRefinerRunStartsPastAJudgeWithFindings:
      startedRuns(step).exists(started =>
        findingsBefore(step.after, step.after.refinerRuns[started].refinerIndex)
          .exists(id => ENTRIES[segmentEndOf(step.after.refinerRuns[id].refinerIndex)] == Judge)),
    aPageAuthorGetsTheFindingsOfItsReviewer:
      ARTIFACT == Page and gotNewFindings(step) and match step.kind.turnEnd {
        | RefinerTurnEnded(id) => step.after.author.findingsFrom.contains(id)
        | _ => false
      },
    aStaleReviewRunsTheSegmentAgain: match step.kind.turnEnd {
      | RefinerTurnEnded(id) => startedRuns(step).exists(started =>
          step.after.refinerRuns[started].refinerIndex <= step.after.refinerRuns[id].refinerIndex)
      | _ => false
    },
    aPageReviewPostsAnInlineFinding:
      step.kind.page == PageReviewPosted(TakesAll) and findingLanded(postedIn(step), QuotesThePage) == 1,
    aPageReviewMovesInlineFindingsIntoItsOutcome: and {
      step.kind.page == PageReviewPosted(InlineThrows) or step.kind.page == PageReviewPosted(DropsInline),
      postedIn(step).foldl(false, (found, comment) => found or match comment {
        | OutcomeComment(outcome) => outcome.findings.contains(QuotesThePage)
        | _ => false
      }),
    },
    aPageReviewMeetsAHostThatIsDown: step.kind.page == PageReviewPosted(HostDown),
    heldCommentsGoToThePageAuthor:
      heldCommentsAskedFor(step, asked => asked.by != AMention and asked.carried.size() > 0),
    heldCommentsStayHeld:
      heldCommentsAskedFor(step, asked => asked.by != AMention and not(admits(asked.read))),
    theHostKeepsHeldCommentsHeld:
      heldCommentsAskedFor(step, asked => asked.read == AdmittedButAcknowledgementFails),
    theScreenKeepsHeldComments:
      heldCommentsAskedFor(step, asked => asked.by != TheAgent and asked.read == ScreenRefuses),
    aMentionRoutedAwayLeavesHeldComments:
      heldCommentsAskedFor(step, asked => and {
        asked.by == AMention,
        asked.read == AdmittedAndAcknowledged,
        asked.carried.size() == 0,
      }),
    aPersonRepliesWhileTheScreenReads:
      heldCommentsAskedFor(step, asked => asked.carried.size() > 0) and
        personCommentIds(step.after).exists(id => and {
          id >= step.before.personComments.length(),
          not(step.after.personComments[id].mentions),
          isHeld(step.after.personComments[id]),
        }),
    aHeldCommentReachesTheAuthor:
      personCommentIds(step.after).exists(id => and {
        heldBeforeOrNew(step, id),
        not(isHeld(step.after.personComments[id])),
        step.after.personComments[id].sent,
      }),
    aRevisionRewritesTheBlockOfAnAnsweredComment:
      endsAModelCallTurn(step) and personCommentIds(step.after).exists(id => and {
        id < step.before.personComments.length(),
        not(step.before.personComments[id].gone),
        step.after.personComments[id].gone,
        step.after.personComments[id].answered,
      }),
    aRevisionAnswersAQueuedComment:
      endsAModelCallTurn(step) and personCommentIds(step.after).exists(id => and {
        id < step.before.personComments.length(),
        not(step.before.author.turnComments.contains(id)),
        not(step.before.personComments[id].answered),
        step.after.personComments[id].answered,
      }),
    aCommentReplyFails: step.kind.turnEnd == AuthorTurnFailed(ReplyRefused),
    aRejectionLandsOnThePage: step.kind.page == RejectionPosted(HostTakes),
    theHostFailsARejection: step.kind.page == RejectionPosted(HostFails),
    theHostFailsAModelCallAuthor:
      step.kind.turnEnd == AuthorTurnFailed(UpdateRefused) or step.kind.turnEnd == AuthorTurnFailed(UpdateLandedThenFailed),
    aPersonEditsDuringAModelCallTurn:
      step.kind.page == APersonEditedThePage and step.after.author.pageEditsDuringTurn.size() > 0,
    aModelCallTurnStartsOver: step.kind.turnEnd == AuthorTurnStartsOver,
    aRulingCallIsLostWithTheInstance:
      step.kind.instanceRestarted and step.before.judgeRunsCodeRulesOn.exists(id => isOnRun(step.before, id)),
    aJudgeClosesWithoutAConclusion:
      match step.kind.turnEnd {
        | RefinerTurnEnded(id) => step.after.refinerRuns[id].result == RulingAsked
        | _ => false
      },
    aRefinerRunFailsPastItsRestarts:
      step.before.refinerRuns.indices().exists(id => and {
        hitARecoverableFailure(step, id),
        step.before.refinerRuns[id].restarts == MAX_RESTARTS,
      }),
    aRefinerRunStartsAfterAFailedOrCancelledOne:
      startedRuns(step).size() > 0 and step.before.refinerRuns.indices().exists(id =>
        step.before.refinerRuns[id].status == Failed or step.before.refinerRuns[id].status == Cancelled),
    aReviewerRunsAgainOnAnUnknownRevision:
      step.kind.revisionLookup == RevisionUnknown and startedRuns(step).exists(id => and {
        refinerOf(step.after.refinerRuns[id]) == FindingsReviewer,
        reviewedByAnEarlierRun(step.after, id, RevisionKnown),
      }),
    aRefinerRunStartsAfterAnUnknownRevision:
      startedRuns(step).size() > 0 and step.kind.turnEnd == AuthorTurnEnded({ revision: UnknownRevision }) and
        step.before.artifact.status == Ready({ deliveredRevision: ReadRevision(step.before.artifact.revision) }),
    aRefinerRunStartsAfterAnUnknownHandover:
      startedRuns(step).size() > 0 and step.kind.turnEnd != AuthorTurnEnded({ revision: UnknownRevision }) and
        step.before.artifact.status == Ready({ deliveredRevision: UnknownRevision }),
  }

  /// An artifact has at most one unfinished refiner run, and the artifact is on it.
  val oneUnfinishedRefinerRunPerArtifact: bool = and {
    unfinishedRunIds(review).size() <= 1,
    unfinishedRunIds(review).forall(id => isOnRun(review, id)),
  }

  /// The author does not have a turn running or starting while a polisher run is unfinished.
  val authorIsIdleWhileAPolisherRuns: bool =
    unfinishedRunIds(review).forall(id =>
      refinerOf(review.refinerRuns[id]) == Polisher implies not(review.author.atWork))

  /// A judge entry rules at most once on an artifact, and its ruling never changes. An author that
  /// got a rejection from a judge entry finds that entry's ruling stored as rejected.
  val judgeRulesAtMostOnce: bool = and {
    runIds(review).forall(id => runIds(review).forall(other =>
      (id != other and isRuling(review.refinerRuns[id].result) and isRuling(review.refinerRuns[other].result))
        implies review.refinerRuns[id].refinerIndex != review.refinerRuns[other].refinerIndex)),
    lastStepKept.judgeRulesAtMostOnce,
    review.author.rejectedBy.forall(index => runIds(review).exists(id =>
      review.refinerRuns[id].refinerIndex == index and isRejection(review.refinerRuns[id].result))),
  }

  /// A refiner run ends `Done` only in the step its turn ended, or it was already done.
  val refinerRunIsDoneOnlyAfterItsTurnEnded: bool = lastStepKept.refinerRunIsDoneOnlyAfterItsTurnEnded

  /// A refiner run starts on an artifact the humans hold only after an author turn ended on a
  /// changed revision. An unknown revision counts as changed.
  val refinersRunAgainOnlyOnChangedRevision: bool = lastStepKept.refinersRunAgainOnlyOnChangedRevision

  /// A findings reviewer starts a run only on a revision it has not filed a review on. An unknown
  /// revision counts as one it has not reviewed. A judge entry that ruled does not start a run
  /// again.
  val reviewerRunsOnlyOnAnUnreviewedRevision: bool = lastStepKept.reviewerRunsOnlyOnAnUnreviewedRevision

  /// Every review a findings reviewer files on a pull request reaches its author as a prompt. A
  /// judge's approval does not drop it.
  val authorGetsEveryPullFinding: bool = lastStepKept.authorGetsEveryPullFinding

  /// A review prompt the author of a page gets in the step its reviewer ended carries every
  /// finding of that review.
  val authorGetsEveryPageFinding: bool = lastStepKept.authorGetsEveryPageFinding

  /// A prompt queued for a model-call author reaches it. A model-call author with a queued
  /// prompt has a model turn in flight, or a polisher holds its page.
  val aQueuedPromptReachesItsModelCallAuthor: bool = or {
    not(MODEL_CALL_AUTHOR),
    review.author.queuedPrompts.length() == 0,
    review.author.atWork,
    unfinishedRunIds(review).exists(id => refinerOf(review.refinerRuns[id]) == Polisher),
  }

  /// When a page review reaches the document host, each finding lands once, on its passage or in
  /// the outcome comment, and the outcome comment opens with the review line. A turn that did not
  /// file a review does not post a comment.
  val pageReviewPostsEachFindingOnce: bool = lastStepKept.pageReviewPostsEachFindingOnce

  /// A prompt the agent sends to the author of a page, and a person's request for a revision,
  /// carry every comment held on the page and mark it read. When the host cannot be read, the
  /// screen does not admit them, or the host does not mark them read, no prompt carries them,
  /// they stay held, and the agent is told so. An author that finished during the step is not
  /// owed them.
  val aPromptToAPageAuthorCarriesItsHeldComments: bool = lastStepKept.aPromptToAPageAuthorCarriesItsHeldComments

  /// Held comments a person's revision request or mention sends, when the host cannot be read or
  /// the screen does not admit them, reach neither the agent nor the author. No prompt goes out
  /// and the agent does not read their text.
  val unadmittedFeedbackReachesNobody: bool = lastStepKept.unadmittedFeedbackReachesNobody

  /// A revision removes the block of a person comment the author was sent only after the author's
  /// comment reply is in that comment's comment thread.
  val sentCommentIsAnsweredBeforeItsLineGoes: bool = lastStepKept.sentCommentIsAnsweredBeforeItsLineGoes

  /// The author replies only to a comment it was sent.
  val replyGoesOnlyToASentComment: bool =
    personCommentIds(review).forall(id =>
      review.personComments[id].answered implies review.personComments[id].sent)

  /// A revision that posted fewer comment replies than its prompt carries comments still on the
  /// page leaves the page as it was.
  val failedReplyLeavesThePage: bool = lastStepKept.failedReplyLeavesThePage

  /// A judge rejection on a page posts its reason in one comment when the host takes it, and the
  /// author gets the rejection whether the post landed or not.
  val aJudgeRejectionPostsItsReasonOnce: bool = lastStepKept.aJudgeRejectionPostsItsReasonOnce

  /// A person comment that does not mention the bot is marked read on the page only once a prompt
  /// that carries it is queued for the author. Until then it stays held.
  val aHeldCommentStaysHeldUntilItReachesTheAuthor: bool =
    personCommentIds(review).forall(id =>
      (review.personComments[id].acknowledged and not(review.personComments[id].mentions))
        implies review.personComments[id].sent)

  /// A model-call author's revise turn fails only when the document host refuses or loses one of
  /// its writes. An edit to the page by a person, a polisher, or an earlier revision does not
  /// fail it.
  val aModelCallAuthorFailsOnlyOnAHostError: bool = lastStepKept.aModelCallAuthorFailsOnlyOnAHostError

  /// A done judge run that the artifact points at without a ruling has a ruling call out, or the
  /// agent has been asked to get a person's ruling.
  val aRestartDoesNotStrandAJudgeRun: bool =
    runIds(review).forall(id => and {
      isOnRun(review, id),
      refinerOf(review.refinerRuns[id]) == Judge,
      review.refinerRuns[id].status == Done,
      not(isRuling(review.refinerRuns[id].result)),
    } implies or {
      review.judgeRunsCodeRulesOn.contains(id),
      review.refinerRuns[id].result == RulingAsked,
    })

  /// A refiner run restarts at most `MAX_RESTARTS` times. A failure after that fails it.
  val aRefinerRunRestartsAtMostTwice: bool = and {
    runIds(review).forall(id => review.refinerRuns[id].restarts <= MAX_RESTARTS),
    lastStepKept.aRefinerRunRestartsAtMostTwice,
  }

  /// A refiner run that is done, cancelled or failed keeps that status.
  val aFinishedRefinerRunKeepsItsStatus: bool = lastStepKept.aFinishedRefinerRunKeepsItsStatus

  /// Every invariant above, for one check of all of them.
  val invariants: bool = and {
    oneUnfinishedRefinerRunPerArtifact,
    authorIsIdleWhileAPolisherRuns,
    judgeRulesAtMostOnce,
    refinerRunIsDoneOnlyAfterItsTurnEnded,
    refinersRunAgainOnlyOnChangedRevision,
    reviewerRunsOnlyOnAnUnreviewedRevision,
    authorGetsEveryPullFinding,
    authorGetsEveryPageFinding,
    aQueuedPromptReachesItsModelCallAuthor,
    pageReviewPostsEachFindingOnce,
    aPromptToAPageAuthorCarriesItsHeldComments,
    unadmittedFeedbackReachesNobody,
    sentCommentIsAnsweredBeforeItsLineGoes,
    replyGoesOnlyToASentComment,
    failedReplyLeavesThePage,
    aJudgeRejectionPostsItsReasonOnce,
    aHeldCommentStaysHeldUntilItReachesTheAuthor,
    aModelCallAuthorFailsOnlyOnAHostError,
    aRestartDoesNotStrandAJudgeRun,
    aRefinerRunRestartsAtMostTwice,
    aFinishedRefinerRunKeepsItsStatus,
  }

  /// The revisions of the artifact, a counter that model checking bounds.
  val revisions: int = review.artifact.revision

  /// The refiner runs that started, a counter that model checking bounds.
  val refinerRunsStarted: int = review.refinerRuns.length()

  /// The comments code posted on the page, a counter that model checking bounds.
  val reviewCommentsPosted: int = review.reviewComments.length()

  /// The comments people left on the page, a counter that model checking bounds.
  val personCommentsLeft: int = review.personComments.length()

  /// The prompts waiting for the author, a counter that model checking bounds.
  val promptsQueued: int = review.author.queuedPrompts.length()

  /// Witness for `oneUnfinishedRefinerRunPerArtifact`: a refiner run is unfinished.
  val aRefinerRunIsUnfinished: bool = unfinishedRunIds(review).size() > 0

  /// Witness for `authorIsIdleWhileAPolisherRuns`: a prompt waits for the author while a polisher runs.
  val aPromptWaitsWhileAPolisherRuns: bool =
    polisherRunning(review) and review.author.queuedPrompts.length() > 0

  /// Witness for `judgeRulesAtMostOnce`: a ruling lands on a judge run that already has one.
  val aRulingLandsOnARuledJudgeRun: bool = lastStepReached.aRulingLandsOnARuledJudgeRun

  /// Witness for `judgeRulesAtMostOnce`: the author got a rejection from a judge entry.
  val theAuthorGotARejection: bool = review.author.rejectedBy.size() > 0

  /// Witness for `reviewerRunsOnlyOnAnUnreviewedRevision`: a reviewer entry runs again on a new revision.
  val aReviewerRunsAgainOnANewRevision: bool = lastStepReached.aReviewerRunsAgainOnANewRevision

  /// Witness for `refinerRunIsDoneOnlyAfterItsTurnEnded`: a refiner run ends done.
  val aRefinerRunEndsDone: bool = lastStepReached.aRefinerRunEndsDone

  /// Witness for `refinersRunAgainOnlyOnChangedRevision`: a refiner run starts on an artifact the humans had.
  val aRefinerRunStartsAfterAHandover: bool = lastStepReached.aRefinerRunStartsAfterAHandover

  /// Witness for `authorGetsEveryPullFinding`: a refiner run starts past a review with findings.
  val aRefinerRunStartsPastFindings: bool = lastStepReached.aRefinerRunStartsPastFindings

  /// Witness for `authorGetsEveryPullFinding`: a refiner run starts past a judge whose segment
  /// left findings.
  val aRefinerRunStartsPastAJudgeWithFindings: bool = lastStepReached.aRefinerRunStartsPastAJudgeWithFindings

  /// Witness for `authorGetsEveryPageFinding`: the author of a page gets the findings of the
  /// reviewer that just ended.
  val aPageAuthorGetsTheFindingsOfItsReviewer: bool = lastStepReached.aPageAuthorGetsTheFindingsOfItsReviewer

  /// Witness for `aQueuedPromptReachesItsModelCallAuthor`: a model-call author has a queued prompt.
  val aModelCallAuthorHasAQueuedPrompt: bool =
    MODEL_CALL_AUTHOR and review.author.queuedPrompts.length() > 0

  /// The humans have the artifact.
  val theHumansHaveTheArtifact: bool = not(drafted(review))

  /// A stale review runs its segment again.
  val aStaleReviewRunsTheSegmentAgain: bool = lastStepReached.aStaleReviewRunsTheSegmentAgain

  /// A reviewer reached the review limit.
  val aReviewerReachedTheLimit: bool = runIds(review).exists(id => reviewLimitReached(review, id))

  /// Witness for `aRefinerRunRestartsAtMostTwice`: a refiner run restarted.
  val aRefinerRunRestarted: bool = runIds(review).exists(id => review.refinerRuns[id].restarts > 0)

  /// A polisher pushed and handed the artifact on.
  val aPolisherFinished: bool = runIds(review).exists(id =>
    refinerOf(review.refinerRuns[id]) == Polisher and review.refinerRuns[id].status == Done)

  /// Witness for `pageReviewPostsEachFindingOnce`: a page review posts an inline finding and its
  /// outcome comment.
  val aPageReviewPostsAnInlineFinding: bool = lastStepReached.aPageReviewPostsAnInlineFinding

  /// Witness for `pageReviewPostsEachFindingOnce`: the host fails the inline findings of a page
  /// review with findings, and they move into the outcome comment.
  val aPageReviewMovesInlineFindingsIntoItsOutcome: bool = lastStepReached.aPageReviewMovesInlineFindingsIntoItsOutcome

  /// Witness for `pageReviewPostsEachFindingOnce`: a page review meets a host that is down.
  val aPageReviewMeetsAHostThatIsDown: bool = lastStepReached.aPageReviewMeetsAHostThatIsDown

  /// Witness for `aPromptToAPageAuthorCarriesItsHeldComments`: held comments go to the author.
  val heldCommentsGoToThePageAuthor: bool = lastStepReached.heldCommentsGoToThePageAuthor

  /// Witness for `aPromptToAPageAuthorCarriesItsHeldComments`: held comments stay held.
  val heldCommentsStayHeld: bool = lastStepReached.heldCommentsStayHeld

  /// Witness for `aPromptToAPageAuthorCarriesItsHeldComments`: the host does not mark the held
  /// comments read, so they stay held.
  val theHostKeepsHeldCommentsHeld: bool = lastStepReached.theHostKeepsHeldCommentsHeld

  /// Witness for `unadmittedFeedbackReachesNobody`: the screen keeps the held comments of a
  /// mention or a revision request.
  val theScreenKeepsHeldComments: bool = lastStepReached.theScreenKeepsHeldComments

  /// Witness for `aHeldCommentStaysHeldUntilItReachesTheAuthor`: a mention the decisions model
  /// does not route to the author leaves the other held comments held.
  val aMentionRoutedAwayLeavesHeldComments: bool = lastStepReached.aMentionRoutedAwayLeavesHeldComments

  /// Witness for `aHeldCommentStaysHeldUntilItReachesTheAuthor`: a person replies in a comment
  /// thread while the screen reads it, and the reply stays held.
  val aPersonRepliesWhileTheScreenReads: bool = lastStepReached.aPersonRepliesWhileTheScreenReads

  /// Witness for `aHeldCommentStaysHeldUntilItReachesTheAuthor`: a held comment reaches the author.
  val aHeldCommentReachesTheAuthor: bool = lastStepReached.aHeldCommentReachesTheAuthor

  /// Witness for `replyGoesOnlyToASentComment`: the author posts a comment reply.
  val theAuthorRepliesToAComment: bool =
    personCommentIds(review).exists(id => review.personComments[id].answered)

  /// Witness for `sentCommentIsAnsweredBeforeItsLineGoes`: a revision rewrites the block of an
  /// answered comment.
  val aRevisionRewritesTheBlockOfAnAnsweredComment: bool = lastStepReached.aRevisionRewritesTheBlockOfAnAnsweredComment

  /// Witness for `sentCommentIsAnsweredBeforeItsLineGoes`: a revision answers a comment a queued
  /// prompt carries before it rewrites that comment's block.
  val aRevisionAnswersAQueuedComment: bool = lastStepReached.aRevisionAnswersAQueuedComment

  /// Witness for `failedReplyLeavesThePage`: a comment reply fails.
  val aCommentReplyFails: bool = lastStepReached.aCommentReplyFails

  /// Witness for `aJudgeRejectionPostsItsReasonOnce`: a rejection lands on the page.
  val aRejectionLandsOnThePage: bool = lastStepReached.aRejectionLandsOnThePage

  /// Witness for `aJudgeRejectionPostsItsReasonOnce`: the host fails the post of a rejection.
  val theHostFailsARejection: bool = lastStepReached.theHostFailsARejection

  /// Witness for `aModelCallAuthorFailsOnlyOnAHostError`: the host fails a model-call author's write.
  val theHostFailsAModelCallAuthor: bool = lastStepReached.theHostFailsAModelCallAuthor

  /// Witness for `aModelCallAuthorFailsOnlyOnAHostError`: a person edits the page while a
  /// model-call author's turn runs.
  val aPersonEditsDuringAModelCallTurn: bool = lastStepReached.aPersonEditsDuringAModelCallTurn

  /// Witness for `aModelCallAuthorFailsOnlyOnAHostError`: a model-call author's turn starts over
  /// on a page a person edited.
  val aModelCallTurnStartsOver: bool = lastStepReached.aModelCallTurnStartsOver

  /// Witness for `aRestartDoesNotStrandAJudgeRun`: a new instance takes over while the ruling call
  /// of the judge run the artifact is on is out.
  val aRulingCallIsLostWithTheInstance: bool = lastStepReached.aRulingCallIsLostWithTheInstance

  /// Witness for `aRestartDoesNotStrandAJudgeRun`: a judge closes without a conclusion, and the
  /// agent is asked for a person's ruling at its turn end.
  val aJudgeClosesWithoutAConclusion: bool = lastStepReached.aJudgeClosesWithoutAConclusion

  /// Witness for `aRestartDoesNotStrandAJudgeRun`: the agent was asked to get a person's ruling.
  val theAgentIsAskedForAPersonsRuling: bool =
    runIds(review).exists(id => review.refinerRuns[id].result == RulingAsked)

  /// Witness for `aRefinerRunRestartsAtMostTwice`: a refiner run whose restarts are used up hits a
  /// failure it may recover from, and fails.
  val aRefinerRunFailsPastItsRestarts: bool = lastStepReached.aRefinerRunFailsPastItsRestarts

  /// Witness for `aFinishedRefinerRunKeepsItsStatus`: a refiner run starts after a failed or
  /// cancelled one.
  val aRefinerRunStartsAfterAFailedOrCancelledOne: bool = lastStepReached.aRefinerRunStartsAfterAFailedOrCancelledOne

  /// Witness for `reviewerRunsOnlyOnAnUnreviewedRevision`: a findings reviewer runs again on a
  /// revision it reviewed while the host cannot give the revision.
  val aReviewerRunsAgainOnAnUnknownRevision: bool = lastStepReached.aReviewerRunsAgainOnAnUnknownRevision

  /// Witness for `refinersRunAgainOnlyOnChangedRevision`: a refiner run starts on an artifact the
  /// humans had after an author turn ended on an unknown revision.
  val aRefinerRunStartsAfterAnUnknownRevision: bool = lastStepReached.aRefinerRunStartsAfterAnUnknownRevision

  /// Witness for `refinersRunAgainOnlyOnChangedRevision`: a refiner run starts on an artifact the
  /// humans got with an unknown revision.
  val aRefinerRunStartsAfterAnUnknownHandover: bool = lastStepReached.aRefinerRunStartsAfterAnUnknownHandover

  /// A new instance took over the workflow.
  val theInstanceRestarted: bool = instanceRestartCount > 0
}
