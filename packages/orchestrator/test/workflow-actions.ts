import type { StopReason } from "@agentclientprotocol/sdk";
import type { DocumentsCommenting } from "@artfct-ai/adapters/test/fake-documents";
import { artifactTools } from "../src/agent/tools/artifact";
import { activeToolNames, type TurnFacts } from "../src/agent/prompt/system-prompt";
import { FAIL_WORKFLOW, FINISH_WORKFLOW, planTools } from "../src/agent/tools/plan";
import { startTools } from "../src/agent/tools/start/start";
import { taskTools } from "../src/agent/tools/task";
import { workflowTools } from "../src/agent/tools/toolset";
import { onFlushBoard, type BoardAlarm } from "../src/workflow/board/board";
import type { ChecksAlarm } from "../src/workflow/refiner/checks-gate";
import { recheckChecks } from "../src/workflow/refiner/checks-recheck";
import { failTask, onIdle, restartOrFailTask } from "../src/workflow/lifecycle";
import { isTaskFinished } from "../src/workflow/store/state";
import type { AuthorTurnOutcome } from "../src/workflow/task/author-turn";
import { onBridgeLost } from "../src/workflow/task/harness/bridge";
import { sendHeldCommentsOnRevisionRequest } from "../src/workflow/refiner/held-comments";
import { settleLostJudgeRuling } from "../src/workflow/refiner/loop";
import { retryQueue } from "../src/workflow/task/harness/prompt-queue";
import { settleIdleAuthor } from "../src/workflow/task/harness/turn";
import { onModelTurnDeadline, type ModelTurnAlarm } from "../src/workflow/task/model-turn";
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
import { toolText } from "./tool-result";
import { fakeDocumentsOf, JUDGE_CONCLUSION } from "./fake-runtime";
import { strayIssueKey, subIssueKey, SUBJECT_ISSUE_KEY } from "./world-tracker";
import {
  MAX_AUTHORS,
  PAGE_OPTION,
  REPO,
  REQUEST_TEXTS,
  STAGE_OF,
  type ArtifactKind,
  type ChecksReport,
  type DecisionAnswers,
  type Mergeability,
  stopEvent,
  type StepFacts,
  type TrackerLink,
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

/** What the turn text of a refiner run says. */
type Closing = "reports_work" | "gives_up";

const GAVE_UP_TEXT = "I could not check out the branch, so I did not do the work.";
const REPORTS_WORK_ANSWERS = { for_author: 0, beyond_author: 0, rejects: 0 };
const GAVE_UP_ANSWERS = { ...REPORTS_WORK_ANSWERS, gave_up: 0.9 };

/** How the host revision stands when an author turn ends. */
export type RevisionAtTurnEnd = "changed" | "same" | "unreadable";

/**
 * How the decisions model says an author left its work, how the model is down, or that the
 * author ended its turn without a word, so the model is not asked.
 */
export type AuthorClosing = AuthorTurnOutcome | "decisions_fail" | "decisions_hang" | "silent";

const AUTHOR_CLOSING_TEXTS: Record<AuthorClosing, string> = {
  finished: "I changed the redirect and pushed the branch.",
  waits_on_person: "Which page should the redirect go to? I will wait for your answer.",
  blocked: GAVE_UP_TEXT,
  stopped_early:
    "The test suite runs in the background. I will report the result when it finishes.",
  decisions_fail: "The test suite runs in the background.",
  decisions_hang: "The build runs in the background.",
  silent: "",
};

/** What lands while the decisions model judges how the author left its work. */
export type WhileJudged = "nothing" | "agent_prompts" | "agent_cancels";

function whileJudged(index: number, meanwhile: WhileJudged): WorkflowAction | null {
  switch (meanwhile) {
    case "nothing":
      return null;
    case "agent_prompts":
      return agentPromptsAuthor(index);
    case "agent_cancels":
      return agentCancels(index, "author");
    default: {
      const unreachable: never = meanwhile;
      throw new Error(`unhandled meanwhile ${String(unreachable)}`);
    }
  }
}

function authorClosingAnswers(closing: AuthorClosing): DecisionAnswers {
  if (closing === "decisions_fail") return "fails";
  if (closing === "decisions_hang") return "hangs";
  if (closing === "silent") return REPORTS_WORK_ANSWERS;
  return { ...REPORTS_WORK_ANSWERS, outcome: { option: closing, probability: 0.9 } };
}

/**
 * The author's running turn ends with its closing text. A paused author's turn, or one the
 * workflow sent a cancel, ends cancelled, as the harness would. `meanwhile` lands while the
 * decisions model judges the turn.
 */
export function authorTurnEnds(
  index: number,
  revision: RevisionAtTurnEnd,
  closing: AuthorClosing = "finished",
  meanwhile: WhileJudged = "nothing",
): WorkflowAction {
  const label = `turn ends, revision ${revision}, ${closing}, meanwhile ${meanwhile}`;
  return authorAction(index, label, async (world, author) => {
    const bridge = world.runningBridgeOf(author.taskId);
    if (!bridge) return;
    if (revision === "changed") world.changeRevision(author);
    const cancelled = world.taskOf(author).paused_at !== null || bridge.cancelRequested;
    const stopReason = cancelled ? "cancelled" : "end_turn";
    const landing = whileJudged(index, meanwhile);
    world.answerDecisionsWith(authorClosingAnswers(closing), landing ?? undefined);
    const closingText = AUTHOR_CLOSING_TEXTS[closing];
    if (closingText) await bridge.say(closingText);
    if (revision === "unreadable") await world.whileHostIsDown(() => bridge.endTurn(stopReason));
    else await bridge.endTurn(stopReason);
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
    if (!bridge) return;
    if (revision === "changed") world.changeRevision(author);
    await bridge.failPrompt(PROMPT_ERROR);
  });
}

/** The harness ends the author's running turn as cancelled. Code settles it without a decisions read. */
export function authorTurnIsCancelled(index: number, revision: "changed" | "same"): WorkflowAction {
  return authorAction(index, `turn is cancelled, revision ${revision}`, async (world, author) => {
    const bridge = world.runningBridgeOf(author.taskId);
    if (!bridge) return;
    if (revision === "changed") world.changeRevision(author);
    await bridge.endTurn("cancelled");
  });
}

/** The author dies, the way a dead sandbox fails it. */
export function authorFails(index: number): WorkflowAction {
  return authorAction(index, "fails", async (world, author) => {
    await failTask(world.workflow, world.taskOf(author), "the sandbox died");
  });
}

/** The author hits a failure it may recover from, so it restarts or fails. */
export function authorHitsARecoverableFailure(index: number): WorkflowAction {
  return authorAction(index, "hits a recoverable failure", async (world, author) => {
    await restartOrFailTask(world.workflow, world.taskOf(author), "The sandbox start failed.");
  });
}

/** What a researcher left at the research payload path when its turn ends. */
export type PayloadAtTurnEnd = "written" | "missing" | "oversized";

/** How a researcher's turn ends unfinished: its closing text says it gave up, or the harness stops it on max tokens. */
export type ResearcherUnfinishedEnding = "gave_up" | "max_tokens";

/**
 * A running researcher writes its payload and ends its turn unfinished. The decisions model reads
 * later turns as reporting work.
 */
export function researcherTurnEndsUnfinished(
  index: number,
  ending: ResearcherUnfinishedEnding,
): WorkflowAction {
  return action(`researcher ${index}: turn ends unfinished, ${ending}`, async (world) => {
    const researcher = world.researcherAt(index);
    const bridge = researcher ? world.runningBridgeOf(researcher.task_id) : null;
    if (!researcher || !bridge) return;
    const content = JSON.stringify({ summary: "The redirect check lives in the session guard." });
    world.workflow.sandboxProvider.putFile(researcher.task_id, RESEARCH_PAYLOAD_PATH, content);
    if (ending === "max_tokens") {
      await bridge.endTurn("max_tokens");
      return;
    }
    world.answerDecisionsWith(GAVE_UP_ANSWERS);
    await bridge.say(GAVE_UP_TEXT);
    await bridge.endTurn("end_turn");
    world.answerDecisionsWith(REPORTS_WORK_ANSWERS);
  });
}

/** A running researcher reports its todo list, with the first `completed` entries done. */
export function researcherReportsTodos(index: number, completed: number): WorkflowAction {
  return action(`researcher ${index}: reports todos, ${completed} done`, async (world) => {
    const researcher = world.researcherAt(index);
    const bridge = researcher ? world.runningBridgeOf(researcher.task_id) : null;
    if (!bridge) return;
    await bridge.reportTodos(
      ["Read the request", "Map the login module", "Write the payload"].map((content, entry) => ({
        content,
        priority: "medium",
        status: entry < completed ? "completed" : "pending",
      })),
    );
  });
}

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

/** The harness of the author's unfinished refiner run exits while its turn runs. */
export function refinerRunHarnessExits(index: number): WorkflowAction {
  return authorAction(index, "harness of the refiner run exits", async (world, author) => {
    const run = world.refinerRunOf(author);
    const bridge = run ? await world.bridgeWithRunningTurn(run.task_id) : null;
    await bridge?.exit(1);
  });
}

/**
 * The author's unfinished refiner run stalls: the nudge cancels its running turn and goes out in
 * the same session, and the run stalls again before it shows progress.
 */
export function refinerRunStallsAfterItsNudge(index: number): WorkflowAction {
  return authorAction(index, "refiner run stalls after its nudge", async (world, author) => {
    const run = world.refinerRunOf(author);
    const bridge = run ? await world.bridgeWithRunningTurn(run.task_id) : null;
    if (!run || !bridge) return;
    await noProgressFiresFor(world, run.task_id);
    if (bridge.cancelRequested) await bridge.endTurn("cancelled");
    await noProgressFiresFor(world, run.task_id);
  });
}

/** The no-progress alarm of the current sandbox generation of a task fires. */
async function noProgressFiresFor(world: WorkflowWorld, taskId: string): Promise<void> {
  const { workflow } = world;
  const { generation } = workflow.store.requireSandbox(taskId);
  const alarm = workflow.alarmsFor("onNoProgress").find((armed) => {
    const payload = armed.payload as GenerationAlarm;
    return payload.task_id === taskId && payload.generation === generation;
  });
  if (!alarm) throw new Error(`${taskId} has no no-progress alarm armed`);
  await workflow.cancelAlarm(alarm.id);
  await onNoProgress(workflow, alarm.payload as GenerationAlarm);
}

/** The first artifact appears: the author prints its link, or the host says a pull request opened. */
export function firstArtifactAppears(
  index: number,
  via: "author_text" | "host_event",
  issuesOutput: TrackerLink = "the_subject_issue",
): WorkflowAction {
  const label = `first artifact appears by ${via}, issues output ${issuesOutput}`;
  return authorAction(index, label, async (world, author) => {
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
    const url =
      author.kind === "issues"
        ? world.trackerLinkUrl(issuesOutput, author.pullNumber)
        : world.artifactUrlOf(author);
    await bridge.say(`I opened ${url} for this.`);
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

export type Streamed = "message" | "tool" | "failed_tool";

export function authorStreams(index: number, streamed: Streamed): WorkflowAction {
  return authorAction(index, `streams a ${streamed}`, async (world, author) => {
    const bridge = world.runningBridgeOf(author.taskId);
    if (!bridge) return;
    const text = world.nextStreamedText();
    switch (streamed) {
      case "message":
        return bridge.say(`Noted ${text}.`);
      case "tool":
        await bridge.callTool(`call-${text}`, `file-${text}.ts`, "edit");
        return bridge.endTool(`call-${text}`, "completed");
      case "failed_tool":
        await bridge.callTool(`call-${text}`, `bun test ${text}`, "execute");
        return bridge.endTool(`call-${text}`, "failed");
      default: {
        const unreachable: never = streamed;
        throw new Error(`unhandled stream ${String(unreachable)}`);
      }
    }
  });
}

/** What a findings reviewer run leaves behind when its turn ends. */
type ReviewOutcome = "no_review" | "approved" | "findings" | "blocking";

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

/** Page reviews whose findings quote a passage the page holds, one it does not, and none. */
const PAGE_CLOSING_REVIEWS: Record<Exclude<ReviewOutcome, "no_review">, string> = {
  approved: "Review: approved\nReady as it stands.",
  findings: [
    "Read the page.",
    "",
    "Review: findings",
    "Two things to weigh.",
    "",
    '- "Keep one table": Options: one table mixes two lifetimes.',
    '- "Merge the session rows": Options: the page never says this.',
    "- Scope: the page names no metric.",
  ].join("\n"),
  blocking: [
    "Review: blocking",
    "The options miss the request.",
    "",
    `- "${PAGE_OPTION}": Options: the split loses the join.`,
    "- Nothing covers the redirect.",
  ].join("\n"),
};

/** What code can tell from the conclusion of a judge run. */
type JudgeOutcome = "approves" | "rejects" | "unclear" | "no_conclusion" | "decisions_fail";

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
  /**
   * How the document host takes the comments a page review or a judge rejection posts, also
   * those of a ruling a person gives meanwhile.
   */
  pageCommenting: DocumentsCommenting;
  judge: JudgeOutcome;
  /** What a person rules through the agent while the decisions model rules on the judge. */
  whileRuled: WhileRuled;
  polisher: PolishOutcome;
  stopReason: Exclude<StopReason, "cancelled">;
  closing: Closing;
};

/** What a person rules while the decisions model rules on a judge conclusion. */
type WhileRuled = "nothing" | "approve" | "reject";

/** What a polisher run did to the artifact before its turn ended. */
type PolishOutcome = "pushed" | "nothing_pushed";

/**
 * The turn of the author's unfinished refiner run ends. A findings reviewer files its review
 * where its artifact kind takes one, a judge closes with its conclusion, and a polisher may
 * have pushed.
 */
export function refinerRunEnds(index: number, end: RefinerRunEnd): WorkflowAction {
  const label = `refiner run ends on ${end.stopReason}, ${end.closing} [reviewer ${end.reviewer} on a host that ${end.pageCommenting} | judge ${end.judge}, person rules ${end.whileRuled} meanwhile | polisher ${end.polisher}]`;
  return authorAction(index, label, (world, author) =>
    endRefinerRunTurn(world, author, end, index),
  );
}

/**
 * The turn of the unfinished refiner run of `author` ends. A person's ruling meanwhile goes
 * through the author at `index`.
 */
export async function endRefinerRunTurn(
  world: WorkflowWorld,
  author: WorldAuthor,
  end: RefinerRunEnd,
  index: number,
): Promise<void> {
  const run = world.refinerRunOf(author);
  const bridge = run ? await world.bridgeWithRunningTurn(run.task_id) : null;
  if (!run || !bridge) return;
  const mode = world.reviewerEntryOf(run)?.mode ?? "polisher";
  const refinesPage = author.kind === "page" && (mode === "findings" || mode === "judge");
  if (refinesPage) world.pageHost.commenting = end.pageCommenting;
  if (mode === "findings") await fileFindingsReview(world, author, bridge, end.reviewer);
  if (mode === "judge") await closeJudgeTurn(world, bridge, end, index);
  if (mode === "polisher" && end.polisher === "pushed") world.changeRevision(author);
  if (end.closing === "gives_up") {
    world.answerDecisionsWith(GAVE_UP_ANSWERS);
    await bridge.say(GAVE_UP_TEXT);
  }
  await bridge.endTurn(end.stopReason);
  world.pageHost.commenting = "takes";
}

async function fileFindingsReview(
  world: WorkflowWorld,
  author: WorldAuthor,
  bridge: FakeBridge,
  outcome: ReviewOutcome,
): Promise<void> {
  if (outcome === "no_review") return;
  if (author.kind === "pull") world.fileReview(author, HOST_REVIEWS[outcome]);
  else if (author.kind === "page") {
    await bridge.say(numberedFindings(PAGE_CLOSING_REVIEWS[outcome], world.nextReviewNumber()));
  } else await bridge.say(CLOSING_REVIEWS[outcome]);
}

/** A review text whose finding lines name the review they came from, so each review reads apart. */
function numberedFindings(review: string, reviewNumber: number): string {
  return review
    .split("\n")
    .map((line) => (line.startsWith("- ") ? `${line} (review ${reviewNumber})` : line))
    .join("\n");
}

async function closeJudgeTurn(
  world: WorkflowWorld,
  bridge: FakeBridge,
  end: RefinerRunEnd,
  index: number,
): Promise<void> {
  const { judge, whileRuled } = end;
  const asksTheModel = judge !== "no_conclusion" && whileRuled !== "nothing";
  const landing = asksTheModel ? personRules(index, whileRuled, end.pageCommenting) : null;
  world.answerDecisionsWith(RULING_ANSWERS[judge], landing ?? undefined, "rejects");
  if (judge !== "no_conclusion") await bridge.say(JUDGE_CONCLUSION);
}

/** The author's unfinished refiner run dies, the way a dead sandbox fails it. */
export function refinerRunFails(index: number): WorkflowAction {
  return authorAction(index, "refiner run fails", async (world, author) => {
    const run = world.refinerRunOf(author);
    if (run) await failTask(world.workflow, run, "the sandbox died");
  });
}

/** Where the decisions model says a person's feedback goes, or why it cannot say. */
type FeedbackRouting = "for_author" | "beyond_author" | "asks_nothing" | "unsure" | "fails";

const ROUTING_ANSWERS: Record<FeedbackRouting, DecisionAnswers> = {
  for_author: { for_author: 0.95, beyond_author: 0.05, rejects: 0 },
  beyond_author: { for_author: 0.9, beyond_author: 0.6, rejects: 0 },
  asks_nothing: { for_author: 0.05, beyond_author: 0.05, rejects: 0 },
  unsure: { for_author: 0.5, beyond_author: 0.05, rejects: 0 },
  fails: "fails",
};

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

/**
 * A person sends a verbal command from the author's tracker issue, or from the chat thread for
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

/**
 * A person writes to the workflow: a message, a new start from a surface, or a status request. A
 * message wakes a sleeping workflow and restarts the idle clock.
 */
export function personWrites(kind: "prompt" | "start" | "status"): WorkflowAction {
  return action(`a person sends a ${kind}`, (world) =>
    world.deliver({ kind, text: "Where does this stand?" }),
  );
}

/** A person cancels the workflow where it started. */
export function personCancels(via: "control" | "word"): WorkflowAction {
  return action(`a person cancels with the ${via}`, (world) => {
    const reply_to = world.workflow.state.origin ?? undefined;
    if (via === "control")
      return world.deliver({ kind: "control", control: "cancel", text: "", reply_to });
    return world.deliver({ kind: "prompt", text: "cancel", reply_to });
  });
}

/** A person presses Stop in one of the workflow's tracker sessions, picked by `index`. */
export function personPressesStop(index: number): WorkflowAction {
  return action(`a person presses Stop in session ${index}`, async (world) => {
    const session = world.trackerSessionAt(index);
    if (!session) return;
    await world.deliver(stopEvent(session));
  });
}

/**
 * How a model call of a model-call author starts: its provision alarm fires, the agent prompts
 * it, or a person asks for a revision of its page with a comment held on it.
 */
export type ModelCallStart = "provision_fires" | "agent_prompts" | "revision_requested";

async function startModelCall(
  world: WorkflowWorld,
  author: WorldAuthor,
  start: ModelCallStart,
): Promise<void> {
  switch (start) {
    case "provision_fires":
      return world.provisionSandboxOf(author.taskId);
    case "agent_prompts": {
      const { prompt_task } = taskTools(world.workflow);
      await prompt_task.execute({ task_id: author.taskId, text: "Add a test for it." }, TOOL_CALL);
      return;
    }
    case "revision_requested":
      fakeDocumentsOf(world.workflow).holdComment({
        id: `held-revision-${world.steps.length}`,
        author_name: "Bea",
        text: `Comment at step ${world.steps.length}: name the owner of each step.`,
      });
      world.answerDecisionsWith(REPORTS_WORK_ANSWERS);
      await sendHeldCommentsOnRevisionRequest(world.workflow);
      return;
    default: {
      const unreachable: never = start;
      throw new Error(`unhandled start ${String(unreachable)}`);
    }
  }
}

/**
 * A model call of a model-call author starts, and a person presses Stop in the session of its job
 * while the page model answers.
 */
export function personStopsModelCall(index: number, start: ModelCallStart): WorkflowAction {
  const label = `a person presses Stop while the page model answers, after ${start}`;
  return authorAction(index, label, (world, author) =>
    world.stopWhilePageModelAnswers(author, () => startModelCall(world, author, start)),
  );
}

/**
 * A model call of a model-call author starts, and a person edits its page while the page model
 * answers.
 */
export function personEditsPageDuringModelCall(
  index: number,
  start: ModelCallStart,
): WorkflowAction {
  const label = `a person edits the page while the page model answers, after ${start}`;
  return authorAction(index, label, async (world, author) => {
    await world.editPageWhilePageModelAnswers(author, () => startModelCall(world, author, start));
  });
}

/**
 * A model call of a model-call author starts, and the workflow restarts while the page model
 * answers.
 */
export function workflowRestartsDuringModelCall(
  index: number,
  start: ModelCallStart,
): WorkflowAction {
  const label = `the workflow restarts while the page model answers, after ${start}`;
  return authorAction(index, label, (world, author) =>
    world.restartWhilePageModelAnswers(author, () => startModelCall(world, author, start)),
  );
}

/**
 * A model call of a model-call author starts and never answers, and the deadline alarm of its
 * model turn fires.
 */
export function modelCallOutlivesItsDeadline(index: number, start: ModelCallStart): WorkflowAction {
  const label = `the page model call outlives its deadline, after ${start}`;
  return authorAction(index, label, (world, author) =>
    world.modelCallOutlivesItsDeadline(author, () => startModelCall(world, author, start)),
  );
}

/** A person mentions the agent in a new chat thread about the work. The thread joins the workflow. */
export function chatThreadJoins(): WorkflowAction {
  return action("a chat thread joins", (world) =>
    world.deliver({ kind: "start", text: "Pick this up here.", reply_to: world.nextChatThread() }),
  );
}

/**
 * Which issue a started task names: the subject issue, a sub-issue of it, an issue outside the
 * subject, one another author already names, or none.
 */
export type StartedOn =
  | "the_subject_issue"
  | "a_sub_issue"
  | "a_stray_issue"
  | "a_taken_issue"
  | "no_issue";

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
    if (world.authors.length >= MAX_AUTHORS) return {};
    const { start_job } = startTools(world.workflow, [request]);
    const result = toolText(
      await start_job.execute(
        { stage: STAGE_OF[kind], brief: "Fix the next part.", issue: issueToName(world, on) },
        TOOL_CALL,
      ),
    );
    return { start: { refused: !result.startsWith("Started job") } };
  });
}

function issueToName(world: WorkflowWorld, on: StartedOn): string | undefined {
  const fresh = subIssueKey(world.authors.length);
  switch (on) {
    case "no_issue":
      return undefined;
    case "the_subject_issue":
      return SUBJECT_ISSUE_KEY;
    case "a_sub_issue":
      return fresh;
    case "a_stray_issue":
      return strayIssueKey(world.authors.length);
    case "a_taken_issue":
      return world.authors.map((author) => world.jobOf(author).issue_key).find(Boolean) ?? fresh;
    default: {
      const unreachable: never = on;
      throw new Error(`unhandled issue choice ${String(unreachable)}`);
    }
  }
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

/** The agent's turn calls finish_workflow when the turn offers it. */
function agentFinishesWorkflow(): WorkflowAction {
  return action("agent finishes the workflow", async (world) => {
    if (!offeredToTheAgent(world, FINISH_WORKFLOW)) return;
    const { finish_workflow } = planTools(world.workflow);
    await finish_workflow.execute({ result: "The login redirect is fixed." }, TOOL_CALL);
  });
}

/** The agent's turn calls fail_workflow when the turn offers it. */
export function agentFailsWorkflow(): WorkflowAction {
  return action("agent fails the workflow", async (world) => {
    if (!offeredToTheAgent(world, FAIL_WORKFLOW)) return;
    const { fail_workflow } = planTools(world.workflow);
    await fail_workflow.execute({ reason: "The repository cannot be built." }, TOOL_CALL);
  });
}

const UNPROMPTED_TURN: TurnFacts = {
  personWrote: false,
  requestsWork: true,
  inputArtifact: null,
  heldComments: new Map(),
};

function offeredToTheAgent(world: WorkflowWorld, toolName: string): boolean {
  const tools = workflowTools(world.workflow);
  return activeToolNames(world.workflow, tools, UNPROMPTED_TURN).includes(toolName);
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

/**
 * Whether the page host answers while held comments are read, and whether it marks a comment
 * read when asked.
 */
type PageHost = "readable" | "down" | "refuses_acknowledgement";

/** What lands while the screen reads the held comments. */
type WhileScreened = "nothing" | "agent_cancels";

/** How held comments are read and screened in one action. */
export type HeldCommentsRead = {
  decisions: DecisionsAtCompletion;
  host: PageHost;
  meanwhile: WhileScreened;
};

function heldCommentsLabel(read: HeldCommentsRead): string {
  return `decisions ${read.decisions}, page host ${read.host}, meanwhile ${read.meanwhile}`;
}

function answerScreenWith(world: WorkflowWorld, index: number, read: HeldCommentsRead): void {
  const landing = read.meanwhile === "agent_cancels" ? agentCancels(index, "author") : null;
  world.answerDecisionsWith(
    read.decisions === "answers" ? REPORTS_WORK_ANSWERS : read.decisions,
    landing ?? undefined,
  );
}

function onPageHost<Result>(
  world: WorkflowWorld,
  host: PageHost,
  body: () => Promise<Result>,
): Promise<Result> {
  switch (host) {
    case "readable":
      return body();
    case "down":
      return world.whilePageHostIsDown(body);
    case "refuses_acknowledgement":
      return world.whilePageHostRefusesAcknowledgements(body);
    default: {
      const unreachable: never = host;
      throw new Error(`unhandled page host ${String(unreachable)}`);
    }
  }
}

async function readingHeldComments<Result>(
  world: WorkflowWorld,
  read: HeldCommentsRead,
  body: () => Promise<Result>,
): Promise<Result> {
  const result = await onPageHost(world, read.host, body);
  if (read.decisions === "hangs") world.answerDecisionsWith("fails");
  return result;
}

/**
 * The agent sends the author a prompt of its own. A prompt to the author of a page carries the
 * comments held on it. Without `read`, the action lands inside another one and keeps its
 * decisions model.
 */
export function agentPromptsAuthor(index: number, read?: HeldCommentsRead): WorkflowAction {
  const label = read
    ? `agent prompts the author, ${heldCommentsLabel(read)}`
    : "agent prompts the author";
  return authorAction(index, label, async (world, author) => {
    const { prompt_task } = taskTools(world.workflow);
    const prompt = async () =>
      toolText(
        await prompt_task.execute(
          { task_id: author.taskId, text: "Add a test for it." },
          TOOL_CALL,
        ),
      );
    if (!read) {
      await prompt();
      return;
    }
    answerScreenWith(world, index, read);
    await readingHeldComments(world, read, prompt);
  });
}

/**
 * A person tells the agent they finished reviewing, and the turn sends the comments held on the
 * page of every running author.
 */
export function personAsksForRevision(index: number, read: HeldCommentsRead): WorkflowAction {
  return action(`a person asks for a revision, ${heldCommentsLabel(read)}`, async (world) => {
    answerScreenWith(world, index, read);
    await readingHeldComments(world, read, () => sendHeldCommentsOnRevisionRequest(world.workflow));
  });
}

/** What lands while the screen reads the held comments a mention sends. */
type WhileMentionScreened = "nothing" | "person_replies";

/** How a mention of the bot on a page is routed and read. */
export type PageMention = {
  routing: FeedbackRouting;
  host: PageHost;
  meanwhile: WhileMentionScreened;
};

/**
 * A person mentions the bot in a comment on the author's page, and the host delivers it. The
 * comments held on the page go out with it. A person may reply in the comment thread of a held
 * comment while the screen reads them.
 */
export function personMentionsOnPage(index: number, mention: PageMention): WorkflowAction {
  const label = `a person mentions the bot on the page, routed ${mention.routing}, page host ${mention.host}, meanwhile ${mention.meanwhile}`;
  return authorAction(index, label, async (world, author) => {
    const ref = world.artifactOf(author)?.ref;
    if (ref?.kind !== "page") return;
    const commentId = `mention-${world.steps.length}`;
    const text = `@artfct Mention ${world.steps.length}: tighten the summary.`;
    world.pageHost.addPersonComment({
      id: commentId,
      pageId: ref.page_id,
      lineId: null,
      authorName: "Bea",
      text,
      mentionsSelf: true,
    });
    const reply =
      mention.meanwhile === "person_replies" ? personRepliesInACommentThread(ref.page_id) : null;
    world.answerDecisionsWith(ROUTING_ANSWERS[mention.routing], reply ?? undefined);
    await onPageHost(world, mention.host, () =>
      world.deliver({
        kind: "feedback",
        text,
        bindings: [{ source: "documents_page", external_id: ref.page_id }],
        page: { page_id: ref.page_id, comment_id: commentId },
      }),
    );
  });
}

/** A person replies in the comment thread of the first comment held on the page. */
function personRepliesInACommentThread(pageId: string): WorkflowAction {
  return action("a person replies in a comment thread", async (world) => {
    const host = world.pageHost;
    const mentions = new Set(
      host.allPersonComments.filter((comment) => comment.mentionsSelf).map((comment) => comment.id),
    );
    const first = host.heldNow().find((comment) => !mentions.has(comment.id));
    if (!first) return;
    const opened = host.allPersonComments.find((comment) => comment.id === first.id);
    host.addPersonComment({
      id: `reply-${world.steps.length}`,
      pageId,
      lineId: null,
      authorName: "Cy",
      text: `Reply at step ${world.steps.length}: and the owner of each row.`,
      commentThreadId: opened?.commentThreadId ?? first.id,
    });
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

/** What the decisions model does when the agent completes a task. */
export type DecisionsAtCompletion = "answers" | "fails" | "hangs";

/** Milliseconds until the turn's abort signal stops a decisions model that never answers. */
const TURN_DEADLINE_MS = 5;

/** What lands while the decisions model checks whether the person accepted the artifact. */
export type WhileAcceptanceChecked = "nothing" | "agent_cancels";

/**
 * The agent completes the author task, in whatever state it is. `meanwhile` lands while the
 * decisions model checks the acceptance.
 */
export function agentCompletes(
  index: number,
  person: PersonAtCompletion,
  decisions: DecisionsAtCompletion,
  meanwhile: WhileAcceptanceChecked = "nothing",
): WorkflowAction {
  const label = `agent completes the task, the person ${person}, decisions ${decisions}, meanwhile ${meanwhile}`;
  return authorAction(index, label, async (world, author) => {
    const accepts = person === "accepts" ? 0.9 : 0.1;
    const landing = meanwhile === "agent_cancels" ? agentCancels(index, "author") : null;
    world.answerDecisionsWith(
      decisions === "answers"
        ? { for_author: 0, beyond_author: 0, rejects: 0, accepts }
        : decisions,
      landing ?? undefined,
      "accepts",
    );
    const { complete_job } = startTools(world.workflow, PERSON_MESSAGES[person]);
    await complete_job.execute(
      { job_id: world.jobOf(author).job_id, result: "Done." },
      toolCallFor(decisions),
    );
    if (decisions === "hangs") world.answerDecisionsWith("fails");
  });
}

function toolCallFor(decisions: DecisionsAtCompletion) {
  if (decisions !== "hangs") return TOOL_CALL;
  return { ...TOOL_CALL, abortSignal: AbortSignal.timeout(TURN_DEADLINE_MS) };
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

/**
 * The agent records the ruling a person gave on a judge entry, while the page host takes or
 * refuses comments.
 */
export function personRules(
  index: number,
  ruling: "approve" | "reject",
  pageCommenting: DocumentsCommenting = "takes",
): WorkflowAction {
  const label = `a person rules ${ruling} on a host that ${pageCommenting}`;
  return authorAction(index, label, async (world, author) => {
    const { rule_on_review } = artifactTools(world.workflow);
    const commentingBefore = world.pageHost.commenting;
    world.pageHost.commenting = pageCommenting;
    try {
      await rule_on_review.execute(
        { job_id: world.jobOf(author).job_id, ruling, reason: "The approach is wrong." },
        TOOL_CALL,
      );
    } finally {
      world.pageHost.commenting = commentingBefore;
    }
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

/** The sandbox of a task that just started comes up, and its bridge dials in. */
export function taskSandboxComesUp(taskId: string): WorkflowAction {
  return action(`sandbox of ${taskId} comes up, bridge dials_in`, (world) =>
    world.startSandboxOf(taskId),
  );
}

/** The timers a workflow arms that need no agent turn. */
const TIMERS = [
  "board_flush",
  "wall_clock",
  "hello_timeout",
  "no_progress",
  "keep_alive",
  "bridge_lost",
  "queue_retry",
  "settle_idle_author",
  "settle_lost_judge_ruling",
  "idle",
  "recheck",
  "model_turn_deadline",
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
  settle_idle_author: {
    method: "settleIdleAuthor",
    fire: (workflow, payload) => settleIdleAuthor(workflow, payload as GenerationAlarm),
  },
  settle_lost_judge_ruling: {
    method: "settleLostJudgeRuling",
    fire: (workflow, payload) => settleLostJudgeRuling(workflow, payload as TaskAlarm),
  },
  idle: { method: "onIdle", fire: (workflow) => onIdle(workflow) },
  recheck: {
    method: "recheckChecks",
    fire: (workflow, payload) => recheckChecks(workflow, payload as ChecksAlarm),
  },
  model_turn_deadline: {
    method: "onModelTurnDeadline",
    fire: (workflow, payload) => onModelTurnDeadline(workflow, payload as ModelTurnAlarm),
  },
};

/**
 * One armed alarm of a timer fires. `pick` counts round the alarms of that timer. A repeating
 * alarm stays armed.
 */
export function timerFires(timer: Timer, pick: number): WorkflowAction {
  return action(`${timer} timer ${pick} fires`, async (world) => {
    const { method, fire } = TIMER_ALARMS[timer];
    const armed = world.workflow.alarmsFor(method);
    const alarm = armed[pick % armed.length];
    if (!alarm) return;
    if (!alarm.repeats) await world.workflow.cancelAlarm(alarm.id);
    await fire(world.workflow, alarm.payload);
  });
}

/** The timers whose alarms are about one generation. */
export const GENERATION_TIMERS = [
  "hello_timeout",
  "no_progress",
  "keep_alive",
  "bridge_lost",
  "queue_retry",
  "settle_idle_author",
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
      .flatMap((task) => store.sandbox(task.task_id) ?? [])
      .filter((sandbox) => sandbox.generation > 0);
    const sandbox = sandboxes[pick % sandboxes.length];
    if (!sandbox) return;
    const alarm: GenerationAlarm = { task_id: sandbox.task_id, generation: sandbox.generation - 1 };
    await TIMER_ALARMS[timer].fire(world.workflow, alarm);
  });
}

/** What lands while a restart of the author waits on the destroy of its old container. */
export type WhileRestarting =
  | "agent_cancels"
  | "agent_cancels_and_starts_again"
  | "agent_completes"
  | "agent_pauses";

function whileRestarting(
  index: number,
  author: WorldAuthor,
  meanwhile: WhileRestarting,
): WorkflowAction {
  switch (meanwhile) {
    case "agent_cancels":
      return agentCancels(index, "author");
    case "agent_cancels_and_starts_again":
      return action("agent cancels the author and starts its job again", async (world) => {
        await world.land(agentCancels(index, "author"));
        return agentStartsTheJobAgain(world, author);
      });
    case "agent_completes":
      return agentCompletes(index, "accepts", "answers");
    case "agent_pauses":
      return agentHoldsAuthor(index, "pause_task");
    default: {
      const unreachable: never = meanwhile;
      throw new Error(`unhandled meanwhile ${String(unreachable)}`);
    }
  }
}

/** The agent starts a job of the author's stage on the author's issue, or on the first request. */
async function agentStartsTheJobAgain(
  world: WorkflowWorld,
  author: WorldAuthor,
): Promise<StepFacts> {
  const job = world.jobOf(author);
  const { start_job } = startTools(world.workflow, [REQUEST_TEXTS[0]]);
  const result = toolText(
    await start_job.execute(
      { stage: job.stage, brief: "Try it again.", issue: job.issue_key ?? undefined },
      TOOL_CALL,
    ),
  );
  return { start: { refused: !result.startsWith("Started job") } };
}

/**
 * The author restarts in a fresh sandbox after a failure it may recover from, and `meanwhile`
 * lands while the destroy of its old container is out.
 */
export function authorRestartsWhile(index: number, meanwhile: WhileRestarting): WorkflowAction {
  return authorAction(index, `restarts, meanwhile ${meanwhile}`, async (world, author) => {
    const task = world.taskOf(author);
    if (isTaskFinished(task.status) || !world.workflow.store.sandbox(task.task_id)) {
      return undefined;
    }
    return world.whileSandboxDestroyed(whileRestarting(index, author, meanwhile), () =>
      restartOrFailTask(world.workflow, task, "No progress after a nudge."),
    );
  });
}

/** How the workflow ends: the agent fails it, or a person cancels it from the chat thread. */
export type WorkflowEnding = "agent_fails" | "person_cancels";

/** What lands while an end of the workflow waits on the destroy of the first sandbox it closes. */
export type WhileEnding = "agent_starts" | "agent_fails" | "agent_finishes" | "person_cancels";

function workflowEnd(ending: WorkflowEnding | WhileEnding): WorkflowAction {
  switch (ending) {
    case "agent_starts":
      return agentStartsTask("pull", "no_issue", REQUEST_TEXTS[1]);
    case "agent_fails":
      return agentFailsWorkflow();
    case "agent_finishes":
      return agentFinishesWorkflow();
    case "person_cancels":
      return personCancels("control");
    default: {
      const unreachable: never = ending;
      throw new Error(`unhandled ending ${String(unreachable)}`);
    }
  }
}

/** The workflow ends, and `meanwhile` lands while the end waits on its first sandbox destroy. */
export function workflowEndsWhile(ending: WorkflowEnding, meanwhile: WhileEnding): WorkflowAction {
  return action(`the workflow ends: ${ending}, meanwhile ${meanwhile}`, async (world) => {
    return world.whileSandboxDestroyed(workflowEnd(meanwhile), () =>
      workflowEnd(ending).run(world),
    );
  });
}
