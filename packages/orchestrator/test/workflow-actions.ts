import type { StopReason } from "@agentclientprotocol/sdk";
import { artifactTools } from "../src/agent/tools/artifact";
import { planTools } from "../src/agent/tools/plan";
import { startTools } from "../src/agent/tools/start/start";
import { taskTools } from "../src/agent/tools/task";
import { onFlushBoard, type BoardAlarm } from "../src/workflow/board/board";
import type { ChecksAlarm } from "../src/workflow/refiner/checks-gate";
import { recheckChecks } from "../src/workflow/refiner/checks-recheck";
import { failTask, onIdle } from "../src/workflow/lifecycle";
import { isTaskFinished } from "../src/workflow/store/state";
import { onBridgeLost } from "../src/workflow/task/harness/bridge";
import { retryQueue } from "../src/workflow/task/harness/prompt-queue";
import {
  RESEARCH_PAYLOAD_MAX_BYTES,
  RESEARCH_PAYLOAD_PATH,
} from "../src/workflow/task/sandbox/research-payload";
import {
  keepSandboxAlive,
  onHelloTimeout,
  onNoProgress,
  onWallClock,
  type GenerationAlarm,
  type TaskAlarm,
} from "../src/workflow/task/harness/timers";
import type { ScheduledMethod, WorkflowRuntime } from "../src/workflow/types";
import type { FakeBridge } from "./fake-bridge";
import { JUDGE_CONCLUSION } from "./fake-runtime";
import {
  MAX_AUTHORS,
  REPO,
  STAGE_OF,
  UNOWNED_PULL,
  type AgentAtMessage,
  type ArtifactKind,
  type ChecksReport,
  type DecisionAnswers,
  type Mergeability,
  type StepFacts,
  type WorkflowAction,
  type WorkflowWorld,
  type WorldAuthor,
} from "./workflow-world";

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };

function action(
  label: string,
  run: (world: WorkflowWorld) => Promise<StepFacts | void>,
): WorkflowAction {
  return { run, toString: () => label };
}

/** An action about one author task. `index` counts round the authors the world holds by then. */
function authorAction(
  index: number,
  label: string,
  run: (world: WorkflowWorld, author: WorldAuthor) => Promise<StepFacts | void>,
): WorkflowAction {
  return action(`author ${index}: ${label}`, async (world) => {
    const author = world.authorAt(index);
    return author ? run(world, author) : undefined;
  });
}

/** What the turn text of a harness turn says. */
export type Closing = "reports_work" | "gives_up";

const GAVE_UP_TEXT = "I could not check out the branch, so I did not do the work.";
const REPORTS_WORK_ANSWERS = { for_author: 0, beyond_author: 0, rejects: 0 };
const GAVE_UP_ANSWERS = { ...REPORTS_WORK_ANSWERS, gave_up: 0.9 };

/** How the host revision stands when an author turn ends. */
export type RevisionAtTurnEnd = "changed" | "same" | "unreadable";

/** The author's running turn ends. A paused author's turn ends cancelled, as the pause asked. */
export function authorTurnEnds(
  index: number,
  revision: RevisionAtTurnEnd,
  closing: Closing = "reports_work",
): WorkflowAction {
  const label = `turn ends, revision ${revision}, ${closing}`;
  return authorAction(index, label, async (world, author) => {
    const bridge = world.runningBridgeOf(author.taskId);
    if (!bridge) return undefined;
    if (revision === "changed") world.changeRevision(author);
    const stopReason = world.taskOf(author).paused_at !== null ? "cancelled" : "end_turn";
    world.answerDecisionsWith(closing === "gives_up" ? GAVE_UP_ANSWERS : REPORTS_WORK_ANSWERS);
    if (closing === "gives_up") await bridge.say(GAVE_UP_TEXT);
    if (revision === "unreadable") await world.whileHostIsDown(() => bridge.endTurn(stopReason));
    else await bridge.endTurn(stopReason);
    if (closing === "gives_up" && stopReason === "end_turn") return undefined;
    const hostRevision = revision === "unreadable" ? null : world.hostRevisionOf(author);
    return { authorTurnEnd: { task_id: author.taskId, hostRevision } };
  });
}

const PROMPT_ERROR = "the model provider is down";

/**
 * The harness answers the author's running prompt with an error. Code ends the author turn on
 * it the way a turn end would.
 */
export function authorPromptFails(index: number, revision: "changed" | "same"): WorkflowAction {
  return authorAction(index, `prompt fails, revision ${revision}`, async (world, author) => {
    const bridge = world.runningBridgeOf(author.taskId);
    if (!bridge) return undefined;
    if (revision === "changed") world.changeRevision(author);
    await bridge.failPrompt(PROMPT_ERROR);
    return {
      authorTurnEnd: { task_id: author.taskId, hostRevision: world.hostRevisionOf(author) },
    };
  });
}

/** What a researcher left at the research payload path when its turn ends. */
export type PayloadAtTurnEnd = "written" | "missing" | "oversized";

/** A researcher's running turn ends. A paused researcher's turn ends cancelled, as the pause asked. */
export function researcherTurnEnds(index: number, payload: PayloadAtTurnEnd): WorkflowAction {
  return action(`researcher ${index}: turn ends, payload ${payload}`, async (world) => {
    const researcher = world.researcherAt(index);
    const bridge = researcher ? world.runningBridgeOf(researcher.task_id) : null;
    if (!researcher || !bridge) return;
    if (payload !== "missing") {
      const size = payload === "written" ? 64 : RESEARCH_PAYLOAD_MAX_BYTES + 1;
      const content = JSON.stringify({ summary: "x".repeat(size) });
      world.workflow.sandboxProvider.putFile(researcher.task_id, RESEARCH_PAYLOAD_PATH, content);
    }
    await bridge.endTurn(researcher.paused_at !== null ? "cancelled" : "end_turn");
  });
}

/** The harness answers the running prompt of the author's unfinished refiner run with an error. */
export function refinerRunPromptFails(index: number): WorkflowAction {
  return authorAction(index, "prompt of the refiner run fails", async (world, author) => {
    const run = world.refinerRunOf(author);
    const bridge = run ? await world.bridgeWithRunningTurn(run.task_id) : null;
    await bridge?.failPrompt(PROMPT_ERROR);
  });
}

/** The first artifact appears: the author prints its link, or the host says a pull request opened. */
export function firstArtifactAppears(
  index: number,
  via: "author_text" | "host_event",
): WorkflowAction {
  return authorAction(index, `first artifact appears by ${via}`, async (world, author) => {
    if (world.artifactOf(author) || isTaskFinished(world.taskOf(author).status)) return;
    if (via === "host_event") {
      if (author.kind !== "pull" || world.continuesPull(author)) return;
      world.openPull(author);
      await world.deliver({
        kind: "pr_event",
        text: "",
        pull: { ...world.pullDetailOf(author), action: "opened" },
      });
      return;
    }
    const bridge = world.runningBridgeOf(author.taskId);
    if (!bridge) return;
    if (author.kind === "pull") world.openPull(author);
    await bridge.say(`I opened ${world.artifactUrlOf(author)} for this.`);
  });
}

/** The author's harness reports a three entry todo list with `completed` entries done. */
export function authorReportsTodos(index: number, completed: number): WorkflowAction {
  return authorAction(index, `reports todos, ${completed} done`, async (world, author) => {
    const bridge = world.runningBridgeOf(author.taskId);
    if (!bridge) return;
    await bridge.reportTodos(
      ["Read the code", "Change the redirect", "Open the artifact"].map((content, entry) => ({
        content,
        priority: "medium",
        status: entry < completed ? "completed" : "pending",
      })),
    );
  });
}

/** What a findings reviewer run leaves behind when its turn ends. */
export type ReviewOutcome = "no_review" | "approved" | "findings" | "blocking";

const HOST_REVIEWS: Record<
  Exclude<ReviewOutcome, "no_review">,
  { state: string; body: string; comments: string[] }
> = {
  approved: { state: "APPROVED", body: "Looks right.", comments: [] },
  findings: { state: "COMMENTED", body: "Two things to weigh.", comments: ["Name the owner."] },
  blocking: {
    state: "CHANGES_REQUESTED",
    body: "The redirect is open.",
    comments: ["Validate the target."],
  },
};

const CLOSING_REVIEWS: Record<Exclude<ReviewOutcome, "no_review">, string> = {
  approved: "Review: approved\nReady as it stands.",
  findings: "Review: findings\nTwo things to weigh.\n\n- Scope: the second issue is too wide.",
  blocking: "Review: blocking\nThe issues miss the request.\n\n- Nothing covers the redirect.",
};

/** What code can tell from the conclusion of a judge run. */
export type JudgeOutcome = "approves" | "rejects" | "unclear" | "no_conclusion" | "decisions_fail";

const RULING_ANSWERS: Record<JudgeOutcome, DecisionAnswers> = {
  approves: { for_author: 0, beyond_author: 0, rejects: 0.1 },
  rejects: { for_author: 0, beyond_author: 0, rejects: 0.9 },
  unclear: { for_author: 0, beyond_author: 0, rejects: 0.5 },
  no_conclusion: { for_author: 0, beyond_author: 0, rejects: 0.5 },
  decisions_fail: "fails",
};

/** How the unfinished refiner run ends, whichever kind of run it is. */
export type RefinerRunEnd = {
  reviewer: ReviewOutcome;
  judge: JudgeOutcome;
  polisher: PolishOutcome;
  stopReason: Exclude<StopReason, "cancelled">;
  closing: Closing;
};

/** What a polisher run did to the artifact before its turn ended. */
export type PolishOutcome = "pushed" | "nothing_pushed";

/**
 * The turn of the author's unfinished refiner run ends. A findings reviewer files its review
 * where its artifact kind takes one, a judge closes with its conclusion, and a polisher may
 * have pushed.
 */
export function refinerRunEnds(index: number, end: RefinerRunEnd): WorkflowAction {
  const label = `refiner run ends on ${end.stopReason}, ${end.closing} [reviewer ${end.reviewer} | judge ${end.judge} | polisher ${end.polisher}]`;
  return authorAction(index, label, async (world, author) => {
    const run = world.refinerRunOf(author);
    const bridge = run ? await world.bridgeWithRunningTurn(run.task_id) : null;
    if (!run || !bridge) return undefined;
    const mode = world.reviewerEntryOf(run)?.mode ?? "polisher";
    if (mode === "findings") await fileFindingsReview(world, author, bridge, end.reviewer);
    if (mode === "judge") await closeJudgeTurn(world, bridge, end.judge);
    if (mode === "polisher" && end.polisher === "pushed") world.changeRevision(author);
    if (end.closing === "gives_up") {
      world.answerDecisionsWith(GAVE_UP_ANSWERS);
      await bridge.say(GAVE_UP_TEXT);
    }
    await bridge.endTurn(end.stopReason);
    const finished = end.stopReason === "end_turn" && end.closing === "reports_work";
    return finished ? { refinerTurnEnd: { task_id: run.task_id } } : undefined;
  });
}

async function fileFindingsReview(
  world: WorkflowWorld,
  author: WorldAuthor,
  bridge: FakeBridge,
  outcome: ReviewOutcome,
): Promise<void> {
  if (outcome === "no_review") return;
  if (author.kind === "pull") world.fileReview(author, HOST_REVIEWS[outcome]);
  else await bridge.say(CLOSING_REVIEWS[outcome]);
}

async function closeJudgeTurn(
  world: WorkflowWorld,
  bridge: FakeBridge,
  outcome: JudgeOutcome,
): Promise<void> {
  world.answerDecisionsWith(RULING_ANSWERS[outcome]);
  if (outcome !== "no_conclusion") await bridge.say(JUDGE_CONCLUSION);
}

/** The author's unfinished refiner run dies, the way a dead sandbox fails it. */
export function refinerRunFails(index: number): WorkflowAction {
  return authorAction(index, "refiner run fails", async (world, author) => {
    const run = world.refinerRunOf(author);
    if (run) await failTask(world.workflow, run, "the sandbox died");
  });
}

/** Where the decisions model says a person's feedback goes. */
export type FeedbackRouting = "for_author" | "beyond_author" | "asks_nothing" | "unsure" | "fails";

const ROUTING_ANSWERS: Record<FeedbackRouting, DecisionAnswers> = {
  for_author: { for_author: 0.95, beyond_author: 0.05, rejects: 0 },
  beyond_author: { for_author: 0.9, beyond_author: 0.6, rejects: 0 },
  asks_nothing: { for_author: 0.05, beyond_author: 0.05, rejects: 0 },
  unsure: { for_author: 0.5, beyond_author: 0.05, rejects: 0 },
  fails: "fails",
};

const FEEDBACK_TEXT = "Why does the redirect skip the check?";

type PullOfEvent = { repo: string; number: number; branch?: string };

/** How a person leaves feedback on a pull request: a whole review, one inline comment, or a comment. */
export type FeedbackForm = "review" | "review_comment" | "comment";

const INLINE_COMMENT = { id: 7, path: "src/login.ts", line: 12, body: "Rename this." };

function feedbackDetail(form: FeedbackForm, pull: PullOfEvent) {
  switch (form) {
    case "review":
      return { ...pull, action: "review" as const, comments: [INLINE_COMMENT] };
    case "review_comment":
      return {
        ...pull,
        action: "review_comment" as const,
        review_id: 500,
        comments: [INLINE_COMMENT],
      };
    case "comment":
      return { ...pull, action: "comment" as const, comment_id: 42 };
    default: {
      const unreachable: never = form;
      throw new Error(`unhandled feedback form ${String(unreachable)}`);
    }
  }
}

/**
 * A person posts a review or a comment on the author's pull request. The pull request may be one
 * the author opened and has not reported, so the task has no artifact yet.
 */
export function personPostsFeedback(
  index: number,
  form: FeedbackForm,
  routing: FeedbackRouting,
): WorkflowAction {
  const label = `a person posts a ${form}, decisions say ${routing}`;
  return authorAction(index, label, async (world, author) => {
    if (author.kind !== "pull") return undefined;
    if (!world.artifactOf(author)) world.openPull(author);
    world.answerDecisionsWith(ROUTING_ANSWERS[routing]);
    const pull = feedbackDetail(form, world.pullDetailOf(author));
    await world.deliver({ kind: "feedback", text: FEEDBACK_TEXT, pull });
    return { feedback: { task_id: author.taskId } };
  });
}

/**
 * A person posts on a pull request of the repository that no task of the workflow opened. It is
 * no artifact of the workflow, so the step carries no feedback fact.
 */
export function personPostsOnUnownedPull(form: FeedbackForm): WorkflowAction {
  return action(`a person posts a ${form} on a pull request no task owns`, (world) =>
    world.deliver({
      kind: "feedback",
      text: FEEDBACK_TEXT,
      pull: feedbackDetail(form, UNOWNED_PULL),
    }),
  );
}

/** What the host says happened to the pull request. */
export type HostWord = "merged" | "closed_unmerged" | "marked_ready" | "reopened";

/**
 * The host accepts the artifact, closes it without accepting it, reopens a closed one, or a
 * human marks it ready there.
 */
export function hostSays(index: number, word: HostWord): WorkflowAction {
  return authorAction(index, `host says ${word}`, async (world, author) => {
    if (!world.artifactOf(author) || author.kind !== "pull") return;
    const detail = world.pullDetailOf(author);
    switch (word) {
      case "marked_ready":
        return world.deliver({
          kind: "pr_event",
          text: "",
          pull: { ...detail, action: "ready_for_review" },
        });
      case "reopened":
        if (!world.pullIs(author, "closed")) return;
        world.movePull(author, "open");
        return world.deliver({
          kind: "pr_event",
          text: "",
          pull: { ...detail, action: "reopened" },
        });
      case "merged":
      case "closed_unmerged": {
        if (!world.pullIs(author, "open")) return;
        const merged = word === "merged";
        world.movePull(author, merged ? "merged" : "closed");
        return world.deliver({
          kind: "pr_event",
          text: "",
          pull: { ...detail, action: "closed", merged },
        });
      }
      default: {
        const unreachable: never = word;
        throw new Error(`unhandled host word ${String(unreachable)}`);
      }
    }
  });
}

/** Whether the host's webhook for a change reaches the workflow. */
export type Webhook = "delivered" | "missed";

const CHECK_CONCLUSIONS: Partial<Record<ChecksReport, string>> = {
  failed: "failure",
  stopped: "cancelled",
  passed_just_now: "success",
  passed_long_ago: "success",
};

/**
 * The checks report on the head of the author's open pull request. A finished check suite sends
 * a CI event unless the webhook is missed. Running and unreported checks send none.
 */
export function checksReport(
  index: number,
  report: ChecksReport,
  webhook: Webhook,
): WorkflowAction {
  return authorAction(index, `checks say ${report}, webhook ${webhook}`, async (world, author) => {
    if (!world.pullIs(author, "open")) return;
    world.reportChecks(author, report);
    const conclusion = CHECK_CONCLUSIONS[report];
    if (webhook === "missed" || !conclusion) return;
    await world.deliver({
      kind: "ci_event",
      text: "",
      actor: null,
      pull: {
        ...world.pullDetailOf(author),
        action: "completed",
        conclusion,
        check_names: ["test"],
      },
    });
  });
}

/**
 * A push lands on the base branch, and the host works out again whether the author's open pull
 * request merges. The push event names no pull request, so it reaches every open artifact.
 */
export function baseMoves(
  index: number,
  mergeability: Mergeability,
  webhook: Webhook,
): WorkflowAction {
  const label = `base moves, the pull request is ${mergeability}, webhook ${webhook}`;
  return authorAction(index, label, async (world, author) => {
    if (world.pullIs(author, "open")) world.setMergeability(author, mergeability);
    if (webhook === "missed") return;
    await world.deliver({
      kind: "pr_event",
      text: "",
      actor: null,
      pull: { action: "base_moved", repo: REPO, base: "main" },
    });
  });
}

/** Time passes with nothing else happening. Only timers and host reads notice it. */
export function timePasses(minutes: number): WorkflowAction {
  return action(`${minutes} minutes pass`, async (world) => {
    world.advanceClock(minutes * 60_000);
  });
}

/**
 * A person sends a control word from the author's tracker issue, or from the chat thread for
 * a task without one. A cancel from the chat thread cancels the whole workflow.
 */
export function personSendsControl(
  index: number,
  control: "pause" | "resume" | "cancel" | "instruct",
): WorkflowAction {
  const text = control === "instruct" ? "Use the session cookie." : "";
  return authorAction(index, `a person says ${control}`, (world, author) =>
    world.deliver({ kind: "control", control, text, bindings: world.issueBindingsOf(author) }),
  );
}

/** What a person writes in the chat thread: a question, or a control word as the whole text. */
export type ChatText = "question" | "control_word";

/**
 * A person writes in the chat thread: a message, a new start from a surface, or a status request.
 * An agent turn may be running as it arrives. A message wakes a sleeping workflow and restarts the
 * idle clock.
 */
export function personWrites(
  kind: "prompt" | "start" | "status",
  text: ChatText,
  agent: AgentAtMessage,
): WorkflowAction {
  const words = text === "question" ? "Where does this stand?" : "pause";
  return action(`a person sends a ${kind} "${words}" while the agent is ${agent}`, (world) =>
    world.writeInChat({ kind, text: words }, agent),
  );
}

/** Which issue a started task names: one of its own, one another author already names, or none. */
export type StartedOn = "an_issue" | "a_taken_issue" | "no_issue";

/**
 * The agent tries to start one more author task, in a turn a person woke with `request`. The
 * system may refuse it.
 */
export function agentStartsTask(
  kind: ArtifactKind,
  on: StartedOn,
  request: string,
): WorkflowAction {
  return action(`agent starts a ${kind} task on ${on}, asked "${request}"`, async (world) => {
    if (world.authors.length >= MAX_AUTHORS) return;
    const { start_job } = startTools(world.workflow, [request]);
    await start_job.execute(
      { stage: STAGE_OF[kind], brief: "Fix the next part.", issue: issueToName(world, on) },
      TOOL_CALL,
    );
  });
}

function issueToName(world: WorkflowWorld, on: StartedOn): string | undefined {
  if (on === "no_issue") return undefined;
  const fresh = `ENG-10${world.authors.length}`;
  if (on === "an_issue") return fresh;
  const taken = world.authors.map((author) => world.jobOf(author).issue_key).find(Boolean);
  return taken ?? fresh;
}

/** Whose artifact the agent names: an author whose job is over, or any author. */
export type ArtifactOwner = "a_finished_author" | "any_author";

/**
 * The agent starts a job on the artifact of an author. A stage that produces pull requests
 * continues a pull request it is given. Any other stage works from the artifact. The system may
 * refuse it.
 */
export function agentStartsTaskOnArtifact(
  kind: ArtifactKind,
  owner: ArtifactOwner,
  index: number,
): WorkflowAction {
  const label = `agent starts a ${kind} task on the artifact of ${owner} ${index}`;
  return action(label, async (world) => {
    const author =
      owner === "a_finished_author" ? world.finishedAuthorAt(index) : world.authorAt(index);
    if (!author || world.authors.length >= MAX_AUTHORS) return;
    const { start_job } = startTools(world.workflow, ["Pick up where that one stopped."]);
    await start_job.execute(
      { stage: STAGE_OF[kind], brief: "Continue the work.", artifact: world.artifactUrlOf(author) },
      TOOL_CALL,
    );
  });
}

/** The agent sets the plan: its stages and how many jobs may run at once. */
export function agentSetsPlan(stages: string[], concurrency: number): WorkflowAction {
  const label = `agent sets the plan ${stages.join(" -> ")} with ${concurrency} slots`;
  return action(label, async (world) => {
    const { set_plan } = planTools(world.workflow);
    await set_plan.execute(
      {
        name: "Fix login",
        stages,
        repo: REPO,
        page_parent: null,
        reason: "the request changed",
        concurrency,
      },
      TOOL_CALL,
    );
  });
}

/** The agent tries to finish the workflow. It is refused while a job runs. */
export function agentFinishesWorkflow(): WorkflowAction {
  return action("agent finishes the workflow", async (world) => {
    const { finish_workflow } = planTools(world.workflow);
    await finish_workflow.execute({ result: "The login redirect is fixed." }, TOOL_CALL);
  });
}

/** The agent stops the workflow as failed. */
export function agentFailsWorkflow(): WorkflowAction {
  return action("agent fails the workflow", async (world) => {
    const { fail_workflow } = planTools(world.workflow);
    await fail_workflow.execute({ reason: "The repository cannot be built." }, TOOL_CALL);
  });
}

/** The agent pauses the author after its current turn, or resumes it. */
export function agentHoldsAuthor(
  index: number,
  call: "pause_task" | "resume_task",
): WorkflowAction {
  return authorAction(index, `agent calls ${call}`, async (world, author) => {
    await taskTools(world.workflow)[call].execute({ task_id: author.taskId }, TOOL_CALL);
  });
}

/** The agent sends the author a prompt of its own. */
export function agentPromptsAuthor(index: number): WorkflowAction {
  return authorAction(index, "agent prompts the author", async (world, author) => {
    const { prompt_task } = taskTools(world.workflow);
    await prompt_task.execute({ task_id: author.taskId, text: "Add a test for it." }, TOOL_CALL);
  });
}

/** The agent cancels the author task or its unfinished refiner run. */
export function agentCancels(index: number, target: "author" | "refiner_run"): WorkflowAction {
  return authorAction(index, `agent cancels the ${target}`, async (world, author) => {
    if (target === "author") {
      const { cancel_job } = startTools(world.workflow);
      await cancel_job.execute(
        { job_id: world.jobOf(author).job_id, reason: "a person asked" },
        TOOL_CALL,
      );
      return;
    }
    const run = world.refinerRunOf(author);
    if (!run) return;
    const { cancel_task } = taskTools(world.workflow);
    await cancel_task.execute({ task_id: run.task_id, reason: "a person asked" }, TOOL_CALL);
  });
}

/** What the person wrote in the turn in which the agent completes a task. */
export type PersonAtCompletion = "accepts" | "asks_for_a_change" | "wrote_nothing";

const PERSON_MESSAGES: Record<PersonAtCompletion, string[]> = {
  accepts: ["Looks good, ship it."],
  asks_for_a_change: ["Split the second issue."],
  wrote_nothing: [],
};

/** The agent completes the author task, in whatever state it is. */
export function agentCompletes(index: number, person: PersonAtCompletion): WorkflowAction {
  const label = `agent completes the task, the person ${person}`;
  return authorAction(index, label, async (world, author) => {
    const accepts = person === "accepts" ? 0.9 : 0.1;
    world.answerDecisionsWith({ for_author: 0, beyond_author: 0, rejects: 0, accepts });
    const { complete_job } = startTools(world.workflow, PERSON_MESSAGES[person]);
    await complete_job.execute({ job_id: world.jobOf(author).job_id, result: "Done." }, TOOL_CALL);
  });
}

/**
 * A person accepted an artifact, and the agent starts the next stage with no issue. Once a job is
 * complete with its artifact accepted, the next job builds on that artifact.
 */
export function agentAdvancesStage(next: ArtifactKind): WorkflowAction {
  return action(`agent starts a ${next} task for the next stage`, async (world) => {
    if (world.authors.length >= MAX_AUTHORS) return;
    const { start_job } = startTools(world.workflow, PERSON_MESSAGES.accepts);
    await start_job.execute(
      { stage: STAGE_OF[next], brief: "Build on the accepted artifact." },
      TOOL_CALL,
    );
  });
}

/** The agent routes the artifact after a reviewer segment left findings. */
export function agentRoutes(
  index: number,
  call: "request_review" | "finish_review",
): WorkflowAction {
  return authorAction(index, `agent calls ${call}`, async (world, author) => {
    await artifactTools(world.workflow)[call].execute(
      { job_id: world.jobOf(author).job_id },
      TOOL_CALL,
    );
  });
}

/** The agent records the ruling a person gave on a judge entry. */
export function personRules(index: number, ruling: "approve" | "reject"): WorkflowAction {
  return authorAction(index, `a person rules ${ruling}`, async (world, author) => {
    const { rule_on_review } = artifactTools(world.workflow);
    await rule_on_review.execute(
      { job_id: world.jobOf(author).job_id, ruling, reason: "The approach is wrong." },
      TOOL_CALL,
    );
  });
}

/**
 * The sandbox of a task that waits for one comes up. Its bridge dials in and the first prompt is
 * sent, or it stays silent and only the hello timeout can tell.
 */
export function sandboxComesUp(bridge: "dials_in" | "stays_silent"): WorkflowAction {
  return action(`sandbox comes up, bridge ${bridge}`, async (world) => {
    const waiting = world.tasksAwaitingSandbox()[0];
    if (!waiting) return;
    if (bridge === "dials_in") await world.startSandboxOf(waiting.task_id);
    else await world.provisionSandboxOf(waiting.task_id);
  });
}

/**
 * The sandbox of the author, or of its refiner run, goes away. The bridge socket closes, and only
 * the bridge loss timer or the next prompt brings a sandbox back.
 */
export function sandboxGoesAway(index: number, target: "author" | "refiner_run"): WorkflowAction {
  return authorAction(index, `sandbox of the ${target} goes away`, async (world, author) => {
    const taskId = target === "author" ? author.taskId : world.refinerRunOf(author)?.task_id;
    if (taskId) world.openBridgeOf(taskId)?.drop();
  });
}

/** The timers a workflow arms that need no agent turn. */
export const TIMERS = [
  "board_flush",
  "wall_clock",
  "hello_timeout",
  "no_progress",
  "keep_alive",
  "bridge_lost",
  "queue_retry",
  "idle",
  "recheck",
] as const;

export type Timer = (typeof TIMERS)[number];

const TIMER_ALARMS: Record<
  Timer,
  { method: ScheduledMethod; fire: (workflow: WorkflowRuntime, payload: unknown) => Promise<void> }
> = {
  board_flush: {
    method: "flushBoard",
    fire: (workflow, payload) => onFlushBoard(workflow, payload as BoardAlarm),
  },
  wall_clock: {
    method: "onWallClock",
    fire: (workflow, payload) => onWallClock(workflow, payload as TaskAlarm),
  },
  hello_timeout: {
    method: "onHelloTimeout",
    fire: (workflow, payload) => onHelloTimeout(workflow, payload as GenerationAlarm),
  },
  no_progress: {
    method: "onNoProgress",
    fire: (workflow, payload) => onNoProgress(workflow, payload as GenerationAlarm),
  },
  keep_alive: {
    method: "keepSandboxAlive",
    fire: (workflow, payload) => keepSandboxAlive(workflow, payload as GenerationAlarm),
  },
  bridge_lost: {
    method: "onBridgeLost",
    fire: (workflow, payload) => onBridgeLost(workflow, payload as GenerationAlarm),
  },
  queue_retry: {
    method: "retryQueue",
    fire: (workflow, payload) => retryQueue(workflow, payload as GenerationAlarm),
  },
  idle: { method: "onIdle", fire: (workflow) => onIdle(workflow) },
  recheck: {
    method: "recheckChecks",
    fire: (workflow, payload) => recheckChecks(workflow, payload as ChecksAlarm),
  },
};

function staleAlarmOf(world: WorkflowWorld, payload: unknown): { task_id: string } | null {
  if (typeof payload !== "object" || payload === null || !("generation" in payload)) return null;
  const { task_id, generation } = payload as GenerationAlarm;
  const sandbox = world.workflow.store.sandbox(task_id);
  return sandbox && generation < sandbox.generation ? { task_id } : null;
}

/**
 * One armed alarm of a timer fires. `pick` counts round the alarms of that timer. A repeating
 * alarm stays armed.
 */
export function timerFires(timer: Timer, pick: number): WorkflowAction {
  return action(`${timer} timer ${pick} fires`, async (world) => {
    const { method, fire } = TIMER_ALARMS[timer];
    const armed = world.workflow.alarmsFor(method);
    const alarm = armed[pick % armed.length];
    if (!alarm) return undefined;
    const stale = staleAlarmOf(world, alarm.payload);
    if (!alarm.repeats) await world.workflow.cancelAlarm(alarm.id);
    await fire(world.workflow, alarm.payload);
    return { staleAlarm: stale };
  });
}

/** The timers whose alarms are about one generation. */
export const GENERATION_TIMERS = [
  "hello_timeout",
  "no_progress",
  "keep_alive",
  "bridge_lost",
  "queue_retry",
] as const satisfies readonly Timer[];

/** An alarm armed for the generation before the task's current one fires, as after a lost cancel. */
export function staleAlarmFires(
  timer: (typeof GENERATION_TIMERS)[number],
  pick: number,
): WorkflowAction {
  return action(`stale ${timer} alarm ${pick} fires`, async (world) => {
    const { store } = world.workflow;
    const sandboxes = store
      .tasks()
      .map((task) => store.requireSandbox(task.task_id))
      .filter((sandbox) => sandbox.generation > 0);
    const sandbox = sandboxes[pick % sandboxes.length];
    if (!sandbox) return undefined;
    const alarm: GenerationAlarm = { task_id: sandbox.task_id, generation: sandbox.generation - 1 };
    await TIMER_ALARMS[timer].fire(world.workflow, alarm);
    return { staleAlarm: { task_id: sandbox.task_id } };
  });
}
