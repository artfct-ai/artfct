/// The agent review of one output artifact, from the first artifact of its author to the handover.
/// Each action is one stretch of the orchestrator that runs to its end before the next event lands.
/// A judge run splits in two: its turn ends, then code rules on its conclusion with the decisions model.
module reviewLoopTypes {
  /// One refiner of the stage. The reviewers come first, then the polishers.
  type Refiner = FindingsReviewer | Judge | Polisher

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

  /// The author task: whether a turn runs or starts, how many prompts wait for it, and the
  /// judge entries whose rejection it got.
  type Author = { atWork: bool, queuedPrompts: int, rejectedBy: Set[int] }

  /// The review again decision over a model-call author's closing text. A harness author does
  /// not get one, and neither does a model-call author when the decisions model cannot say.
  /// Then the agent routes.
  type ReviewAgainDecision = ReviewAgain | NoReviewAgain | AgentRoutes

  /// The review of one artifact, and the done judge runs whose conclusion code is ruling on.
  type ReviewLoop = {
    author: Author,
    artifact: Artifact,
    refinerRuns: List[RefinerRun],
    judgeRunsCodeRulesOn: Set[int],
  }

  /// The turn that ended in a step, if one did.
  type TurnEnd = NoTurnEnd | AuthorTurnEnded({ revision: int }) | RefinerTurnEnded(int)

  /// What an observer saw around the last step: the review before it, and the turn that ended.
  type Step = { before: ReviewLoop, turnEnd: TurnEnd }
}

/// The review loop over one stage's refiner list.
module reviewLoop {
  import reviewLoopTypes.*

  /// The refiner list of the stage.
  const ENTRIES: List[Refiner]

  /// True when the author is a model-call author, false for a harness author.
  const MODEL_CALL_AUTHOR: bool

  /// How often one reviewer runs on one artifact. The config default.
  pure val MAX_REVIEW_RUNS: int = 3

  /// How often a refiner run starts over after it gave up. The next time it fails.
  pure val MAX_RESTARTS: int = 2

  pure val REFINER_COUNT: int = ENTRIES.length()

  pure val REVIEWER_COUNT: int =
    ENTRIES.foldl(0, (count, refiner) => if (refiner == Polisher) count else count + 1)

  pure val INITIAL_REVIEW: ReviewLoop = {
    author: { atWork: true, queuedPrompts: 0, rejectedBy: Set() },
    artifact: { status: Drafted, revision: 0, refinerRun: NoRefinerRun },
    refinerRuns: List(),
    judgeRunsCodeRulesOn: Set(),
  }

  pure val REVIEW_AGAIN_DECISIONS: Set[ReviewAgainDecision] =
    if (MODEL_CALL_AUTHOR) Set(ReviewAgain, NoReviewAgain, AgentRoutes) else Set(AgentRoutes)

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

  pure def isOnRun(loop: ReviewLoop, id: int): bool =
    loop.artifact.refinerRun == OnRefinerRun(id)

  pure def holdsARun(loop: ReviewLoop): bool = loop.artifact.refinerRun != NoRefinerRun

  /// The refiner run the artifact is on. Only defined while it is on one.
  pure def heldRun(loop: ReviewLoop): int =
    match loop.artifact.refinerRun { | OnRefinerRun(id) => id | NoRefinerRun => 0 }

  pure def drafted(loop: ReviewLoop): bool = loop.artifact.status == Drafted

  pure def authorQuiet(loop: ReviewLoop): bool =
    not(loop.author.atWork) and loop.author.queuedPrompts == 0

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

  /// The entries from `from` to the end of its segment that still have to read the revision. A
  /// judge entry always has to.
  pure def unreviewedEntriesFrom(loop: ReviewLoop, from: int): Set[int] =
    ENTRIES.indices().filter(index => and {
      index >= from,
      index < REVIEWER_COUNT,
      index <= segmentEndOf(from),
      ENTRIES[index] == Judge or not(entryReadRevision(loop, index)),
    })

  /// The entry a re-run of the list starts at. It passes over the leading entries that read the
  /// revision, and the judge entries that ruled.
  pure def firstEntryToRerun(loop: ReviewLoop): int =
    smallest(
      ENTRIES.indices().filter(index =>
        index < REVIEWER_COUNT and not(entryReadRevision(loop, index)) and not(judgeRuledOn(loop, index))),
      REVIEWER_COUNT,
    )

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
      ENTRIES.indices().filter(candidate => candidate >= index and not(judgeRuledOn(loop, candidate))),
      REFINER_COUNT,
    )
    if (nextIndex >= REFINER_COUNT) handOver(loop) else startRefiner(loop, nextIndex)
  }

  /// Send the oldest queued prompt when the author can take it.
  pure def drainQueue(loop: ReviewLoop): ReviewLoop =
    if (not(loop.author.atWork) and loop.author.queuedPrompts > 0 and not(polisherRunning(loop)))
      { ...loop, author: { ...loop.author, atWork: true, queuedPrompts: loop.author.queuedPrompts - 1 } }
    else loop

  pure def promptAuthor(loop: ReviewLoop): ReviewLoop =
    drainQueue({ ...loop, author: { ...loop.author, queuedPrompts: loop.author.queuedPrompts + 1 } })

  /// Run the list again from its first entry that has to read the revision.
  pure def rerunRefiners(loop: ReviewLoop): ReviewLoop = runRefinersFrom(loop, firstEntryToRerun(loop))

  /// A working author stops the refiners. They run again once its turn ends.
  pure def advancePastEntry(loop: ReviewLoop, index: int): ReviewLoop =
    if (authorQuiet(loop)) runRefinersFrom(loop, index + 1) else withoutRefinerRun(loop)

  /// Run the open segment again from its first entry that has to read the revision. Hand the
  /// artifact on when every entry of it read the revision.
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
    if (refinerOf(refinerRun) == Polisher) rerunRefiners(withoutRefinerRun(loop))
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
      | NoRefinerRun => rerunRefiners(loop)
      | OnRefinerRun(id) => settleHeldRun(loop, id, decision)
    }

  pure def reopenChangedArtifact(loop: ReviewLoop): ReviewLoop =
    match loop.artifact.status {
      | Drafted => loop
      | Ready(handed) =>
        if (handed.deliveredRevision == loop.artifact.revision) loop
        else { ...loop, artifact: { ...loop.artifact, status: Drafted, refinerRun: NoRefinerRun } }
    }

  pure def authorTurnEnded(loop: ReviewLoop, changed: bool, decision: ReviewAgainDecision): ReviewLoop = {
    val revision = if (changed) loop.artifact.revision + 1 else loop.artifact.revision
    val ended = {
      ...loop,
      author: { ...loop.author, atWork: false },
      artifact: { ...loop.artifact, revision: revision },
    }
    drainQueue(settleRefiners(reopenChangedArtifact(ended), decision))
  }

  pure def applyJudgeRuling(loop: ReviewLoop, id: int, ruling: Ruling): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    val filed = FiledRuling({ ruling: ruling, revision: loop.artifact.revision })
    val ruled = withRun(loop, id, { ...refinerRun, result: filed })
    if (ruling == Approved) advancePastEntry(ruled, refinerRun.refinerIndex)
    else {
      val rejectedBy = ruled.author.rejectedBy.union(Set(refinerRun.refinerIndex))
      promptAuthor({ ...ruled, author: { ...ruled.author, rejectedBy: rejectedBy } })
    }
  }

  /// A segment settles on the review of the latest run of each entry. A stale review runs the
  /// segment again from its first entry that has to read the revision.
  pure def settleSegment(loop: ReviewLoop, end: int): ReviewLoop = {
    val start = segmentStartOf(end)
    val unreviewed = unreviewedEntriesFrom(loop, start)
    val filed = runIds(loop).filter(id => and {
      loop.refinerRuns[id].refinerIndex >= start,
      loop.refinerRuns[id].refinerIndex <= end,
      id == latestRunOf(loop, loop.refinerRuns[id].refinerIndex),
      isReview(loop.refinerRuns[id].result),
    })
    val stale = filed.exists(id =>
      reviewedRevisionIsNot(loop.refinerRuns[id].result, loop.artifact.revision))
    if (filed.size() == 0) advancePastEntry(loop, end)
    else if (stale and not(authorQuiet(loop))) settleRefiners(loop, AgentRoutes)
    else if (stale) startRefiner(loop, if (unreviewed.size() == 0) start else smallest(unreviewed, REFINER_COUNT))
    else if (filed.exists(id => reviewHasFindings(loop.refinerRuns[id].result))) promptAuthor(loop)
    else advancePastEntry(loop, end)
  }

  /// A finished reviewer hands on to the next entry of its segment that has to read the revision.
  /// When none has to, the segment settles, and the artifact moves to the run that ends it.
  pure def findingsReviewerFinished(loop: ReviewLoop, id: int, findings: bool): ReviewLoop = {
    val refinerRun = loop.refinerRuns[id]
    val index = refinerRun.refinerIndex
    val filed = FiledReview({ revision: loop.artifact.revision, findings: findings })
    val done = withRun(loop, id, { ...refinerRun, status: Done, result: filed })
    val unreviewed = if (endsSegment(index)) Set() else unreviewedEntriesFrom(done, index + 1)
    val end = segmentEndOf(index)
    val onEnd =
      if (end == index) done
      else { ...done, artifact: { ...done.artifact, refinerRun: OnRefinerRun(latestRunOf(done, end)) } }
    if (not(isOnRun(loop, id)) or not(drafted(loop))) done
    else if (unreviewed.size() > 0) advancePastEntry(done, smallest(unreviewed, REFINER_COUNT) - 1)
    else settleSegment(onEnd, end)
  }

  pure def judgeFinished(loop: ReviewLoop, id: int): ReviewLoop = {
    val done = withStatus(loop, id, Done)
    if (isOnRun(loop, id) and drafted(loop))
      { ...done, judgeRunsCodeRulesOn: done.judgeRunsCodeRulesOn.union(Set(id)) }
    else done
  }

  /// A ruling lands only on the judge run the artifact is still on, and only once.
  pure def decisionsModelRuled(loop: ReviewLoop, id: int, ruling: Ruling): ReviewLoop = {
    val answered = {
      ...loop,
      judgeRunsCodeRulesOn: loop.judgeRunsCodeRulesOn.exclude(Set(id)),
    }
    if (isOnRun(answered, id) and drafted(answered) and not(isRuling(answered.refinerRuns[id].result)))
      applyJudgeRuling(answered, id, ruling)
    else answered
  }

  pure def canPersonRuleOn(loop: ReviewLoop, id: int): bool = and {
    drafted(loop),
    refinerOf(loop.refinerRuns[id]) == Judge,
    loop.refinerRuns[id].status != Unfinished,
    not(isRuling(loop.refinerRuns[id].result)),
  }

  pure def polisherFinished(loop: ReviewLoop, id: int, pushed: bool): ReviewLoop = {
    val revision = if (pushed) loop.artifact.revision + 1 else loop.artifact.revision
    val done = withStatus({ ...loop, artifact: { ...loop.artifact, revision: revision } }, id, Done)
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

  action move(after: ReviewLoop, turnEnd: TurnEnd): bool = all {
    review' = after,
    lastStep' = { before: review, turnEnd: turnEnd },
  }

  action unfinishedRunOf(refiner: Refiner, act: int => bool): bool = all {
    unfinishedRunIds(review).size() > 0,
    refinerOf(review.refinerRuns[lastUnfinishedRun(review)]) == refiner,
    act(lastUnfinishedRun(review)),
  }

  action init: bool = all {
    review' = INITIAL_REVIEW,
    lastStep' = { before: INITIAL_REVIEW, turnEnd: NoTurnEnd },
  }

  /// The agent sends the author a prompt of its own.
  action agentPromptsAuthor: bool = move(promptAuthor(review), NoTurnEnd)

  /// The author's turn ends after it pushed a new revision.
  action authorTurnEndsOnANewRevision: bool = all {
    review.author.atWork,
    nondet decision = REVIEW_AGAIN_DECISIONS.oneOf()
    val ended = authorTurnEnded(review, true, decision)
    move(ended, AuthorTurnEnded({ revision: ended.artifact.revision })),
  }

  /// The author's turn ends without a push.
  action authorTurnEndsOnTheSameRevision: bool = all {
    review.author.atWork,
    nondet decision = REVIEW_AGAIN_DECISIONS.oneOf()
    move(authorTurnEnded(review, false, decision), AuthorTurnEnded({ revision: review.artifact.revision })),
  }

  /// A findings reviewer files a review with findings, and its turn ends.
  action findingsReviewerLeavesFindings: bool = unfinishedRunOf(FindingsReviewer, id =>
    move(findingsReviewerFinished(review, id, true), RefinerTurnEnded(id)))

  /// A findings reviewer files an approving review, and its turn ends.
  action findingsReviewerApproves: bool = unfinishedRunOf(FindingsReviewer, id =>
    move(findingsReviewerFinished(review, id, false), RefinerTurnEnded(id)))

  /// A judge closes with its conclusion. The decisions model starts to read it.
  action judgeTurnEnds: bool = unfinishedRunOf(Judge, id =>
    move(judgeFinished(review, id), RefinerTurnEnded(id)))

  /// The decisions model reads approval in a conclusion.
  action decisionsModelApproves: bool = {
    nondet judgeRun = review.judgeRunsCodeRulesOn.oneOf()
    move(decisionsModelRuled(review, judgeRun, Approved), NoTurnEnd)
  }

  /// The decisions model reads a rejection in a conclusion.
  action decisionsModelRejects: bool = {
    nondet judgeRun = review.judgeRunsCodeRulesOn.oneOf()
    move(decisionsModelRuled(review, judgeRun, Rejected), NoTurnEnd)
  }

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
    move(applyJudgeRuling(review, heldRun(review), ruling), NoTurnEnd),
  }

  /// A person approves the judge run the artifact is on, through the agent.
  action personApproves: bool = personRules(Approved)

  /// A person rejects the judge run the artifact is on, through the agent.
  action personRejects: bool = personRules(Rejected)

  /// A polisher pushes a new revision, and its turn ends.
  action polisherPushes: bool = unfinishedRunOf(Polisher, id =>
    move(polisherFinished(review, id, true), RefinerTurnEnded(id)))

  /// A polisher's turn ends without a push.
  action polisherPushesNothing: bool = unfinishedRunOf(Polisher, id =>
    move(polisherFinished(review, id, false), RefinerTurnEnded(id)))

  /// The agent runs the open segment again from its first entry that has to read the revision.
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

  action step: bool = any {
    agentPromptsAuthor,
    authorTurnEndsOnANewRevision,
    authorTurnEndsOnTheSameRevision,
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

  /// Every invariant above, for one check of all of them.
  val invariants: bool = and {
    oneUnfinishedRefinerRunPerArtifact,
    authorIsIdleWhileAPolisherRuns,
    judgeRulesAtMostOnce,
    refinerRunIsDoneOnlyAfterItsTurnEnded,
    refinersRunAgainOnlyOnChangedRevision,
    reviewerRunsOnlyOnAnUnreviewedRevision,
  }

  /// Witness for `oneUnfinishedRefinerRunPerArtifact`: a refiner run is unfinished.
  val aRefinerRunIsUnfinished: bool = unfinishedRunIds(review).size() > 0

  /// Witness for `authorIsIdleWhileAPolisherRuns`: a prompt waits for the author while a polisher runs.
  val aPromptWaitsWhileAPolisherRuns: bool = polisherRunning(review) and review.author.queuedPrompts > 0

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
}
