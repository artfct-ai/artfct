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

  /// What a refiner run filed: a review of one revision, or a ruling on one.
  type RefinerResult =
    | NoResult
    | FiledReview({ revision: int, findings: bool })
    | FiledRuling({ ruling: Ruling, revision: int })

  /// One execution of a refiner on the artifact.
  type RefinerRun = { refinerIndex: int, status: RunStatus, result: RefinerResult, restarts: int }

  /// `Drafted` while the refiners hold the artifact. `Ready` once the humans have it.
  type ArtifactStatus = Drafted | Ready({ deliveredRevision: int })

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

  /// The discussion a person comment sits in: the one a person comment opened, or the one under a
  /// comment code posted for a review.
  type Discussion = OpenedBy(int) | UnderReviewComment(int)

  /// A comment a person left on the page. It is acknowledged once code marked its discussion read,
  /// gone once an edit rewrote the block it sits on, sent once a prompt for the author carried it,
  /// and answered once the author posted its comment reply.
  type PersonComment = {
    discussion: Discussion,
    onTheBlock: bool,
    mentions: bool,
    acknowledged: bool,
    gone: bool,
    sent: bool,
    answered: bool,
  }

  /// Where a person leaves a comment: on the page as a whole, on the block, in the discussion of a
  /// person comment, or under a comment code posted for a review.
  type CommentPlace =
    | OnThePageAsAWhole
    | OnTheBlock
    | InTheDiscussionOf(int)
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
  type TurnFailure =
    | ReplyRefused
    | ReplyToAGoneComment
    | EditMeetsAnotherEdit
    | UpdateRefused
    | UpdateLandedThenFailed

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

  /// The turn that ended in a step, if one did.
  type TurnEnd =
    | NoTurnEnd
    | AuthorTurnEnded({ revision: int })
    | AuthorTurnFailed(TurnFailure)
    | RefinerTurnEnded(int)

  /// What an observer saw around the last step: the review before it, the turn that ended, what
  /// happened on the document host, and what the agent read about held comments.
  type Step = { before: ReviewLoop, turnEnd: TurnEnd, page: PageFact, agentHeard: Set[AgentNote] }

  /// A model-call author's turn end: the review after it and how the turn ended.
  type ModelCallTurnEnd = { loop: ReviewLoop, turnEnd: TurnEnd }

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
    discussion: OpenedBy(0),
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

  var review: ReviewLoop
  var lastStep: Step

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

  pure def filedOnRevision(result: RefinerResult, revision: int): bool =
    match result {
      | FiledReview(filed) => filed.revision == revision
      | FiledRuling(filed) => filed.revision == revision
      | NoResult => false
    }

  pure def isReview(result: RefinerResult): bool =
    match result { | FiledReview(_) => true | _ => false }

  pure def reviewHasFindings(result: RefinerResult): bool =
    match result { | FiledReview(filed) => filed.findings | _ => false }

  pure def reviewedRevisionIsNot(result: RefinerResult, revision: int): bool =
    match result { | FiledReview(filed) => filed.revision != revision | _ => false }

  pure def runIds(loop: ReviewLoop): Set[int] = loop.refinerRuns.indices()

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
  pure def entryReadRevision(loop: ReviewLoop, index: int): bool =
    runIds(loop).exists(id =>
      loop.refinerRuns[id].refinerIndex == index and
      filedOnRevision(loop.refinerRuns[id].result, loop.artifact.revision))

  /// The entry that ends the segment `index` sits in.
  pure def segmentEndOf(index: int): int =
    smallest(ENTRIES.indices().filter(end => end >= index and endsSegment(end)), REVIEWER_COUNT - 1)

  /// True when the entry at `index` still has a say on the revision. An entry that reviewed or
  /// ruled on it has not, and neither has a judge entry that ruled on any revision.
  pure def hasASay(loop: ReviewLoop, index: int): bool =
    not(judgeRuledOn(loop, index)) and not(entryReadRevision(loop, index))

  /// The entries from `from` to the end of its segment that still have a say on the revision.
  pure def unreviewedEntriesFrom(loop: ReviewLoop, from: int): Set[int] =
    ENTRIES.indices().filter(index => and {
      index >= from,
      index < REVIEWER_COUNT,
      index <= segmentEndOf(from),
      hasASay(loop, index),
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

  /// The humans get the artifact. A ready artifact keeps the revision they already have.
  pure def handOver(loop: ReviewLoop): ReviewLoop = {
    val status = match loop.artifact.status {
      | Drafted => Ready({ deliveredRevision: loop.artifact.revision })
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
  pure def runRefinersFrom(loop: ReviewLoop, index: int): ReviewLoop = {
    val nextIndex = smallest(
      ENTRIES.indices().filter(candidate => candidate >= index and hasASay(loop, candidate)),
      REFINER_COUNT,
    )
    if (nextIndex >= REFINER_COUNT) handOver(loop) else startRefiner(loop, nextIndex)
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

  /// Mark the discussion of each of these comments read on the page. Every comment already in a
  /// discussion is acknowledged with it.
  pure def acknowledge(loop: ReviewLoop, ids: Set[int]): ReviewLoop = {
    val discussions = ids.map(id => loop.personComments[id].discussion)
    changeComments(loop, (_, comment) =>
      if (discussions.contains(comment.discussion)) { ...comment, acknowledged: true } else comment)
  }

  pure def markSent(loop: ReviewLoop, ids: Set[int]): ReviewLoop =
    changeComments(loop, (id, comment) => if (ids.contains(id)) { ...comment, sent: true } else comment)

  pure def markAnswered(loop: ReviewLoop, ids: Set[int]): ReviewLoop =
    changeComments(loop, (id, comment) => if (ids.contains(id)) { ...comment, answered: true } else comment)

  /// A person comment, held, in `discussion`.
  pure def newComment(discussion: Discussion, onTheBlock: bool, mentions: bool): PersonComment = {
    discussion: discussion,
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
      | InTheDiscussionOf(earlier) =>
        newComment(loop.personComments[earlier].discussion, loop.personComments[earlier].onTheBlock, false)
      | UnderTheReviewComment(posted) => newComment(UnderReviewComment(posted), false, false)
    }
    { ...loop, personComments: loop.personComments.append(comment) }
  }

  /// Where a person can comment now: on the page, on the block, in the discussion of a comment
  /// whose block is there, or under a comment code posted.
  pure def commentPlaces(loop: ReviewLoop): Set[CommentPlace] =
    Set(OnThePageAsAWhole, OnTheBlock)
      .union(personCommentIds(loop)
        .filter(id => not(loop.personComments[id].gone))
        .map(id => InTheDiscussionOf(id)))
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
  pure def advancePastEntry(loop: ReviewLoop, index: int): ReviewLoop =
    if (authorQuiet(loop)) runRefinersFrom(loop, index + 1) else withoutRefinerRun(loop)

  /// Run the open segment again from its first entry that still has a say on the revision. Hand the
  /// artifact on when no entry of it still has a say.
  pure def reviewSegmentAgain(loop: ReviewLoop, index: int): ReviewLoop = {
    val unreviewed = unreviewedEntriesFrom(loop, segmentStartOf(index))
    if (unreviewed.size() == 0) advancePastEntry(loop, index)
    else startRefiner(loop, smallest(unreviewed, REFINER_COUNT))
  }

  /// A findings reviewer's artifact goes where the review again decision says. Without one, the
  /// agent routes it.
  pure def routeFindingsReviewer(loop: ReviewLoop, index: int, decision: ReviewAgainDecision): ReviewLoop =
    match decision {
      | ReviewAgain => reviewSegmentAgain(loop, index)
      | NoReviewAgain => advancePastEntry(loop, index)
      | AgentRoutes => loop
    }

  pure def settleHeldRun(loop: ReviewLoop, id: int, decision: ReviewAgainDecision): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    if (refinerOf(refinerRun) == Polisher) runRefinersFrom(withoutRefinerRun(loop), 0)
    else if (refinerOf(refinerRun) == FindingsReviewer)
      (if (reviewLimitReached(loop, id)) advancePastEntry(loop, refinerRun.refinerIndex)
       else routeFindingsReviewer(loop, refinerRun.refinerIndex, decision))
    else if (isRejection(refinerRun.result)) runRefinersFrom(loop, refinerRun.refinerIndex + 1)
    else loop
  }

  /// The refiners settle once the author is quiet.
  pure def settleRefiners(loop: ReviewLoop, decision: ReviewAgainDecision): ReviewLoop =
    if (not(drafted(loop)) or refinerInFlight(loop) or not(authorQuiet(loop))) loop
    else match loop.artifact.refinerRun {
      | NoRefinerRun => runRefinersFrom(loop, 0)
      | OnRefinerRun(id) => settleHeldRun(loop, id, decision)
    }

  pure def reopenChangedArtifact(loop: ReviewLoop): ReviewLoop =
    match loop.artifact.status {
      | Drafted => loop
      | Ready(handed) =>
        if (handed.deliveredRevision == loop.artifact.revision) loop
        else { ...loop, artifact: { ...loop.artifact, status: Drafted, refinerRun: NoRefinerRun } }
    }

  /// The author's turn ends on the revision `loop` holds.
  pure def authorTurnEnded(loop: ReviewLoop, decision: ReviewAgainDecision): ReviewLoop = {
    val ended = {
      ...loop,
      author: { ...loop.author, atWork: false, turnComments: Set(), pageEditsDuringTurn: Set() },
    }
    drainQueue(settleRefiners(reopenChangedArtifact(ended), decision))
  }

  /// The author fails. Its queued prompts go, its unfinished refiner run is cancelled, and the
  /// humans get the artifact.
  pure def failAuthor(loop: ReviewLoop): ReviewLoop = {
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
    handOver(if (refinerInFlight(stopped)) withStatus(stopped, heldRun(stopped), Cancelled) else stopped)
  }

  pure def turnFailed(loop: ReviewLoop, failure: TurnFailure): ModelCallTurnEnd =
    { loop: failAuthor(loop), turnEnd: AuthorTurnFailed(failure) }

  pure def turnEnded(loop: ReviewLoop, decision: ReviewAgainDecision): ModelCallTurnEnd = {
    val ended = authorTurnEnded(loop, decision)
    { loop: ended, turnEnd: AuthorTurnEnded({ revision: ended.artifact.revision }) }
  }

  /// A model-call author's revise turn ends. It posts one comment reply per comment its prompt
  /// carries, in comment order, and stops at the first the host does not take. Then it writes the
  /// page text change on the text it read when the turn started.
  pure def modelCallTurnEnds(
    loop: ReviewLoop,
    changed: bool,
    part: PagePart,
    write: PageWrite,
    decision: ReviewAgainDecision,
  ): ModelCallTurnEnd = {
    val turn = loop.author.turnComments
    val goneInTurn = turn.filter(id => loop.personComments[id].gone)
    val firstGone = smallest(goneInTurn, loop.personComments.length())
    val replies = if (write == WriteFails(RepliesFail)) Set() else turn.filter(id => id < firstGone)
    val replied = markAnswered(loop, replies)
    if (write == WriteFails(RepliesFail)) turnFailed(replied, ReplyRefused)
    else if (goneInTurn.size() > 0) turnFailed(replied, ReplyToAGoneComment)
    else if (not(changed)) turnEnded(replied, decision)
    else if (write == WriteFails(UpdateFails)) turnFailed(replied, UpdateRefused)
    else if (loop.author.pageEditsDuringTurn.contains(part)) turnFailed(replied, EditMeetsAnotherEdit)
    else if (write == WriteFails(UpdateLandsThenFails)) turnFailed(pageChanged(replied, part), UpdateLandedThenFailed)
    else turnEnded(pageChanged(replied, part), decision)
  }

  /// The author's turn ends, after it changed `part` of the artifact or without a change.
  pure def authorTurnEnds(
    loop: ReviewLoop,
    changed: bool,
    part: PagePart,
    write: PageWrite,
    decision: ReviewAgainDecision,
  ): ModelCallTurnEnd =
    if (MODEL_CALL_AUTHOR) modelCallTurnEnds(loop, changed, part, write, decision)
    else turnEnded(if (changed) pageChanged(loop, part) else loop, decision)

  /// A ruling settles the judge's segment. A rejection posts its reason on a page when the host
  /// takes it, and reaches the author with the findings of the reviewers before the judge. An
  /// approval sends those findings on their own, or moves on.
  pure def applyJudgeRuling(loop: ReviewLoop, id: int, ruling: Ruling, post: HostWrite): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    val index = refinerRun.refinerIndex
    val filed = FiledRuling({ ruling: ruling, revision: loop.artifact.revision })
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
    else advancePastEntry(ruled, index)
  }

  /// A segment settles on the review of the latest run of each entry. A stale review runs the
  /// list again from the segment's first entry that still has a say on the revision.
  pure def settleSegment(loop: ReviewLoop, end: int): ReviewLoop = {
    val start = segmentStartOf(end)
    val filed = segmentReviewRuns(loop, end)
    val stale = filed.exists(id =>
      reviewedRevisionIsNot(loop.refinerRuns[id].result, loop.artifact.revision))
    if (filed.size() == 0) advancePastEntry(loop, end)
    else if (stale and not(authorQuiet(loop))) settleRefiners(loop, AgentRoutes)
    else if (stale) runRefinersFrom(loop, start)
    else if (filed.exists(id => reviewHasFindings(loop.refinerRuns[id].result))) sendFindingsToAuthor(loop, filed)
    else advancePastEntry(loop, end)
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
  /// it. A judge that ruled has no say.
  pure def findingsReviewerFinished(loop: ReviewLoop, id: int, findings: bool, commenting: Commenting): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    val index = refinerRun.refinerIndex
    val filed = FiledReview({ revision: loop.artifact.revision, findings: findings })
    val posted =
      if (ON_A_PAGE) loop.reviewComments.concat(pageReviewComments(id, findings, commenting))
      else loop.reviewComments
    val done = withRun({ ...loop, reviewComments: posted }, id, { ...refinerRun, status: Done, result: filed })
    val end = segmentEndOf(index)
    val handsOn = index != end and unreviewedEntriesFrom(done, index + 1).size() > 0
    if (not(isOnRun(loop, id)) or not(drafted(loop))) done
    else if (handsOn) advancePastEntry(done, index)
    else settleSegment(pointAtLastReviewerOfSegment(done, end), end)
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
  pure def decisionsModelRuled(loop: ReviewLoop, id: int, ruling: Ruling, post: HostWrite): ReviewLoop = {
    val answered = {
      ...loop,
      judgeRunsCodeRulesOn: loop.judgeRunsCodeRulesOn.exclude(Set(id)),
    }
    if (rulingLands(answered, id)) applyJudgeRuling(answered, id, ruling, post)
    else answered
  }

  pure def canPersonRuleOn(loop: ReviewLoop, id: int): bool = and {
    drafted(loop),
    refinerOf(loop.refinerRuns[id]) == Judge,
    loop.refinerRuns[id].status != Unfinished,
    not(isRuling(loop.refinerRuns[id].result)),
  }

  pure def polisherFinished(loop: ReviewLoop, id: int, pushed: bool, part: PagePart): ReviewLoop = {
    val changed = if (pushed) pageChanged(loop, part) else loop
    val done = withStatus(changed, id, Done)
    val handedOn =
      if (isOnRun(done, id) and drafted(done)) advancePastEntry(done, loop.refinerRuns[id].refinerIndex)
      else done
    drainQueue(handedOn)
  }

  /// A polisher that stops early gives the artifact to the humans with what it pushed.
  pure def polisherStopped(loop: ReviewLoop, id: int): ReviewLoop =
    drainQueue(if (isOnRun(loop, id)) handOver(loop) else loop)

  pure def reviewerFailed(loop: ReviewLoop, id: int): ReviewLoop =
    if (not(isOnRun(loop, id))) loop
    else if (drafted(loop)) handOver(loop)
    else withoutRefinerRun(loop)

  pure def refinerRunFailed(loop: ReviewLoop, id: int): ReviewLoop = {
    val failed = withStatus(loop, id, Failed)
    if (refinerOf(loop.refinerRuns[id]) == Polisher) polisherStopped(failed, id)
    else reviewerFailed(failed, id)
  }

  pure def canRequestReviewOn(loop: ReviewLoop, id: int): bool = and {
    loop.refinerRuns[id].refinerIndex < REVIEWER_COUNT,
    refinerOf(loop.refinerRuns[id]) != Judge or loop.refinerRuns[id].status == Cancelled,
    not(reviewLimitReached(loop, id)),
    unreviewedEntriesFrom(loop, segmentStartOf(loop.refinerRuns[id].refinerIndex)).size() > 0,
  }

  pure def agentCanRoute(loop: ReviewLoop): bool = and {
    drafted(loop),
    not(polisherRunning(loop)),
    not(refinerInFlight(loop)),
    authorQuiet(loop),
  }

  /// A person replies in the discussion of the comment `id` while the screen reads.
  pure def personRepliesTo(loop: ReviewLoop, id: int): ReviewLoop =
    withPersonComment(loop, InTheDiscussionOf(id))

  pure def admits(read: HeldRead): bool =
    read == AdmittedAndAcknowledged or read == AdmittedButAcknowledgementFails

  /// Read the held comments and screen them. Admitted, they are marked read on the page and go
  /// to the author in a prompt. Otherwise they stay held and the agent is told so. `agentText`
  /// is true when the agent's own text goes to the author whatever the read found.
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
    val sends = screened and admits(read)
    val acknowledged =
      if (sends and read == AdmittedAndAcknowledged) acknowledge(during, held) else during
    val carried = if (sends) held else Set()
    val prompted = if (agentText or sends) promptAuthorWith(acknowledged, carried) else acknowledged
    val stayHeld = read == HostCannotBeRead or (screened and read == ScreenRefuses)
    { loop: prompted, carried: carried, agentHeard: if (stayHeld) Set(HeldCommentsStayHeld) else Set() }
  }

  /// A person's comment mentions the bot. When the host says so, the held comments go out with
  /// it as one feedback: screened, marked read on the page, then routed. Only the author route
  /// prompts the author. The agent reads the mention with the event in every case. When the host
  /// cannot say, the comment waits as a held comment.
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
    val acknowledged =
      if (read == AdmittedButAcknowledgementFails) during else acknowledge(during, held.union(Set(mention)))
    val toTheAuthor = route == ToTheAuthor and not(loop.author.failed)
    val carried = if (toTheAuthor) held.union(Set(mention)) else Set()
    val asked = HeldCommentsAsked({ by: AMention, read: readHeld, carried: carried })
    if (lookup == TheHostCannotSay) { loop: withMention, page: NoPageFact, agentHeard: Set() }
    else if (read == HostCannotBeRead) {
      loop: withMention,
      page: asked,
      agentHeard: Set(HeldCommentsStayHeld, MentionText),
    }
    else if (refused) { loop: during, page: asked, agentHeard: Set(MentionText) }
    else {
      loop: if (toTheAuthor) promptAuthorWith(acknowledged, carried) else acknowledged,
      page: asked,
      agentHeard: if (screened) Set(HeldCommentText, MentionText) else Set(MentionText),
    }
  }

  action moveWith(after: ReviewLoop, turnEnd: TurnEnd, page: PageFact, agentHeard: Set[AgentNote]): bool = all {
    review' = after,
    lastStep' = { before: review, turnEnd: turnEnd, page: page, agentHeard: agentHeard },
  }

  action move(after: ReviewLoop, turnEnd: TurnEnd): bool = moveWith(after, turnEnd, NoPageFact, Set())

  action init: bool = all {
    review' = INITIAL_REVIEW,
    lastStep' = { before: INITIAL_REVIEW, turnEnd: NoTurnEnd, page: NoPageFact, agentHeard: Set() },
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
    moveWith(sent.loop, NoTurnEnd, page, sent.agentHeard),
  }

  /// The author's turn ends after it changed the artifact.
  action authorTurnEndsOnANewRevision: bool = all {
    review.author.atWork,
    nondet decision = REVIEW_AGAIN_DECISIONS.oneOf()
    nondet part = REVISION_PARTS.oneOf()
    val ended = authorTurnEnds(review, true, part, WritesLand, decision)
    move(ended.loop, ended.turnEnd),
  }

  /// The author's turn ends without a change.
  action authorTurnEndsOnTheSameRevision: bool = all {
    review.author.atWork,
    nondet decision = REVIEW_AGAIN_DECISIONS.oneOf()
    val ended = authorTurnEnds(review, false, Body, WritesLand, decision)
    move(ended.loop, ended.turnEnd),
  }

  /// The model call of a model-call author's turn answers with a changed page, and the host fails
  /// one of its writes.
  action theHostFailsAModelCallAuthorsWrite: bool = all {
    MODEL_CALL_AUTHOR,
    review.author.atWork,
    val failures =
      if (review.author.turnComments.size() > 0) Set(RepliesFail, UpdateFails, UpdateLandsThenFails)
      else Set(UpdateFails, UpdateLandsThenFails)
    nondet failure = failures.oneOf()
    nondet part = REVISION_PARTS.oneOf()
    val ended = modelCallTurnEnds(review, true, part, WriteFails(failure), AgentRoutes)
    move(ended.loop, ended.turnEnd),
  }

  /// A findings reviewer files a review with findings, and its turn ends.
  action findingsReviewerLeavesFindings: bool = all {
    unfinishedRunIs(review, FindingsReviewer),
    nondet commenting = COMMENTINGS.oneOf()
    val id = lastUnfinishedRun(review)
    val page = if (ON_A_PAGE) PageReviewPosted(commenting) else NoPageFact
    moveWith(findingsReviewerFinished(review, id, true, commenting), RefinerTurnEnded(id), page, Set()),
  }

  /// A findings reviewer files an approving review, and its turn ends.
  action findingsReviewerApproves: bool = all {
    unfinishedRunIs(review, FindingsReviewer),
    nondet commenting = COMMENTINGS.oneOf()
    val id = lastUnfinishedRun(review)
    val page = if (ON_A_PAGE) PageReviewPosted(commenting) else NoPageFact
    moveWith(findingsReviewerFinished(review, id, false, commenting), RefinerTurnEnded(id), page, Set()),
  }

  /// A judge closes with its conclusion. The decisions model starts to read it.
  action judgeTurnEnds: bool = all {
    unfinishedRunIs(review, Judge),
    val id = lastUnfinishedRun(review)
    move(judgeFinished(review, id), RefinerTurnEnded(id)),
  }

  pure def rejectionFact(loop: ReviewLoop, id: int, ruling: Ruling, post: HostWrite): PageFact =
    if (ON_A_PAGE and ruling == Rejected and rulingLands(loop, id)) RejectionPosted(post) else NoPageFact

  action decisionsModelRules(ruling: Ruling): bool = {
    nondet judgeRun = review.judgeRunsCodeRulesOn.oneOf()
    nondet post = HOST_WRITES.oneOf()
    moveWith(
      decisionsModelRuled(review, judgeRun, ruling, post),
      NoTurnEnd,
      rejectionFact(review, judgeRun, ruling, post),
      Set(),
    )
  }

  /// The decisions model reads approval in a conclusion.
  action decisionsModelApproves: bool = decisionsModelRules(Approved)

  /// The decisions model reads a rejection in a conclusion.
  action decisionsModelRejects: bool = decisionsModelRules(Rejected)

  /// The decisions model cannot tell, so the agent asks a person to rule.
  action decisionsModelCannotRule: bool = {
    nondet judgeRun = review.judgeRunsCodeRulesOn.oneOf()
    move(
      { ...review, judgeRunsCodeRulesOn: review.judgeRunsCodeRulesOn.exclude(Set(judgeRun)) },
      NoTurnEnd,
    )
  }

  action personRules(ruling: Ruling): bool = all {
    holdsARun(review),
    canPersonRuleOn(review, heldRun(review)),
    nondet post = HOST_WRITES.oneOf()
    val page = if (ON_A_PAGE and ruling == Rejected) RejectionPosted(post) else NoPageFact
    moveWith(applyJudgeRuling(review, heldRun(review), ruling, post), NoTurnEnd, page, Set()),
  }

  /// A person approves the judge run the artifact is on, through the agent.
  action personApproves: bool = personRules(Approved)

  /// A person rejects the judge run the artifact is on, through the agent.
  action personRejects: bool = personRules(Rejected)

  /// A polisher changes the artifact, and its turn ends.
  action polisherPushes: bool = all {
    unfinishedRunIs(review, Polisher),
    nondet part = REVISION_PARTS.oneOf()
    val id = lastUnfinishedRun(review)
    move(polisherFinished(review, id, true, part), RefinerTurnEnded(id)),
  }

  /// A polisher's turn ends without a change.
  action polisherPushesNothing: bool = all {
    unfinishedRunIs(review, Polisher),
    val id = lastUnfinishedRun(review)
    move(polisherFinished(review, id, false, Body), RefinerTurnEnded(id)),
  }

  /// The agent runs the open segment again from its first entry that still has a say on the revision.
  action agentRequestsReview: bool = all {
    agentCanRoute(review),
    holdsARun(review),
    canRequestReviewOn(review, heldRun(review)),
    val start = segmentStartOf(review.refinerRuns[heldRun(review)].refinerIndex)
    move(startRefiner(review, smallest(unreviewedEntriesFrom(review, start), REFINER_COUNT)), NoTurnEnd),
  }

  /// The agent ends the open segment and hands the artifact on.
  action agentFinishesReview: bool = all {
    agentCanRoute(review),
    holdsARun(review),
    refinerOf(review.refinerRuns[heldRun(review)]) != Judge,
    move(advancePastEntry(review, review.refinerRuns[heldRun(review)].refinerIndex), NoTurnEnd),
  }

  /// The agent cancels the unfinished refiner run.
  action agentCancelsRefinerRun: bool = all {
    unfinishedRunIds(review).size() > 0,
    val id = lastUnfinishedRun(review)
    val cancelled = withStatus(review, id, Cancelled)
    move(
      if (refinerOf(review.refinerRuns[id]) == Polisher) polisherStopped(cancelled, id) else cancelled,
      NoTurnEnd,
    ),
  }

  /// The sandbox of the unfinished refiner run dies.
  action refinerRunFails: bool = all {
    unfinishedRunIds(review).size() > 0,
    move(refinerRunFailed(review, lastUnfinishedRun(review)), NoTurnEnd),
  }

  /// The unfinished refiner run says it gave up. It restarts while it has restarts left.
  action refinerRunGivesUp: bool = all {
    unfinishedRunIds(review).size() > 0,
    val id = lastUnfinishedRun(review)
    val refinerRun = review.refinerRuns[id]
    move(
      if (refinerRun.restarts < MAX_RESTARTS) withRun(review, id, { ...refinerRun, restarts: refinerRun.restarts + 1 })
      else refinerRunFailed(review, id),
      NoTurnEnd,
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
    moveWith(handled.loop, NoTurnEnd, handled.page, handled.agentHeard),
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
      moveWith(sent.loop, NoTurnEnd, page, sent.agentHeard)
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
    moveWith(noted, NoTurnEnd, APersonEditedThePage, Set()),
  }

  action step: bool = any {
    agentPromptsAuthor,
    authorTurnEndsOnANewRevision,
    authorTurnEndsOnTheSameRevision,
    theHostFailsAModelCallAuthorsWrite,
    findingsReviewerLeavesFindings,
    findingsReviewerApproves,
    judgeTurnEnds,
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
    refinerRunGivesUp,
    personCommentsOnThePage,
    personMentionsTheBot,
    personAsksForRevision,
    personEditsThePage,
  }

  pure def endedOnRevisionOtherThan(turnEnd: TurnEnd, delivered: int): bool =
    match turnEnd { | AuthorTurnEnded(ended) => ended.revision != delivered | _ => false }

  pure def startedOnAChangedRevision(before: ReviewLoop, turnEnd: TurnEnd): bool =
    match before.artifact.status {
      | Drafted => true
      | Ready(handed) => endedOnRevisionOtherThan(turnEnd, handed.deliveredRevision)
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
    lastStep.before.refinerRuns.indices().forall(id =>
      isRuling(lastStep.before.refinerRuns[id].result)
        implies review.refinerRuns[id].result == lastStep.before.refinerRuns[id].result),
    review.author.rejectedBy.forall(index => runIds(review).exists(id =>
      review.refinerRuns[id].refinerIndex == index and isRejection(review.refinerRuns[id].result))),
  }

  /// A refiner run ends `Done` only in the step its turn ended, or it was already done.
  val refinerRunIsDoneOnlyAfterItsTurnEnded: bool =
    runIds(review).forall(id =>
      review.refinerRuns[id].status == Done implies or {
        id < lastStep.before.refinerRuns.length() and lastStep.before.refinerRuns[id].status == Done,
        lastStep.turnEnd == RefinerTurnEnded(id),
      })

  /// A refiner run starts on an artifact the humans have only when an author turn ended on a
  /// revision they have not seen.
  val refinersRunAgainOnlyOnChangedRevision: bool =
    runIds(review).forall(id =>
      id >= lastStep.before.refinerRuns.length()
        implies startedOnAChangedRevision(lastStep.before, lastStep.turnEnd))

  pure def readByAnEarlierRun(loop: ReviewLoop, id: int): bool =
    runIds(loop).exists(earlier => and {
      earlier < id,
      loop.refinerRuns[earlier].refinerIndex == loop.refinerRuns[id].refinerIndex,
      filedOnRevision(loop.refinerRuns[earlier].result, loop.artifact.revision),
    })

  /// A reviewer run starts only on a revision that no earlier run of its entry filed a review or
  /// ruling of. A host that cannot say the revision counts as a changed one.
  val reviewerRunsOnlyOnAnUnreviewedRevision: bool =
    runIds(review).forall(id =>
      (id >= lastStep.before.refinerRuns.length() and refinerOf(review.refinerRuns[id]) != Polisher)
        implies not(readByAnEarlierRun(review, id)))

  /// The refiner runs that started in the last step.
  val startedRuns: Set[int] = runIds(review).filter(id => id >= lastStep.before.refinerRuns.length())

  /// The latest run of each findings entry whose segment ends before `index`, when that run filed
  /// a review with findings.
  pure def findingsBefore(loop: ReviewLoop, index: int): Set[int] =
    runIds(loop).filter(id => and {
      refinerOf(loop.refinerRuns[id]) == FindingsReviewer,
      segmentEndOf(loop.refinerRuns[id].refinerIndex) < index,
      id == latestRunOf(loop, loop.refinerRuns[id].refinerIndex),
      reviewHasFindings(loop.refinerRuns[id].result),
    })

  /// Every review a findings reviewer files on a pull request reaches its author as a prompt. A
  /// judge's approval does not drop it.
  val authorGetsEveryPullFinding: bool =
    ARTIFACT == Page or startedRuns.forall(started =>
      findingsBefore(review, review.refinerRuns[started].refinerIndex)
        .forall(id => review.author.findingsFrom.contains(id)))

  /// True when the author got a prompt with findings it did not have in the last step.
  val authorGotNewFindings: bool = review.author.findingsFrom != lastStep.before.author.findingsFrom

  /// A review prompt the author of a page gets in the step its reviewer ended carries every
  /// finding of that review.
  val authorGetsEveryPageFinding: bool =
    ARTIFACT == PullRequest or match lastStep.turnEnd {
      | RefinerTurnEnded(id) =>
        (authorGotNewFindings and reviewHasFindings(review.refinerRuns[id].result))
          implies review.author.findingsFrom.contains(id)
      | _ => true
    }

  /// A prompt queued for a model-call author reaches it. A model-call author with a queued
  /// prompt has a model turn in flight, or a polisher holds its page.
  val aQueuedPromptReachesItsModelCallAuthor: bool = or {
    not(MODEL_CALL_AUTHOR),
    review.author.queuedPrompts.length() == 0,
    review.author.atWork,
    unfinishedRunIds(review).exists(id => refinerOf(review.refinerRuns[id]) == Polisher),
  }

  /// The review comments posted in the last step.
  val postedInLastStep: List[ReviewComment] =
    review.reviewComments.slice(lastStep.before.reviewComments.length(), review.reviewComments.length())

  pure def isOutcomeComment(comment: ReviewComment): bool =
    match comment { | OutcomeComment(_) => true | _ => false }

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

  /// When a page review reaches the document host, each finding lands once, on its passage or in
  /// the outcome comment, and the outcome comment opens with the review line. A turn that did not
  /// file a review does not post a comment.
  val pageReviewPostsEachFindingOnce: bool =
    match lastStep.page {
      | PageReviewPosted(commenting) => match lastStep.turnEnd {
        | RefinerTurnEnded(id) => {
          val result = review.refinerRuns[id].result
          val hostUp = commenting != HostDown
          val findings = if (reviewHasFindings(result)) REVIEW_PASSAGES else Set()
          if (not(isReview(result))) postedInLastStep.length() == 0
          else and {
            not(hostUp) or countOf(postedInLastStep, isOutcomeComment) == 1,
            postedInLastStep.foldl(true, (opensWithTheLine, comment) =>
              opensWithTheLine and (isOutcomeComment(comment) implies approves(comment) == not(reviewHasFindings(result)))),
            findings.forall(passage => and {
              findingLanded(postedInLastStep, passage) <= 1,
              hostUp implies findingLanded(postedInLastStep, passage) == 1,
            }),
            REVIEW_PASSAGES.exclude(findings).forall(passage => findingLanded(postedInLastStep, passage) == 0),
          }
        }
        | _ => true
      }
      | _ => true
    }

  /// True when the comment `id` was held before the last step, or a person left it in the step.
  def heldBeforeOrNew(id: int): bool =
    id >= lastStep.before.personComments.length() or isHeld(lastStep.before.personComments[id])

  /// A prompt the agent sends to the author of a page, and a person's request for a revision,
  /// carry every comment held on the page and mark it read. When the host cannot be read or the
  /// screen does not admit them, no prompt carries them, they stay held, and the agent is told
  /// so. An author that finished during the step is not owed them.
  val aPromptToAPageAuthorCarriesItsHeldComments: bool =
    match lastStep.page {
      | HeldCommentsAsked(asked) => {
        val heldBefore = heldCommentIds(lastStep.before)
        or {
          asked.by == AMention,
          review.author.failed,
          heldBefore.size() == 0,
          if (admits(asked.read))
            heldBefore.forall(id => asked.carried.contains(id) and not(isHeld(review.personComments[id])))
          else and {
            heldBefore.forall(id => not(asked.carried.contains(id)) and isHeld(review.personComments[id])),
            not(lastStep.agentHeard.contains(HeldCommentText)),
            lastStep.agentHeard.contains(HeldCommentsStayHeld),
          },
        }
      }
      | _ => true
    }

  /// Held comments a person's revision request or mention sends, when the host cannot be read or
  /// the screen does not admit them, reach neither the agent nor the author. No prompt goes out
  /// and the agent does not read their text.
  val unadmittedFeedbackReachesNobody: bool =
    match lastStep.page {
      | HeldCommentsAsked(asked) =>
        (asked.by != TheAgent and not(admits(asked.read))) implies and {
          review.author.queuedPrompts == lastStep.before.author.queuedPrompts,
          review.author.atWork == lastStep.before.author.atWork,
          not(lastStep.agentHeard.contains(HeldCommentText)),
        }
      | _ => true
    }

  /// True when the last step ended a model-call author's revise turn, whether it wrote or failed.
  val aModelCallTurnEnded: bool = MODEL_CALL_AUTHOR and match lastStep.turnEnd {
    | AuthorTurnEnded(_) => true
    | AuthorTurnFailed(_) => true
    | _ => false
  }

  /// A revision removes the block of a person comment the author was sent only after the author's
  /// comment reply is in that comment's discussion.
  val sentCommentIsAnsweredBeforeItsLineGoes: bool =
    not(aModelCallTurnEnded) or personCommentIds(review).forall(id => and {
      id < lastStep.before.personComments.length(),
      lastStep.before.personComments[id].sent,
      not(lastStep.before.personComments[id].gone),
      review.personComments[id].gone,
    } implies review.personComments[id].answered)

  /// The author replies only to a comment it was sent.
  val replyGoesOnlyToASentComment: bool =
    personCommentIds(review).forall(id =>
      review.personComments[id].answered implies review.personComments[id].sent)

  /// A revision that posted fewer comment replies than its prompt carries comments leaves the
  /// page as it was.
  val failedReplyLeavesThePage: bool =
    not(aModelCallTurnEnded) or
      lastStep.before.author.turnComments.forall(id => review.personComments[id].answered) or
      review.artifact.revision == lastStep.before.artifact.revision

  /// A judge rejection on a page posts its reason in one comment when the host takes it, and the
  /// author gets the rejection whether the post landed or not.
  val aJudgeRejectionPostsItsReasonOnce: bool =
    match lastStep.page {
      | RejectionPosted(post) => and {
        countOf(postedInLastStep, comment => match comment { | RejectionComment(_) => true | _ => false })
          == (if (post == HostTakes) 1 else 0),
        review.author.rejectedBy.size() > lastStep.before.author.rejectedBy.size(),
      }
      | _ => true
    }

  /// A person comment that does not mention the bot stays held until a prompt that carries it is
  /// queued for the author. Only the end of the author, or a person's edit that rewrites its
  /// block, ends it sooner.
  val aHeldCommentStaysHeldUntilItReachesTheAuthor: bool = or {
    review.author.failed,
    lastStep.page == APersonEditedThePage,
    personCommentIds(review).forall(id => and {
      heldBeforeOrNew(id),
      not(review.personComments[id].mentions),
      not(isHeld(review.personComments[id])),
    } implies review.personComments[id].sent),
  }

  /// A model-call author's revise turn fails only when the document host refuses or loses one of
  /// its writes. An edit to the page by a person, a polisher, or an earlier revision does not
  /// fail it.
  val aModelCallAuthorFailsOnlyOnAHostError: bool =
    match lastStep.turnEnd {
      | AuthorTurnFailed(failure) => failure != ReplyToAGoneComment and failure != EditMeetsAnotherEdit
      | _ => true
    }

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
  }

  /// Witness for `oneUnfinishedRefinerRunPerArtifact`: a refiner run is unfinished.
  val aRefinerRunIsUnfinished: bool = unfinishedRunIds(review).size() > 0

  /// Witness for `authorIsIdleWhileAPolisherRuns`: a prompt waits for the author while a polisher runs.
  val aPromptWaitsWhileAPolisherRuns: bool =
    polisherRunning(review) and review.author.queuedPrompts.length() > 0

  /// Witness for `judgeRulesAtMostOnce`: a ruling lands on a judge run that already has one.
  val aRulingLandsOnARuledJudgeRun: bool =
    lastStep.before.judgeRunsCodeRulesOn.exists(id =>
      not(review.judgeRunsCodeRulesOn.contains(id)) and isRuling(lastStep.before.refinerRuns[id].result))

  /// Witness for `judgeRulesAtMostOnce`: the author got a rejection from a judge entry.
  val theAuthorGotARejection: bool = review.author.rejectedBy.size() > 0

  /// Witness for `reviewerRunsOnlyOnAnUnreviewedRevision`: a reviewer entry runs again on a new revision.
  val aReviewerRunsAgainOnANewRevision: bool =
    runIds(review).exists(id => and {
      id >= lastStep.before.refinerRuns.length(),
      refinerOf(review.refinerRuns[id]) != Polisher,
      runIds(review).exists(earlier =>
        earlier < id and review.refinerRuns[earlier].refinerIndex == review.refinerRuns[id].refinerIndex),
    })

  /// Witness for `refinerRunIsDoneOnlyAfterItsTurnEnded`: a refiner run ends done.
  val aRefinerRunEndsDone: bool = match lastStep.turnEnd {
    | RefinerTurnEnded(id) => review.refinerRuns[id].status == Done
    | _ => false
  }

  /// Witness for `refinersRunAgainOnlyOnChangedRevision`: a refiner run starts on an artifact the humans had.
  val aRefinerRunStartsAfterAHandover: bool = and {
    lastStep.before.artifact.status != Drafted,
    review.refinerRuns.length() > lastStep.before.refinerRuns.length(),
  }

  /// Witness for `authorGetsEveryPullFinding`: a refiner run starts past a review with findings.
  val aRefinerRunStartsPastFindings: bool =
    startedRuns.exists(started => findingsBefore(review, review.refinerRuns[started].refinerIndex).size() > 0)

  /// Witness for `authorGetsEveryPullFinding`: a refiner run starts past a judge whose segment
  /// left findings.
  val aRefinerRunStartsPastAJudgeWithFindings: bool =
    startedRuns.exists(started =>
      findingsBefore(review, review.refinerRuns[started].refinerIndex)
        .exists(id => ENTRIES[segmentEndOf(review.refinerRuns[id].refinerIndex)] == Judge))

  /// Witness for `authorGetsEveryPageFinding`: the author of a page gets the findings of the
  /// reviewer that just ended.
  val aPageAuthorGetsTheFindingsOfItsReviewer: bool =
    ARTIFACT == Page and authorGotNewFindings and match lastStep.turnEnd {
      | RefinerTurnEnded(id) => review.author.findingsFrom.contains(id)
      | _ => false
    }

  /// Witness for `aQueuedPromptReachesItsModelCallAuthor`: a model-call author has a queued prompt.
  val aModelCallAuthorHasAQueuedPrompt: bool =
    MODEL_CALL_AUTHOR and review.author.queuedPrompts.length() > 0

  /// The humans have the artifact.
  val theHumansHaveTheArtifact: bool = not(drafted(review))

  /// A stale review runs its segment again.
  val aStaleReviewRunsTheSegmentAgain: bool = match lastStep.turnEnd {
    | RefinerTurnEnded(id) => runIds(review).exists(started => and {
        started >= lastStep.before.refinerRuns.length(),
        review.refinerRuns[started].refinerIndex <= review.refinerRuns[id].refinerIndex,
      })
    | _ => false
  }

  /// A reviewer reached the review limit.
  val aReviewerReachedTheLimit: bool = runIds(review).exists(id => reviewLimitReached(review, id))

  /// A refiner run restarted after it gave up.
  val aRefinerRunRestarted: bool = runIds(review).exists(id => review.refinerRuns[id].restarts > 0)

  /// A polisher pushed and handed the artifact on.
  val aPolisherFinished: bool = runIds(review).exists(id =>
    refinerOf(review.refinerRuns[id]) == Polisher and review.refinerRuns[id].status == Done)

  /// Witness for `pageReviewPostsEachFindingOnce`: a page review posts an inline finding and its
  /// outcome comment.
  val aPageReviewPostsAnInlineFinding: bool =
    lastStep.page == PageReviewPosted(TakesAll) and findingLanded(postedInLastStep, QuotesThePage) == 1

  /// Witness for `pageReviewPostsEachFindingOnce`: the host fails the inline findings of a page
  /// review with findings, and they move into the outcome comment.
  val aPageReviewMovesInlineFindingsIntoItsOutcome: bool = and {
    lastStep.page == PageReviewPosted(InlineThrows) or lastStep.page == PageReviewPosted(DropsInline),
    postedInLastStep.foldl(false, (found, comment) => found or match comment {
      | OutcomeComment(outcome) => outcome.findings.contains(QuotesThePage)
      | _ => false
    }),
  }

  /// Witness for `pageReviewPostsEachFindingOnce`: a page review meets a host that is down.
  val aPageReviewMeetsAHostThatIsDown: bool = lastStep.page == PageReviewPosted(HostDown)

  /// Witness for `aPromptToAPageAuthorCarriesItsHeldComments`: held comments go to the author.
  val heldCommentsGoToThePageAuthor: bool = match lastStep.page {
    | HeldCommentsAsked(asked) => asked.by != AMention and asked.carried.size() > 0
    | _ => false
  }

  /// Witness for `aPromptToAPageAuthorCarriesItsHeldComments`: held comments stay held.
  val heldCommentsStayHeld: bool = match lastStep.page {
    | HeldCommentsAsked(asked) =>
      asked.by != AMention and not(admits(asked.read)) and heldCommentIds(lastStep.before).size() > 0
    | _ => false
  }

  /// Witness for `unadmittedFeedbackReachesNobody`: the screen keeps the held comments of a
  /// mention or a revision request.
  val theScreenKeepsHeldComments: bool = match lastStep.page {
    | HeldCommentsAsked(asked) => asked.by != TheAgent and asked.read == ScreenRefuses
    | _ => false
  }

  /// Witness for `replyGoesOnlyToASentComment`: the author posts a comment reply.
  val theAuthorRepliesToAComment: bool =
    personCommentIds(review).exists(id => review.personComments[id].answered)

  /// Witness for `sentCommentIsAnsweredBeforeItsLineGoes`: a revision rewrites the block of an
  /// answered comment.
  val aRevisionRewritesTheBlockOfAnAnsweredComment: bool =
    aModelCallTurnEnded and personCommentIds(review).exists(id => and {
      id < lastStep.before.personComments.length(),
      not(lastStep.before.personComments[id].gone),
      review.personComments[id].gone,
      review.personComments[id].answered,
    })

  /// Witness for `failedReplyLeavesThePage`: a comment reply fails.
  val aCommentReplyFails: bool =
    lastStep.turnEnd == AuthorTurnFailed(ReplyRefused) or lastStep.turnEnd == AuthorTurnFailed(ReplyToAGoneComment)

  /// Witness for `aJudgeRejectionPostsItsReasonOnce`: a rejection lands on the page.
  val aRejectionLandsOnThePage: bool = lastStep.page == RejectionPosted(HostTakes)

  /// Witness for `aJudgeRejectionPostsItsReasonOnce`: the host fails the post of a rejection.
  val theHostFailsARejection: bool = lastStep.page == RejectionPosted(HostFails)

  /// Witness for `aHeldCommentStaysHeldUntilItReachesTheAuthor`: a held comment reaches the author.
  val aHeldCommentReachesTheAuthor: bool =
    personCommentIds(review).exists(id => and {
      heldBeforeOrNew(id),
      not(isHeld(review.personComments[id])),
      review.personComments[id].sent,
    })

  /// Witness for `aModelCallAuthorFailsOnlyOnAHostError`: the host fails a model-call author's write.
  val theHostFailsAModelCallAuthor: bool = match lastStep.turnEnd {
    | AuthorTurnFailed(failure) => failure == UpdateRefused or failure == UpdateLandedThenFailed
    | _ => false
  }

  /// Witness for `aModelCallAuthorFailsOnlyOnAHostError`: a person edits the page while a
  /// model-call author's turn runs.
  val aPersonEditsDuringAModelCallTurn: bool =
    lastStep.page == APersonEditedThePage and review.author.pageEditsDuringTurn.size() > 0
}
