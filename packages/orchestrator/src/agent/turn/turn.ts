import type { LanguageModel, ToolSet } from "ai";
import type { WorkflowRuntime } from "../../workflow/types";
import { orchestratorIdentity } from "../model/agent-identity";
import { runUnderDeadline } from "./deadline";
import { eventBody, noteMessage } from "../transcript/envelope";
import { generateSteps } from "./generate";
import { closingTextWithheld, readPersonMessage, type PersonMessage } from "../message/owed-reply";
import { requestedRuntime, type RuntimeRequest } from "../message/requested-runtime";
import { COMPACT_PROMPT } from "../../prompts/summarization-prompt";
import { runPrompt } from "../model/run-prompt";
import { stepStatus } from "./step-status";
import { isSupersededIsolate } from "./superseded";
import { activeToolNames, systemPrompt, type TurnFacts } from "../prompt/system-prompt";
import { ASK, STAY_SILENT, TELL } from "../tools/channel";
import { FAIL_WORKFLOW, FINISH_WORKFLOW } from "../tools/plan";
import { START_JOB } from "../tools/start/start";
import { PROMPT_TASK } from "../tools/task";
import { condensingTools } from "../tools/condensed";
import { FOREIGN_TEXT_TOOLS, screeningTools } from "../tools/screened";
import { workflowTools } from "../tools/toolset";
import { abortableTools } from "../tools/abortable";
import type { TranscriptRow } from "../transcript/transcript";
import { estimatedTokens } from "../transcript/transcript-size";
import { TURN_PURPOSE } from "../model/usage";
import type { TurnDecisions } from "../../decisions/ask";
import { armTurnWatchdog, disarmTurnWatchdog, turnTimeoutText } from "./watchdog";

/** Posted when the model failed twice. */
export const STUCK_TEXT =
  "I could not get an answer from my model. Send your message again to retry, or wait for the next event.";
/** Share of `context_tokens` the older rows must reach before a compaction earns its call. */
const FLOOR_SHARE = 0.25;
/** The first line of a recap. */
export const RECAP_MARKER = "[recap of the earlier conversation]";
/** Tools whose message ends the turn. */
const TURN_ENDING_TOOLS = [STAY_SILENT, ASK, TELL, FINISH_WORKFLOW, FAIL_WORKFLOW];
/** Tools whose effect is the reply to a request for work. The board changes, and that is the answer. */
const REPLYING_TOOLS = [START_JOB, PROMPT_TASK];
/** Queued for the model when a person's turn ended with nothing for them. */
export const UNANSWERED_TEXT =
  "Your turn ended with nothing for the person who wrote to you. Answer them in your closing text now. When their message was for someone else, end with no text again.";

/** How a turn ended: with text for the humans, with nothing to say, not at all, or too late. */
type Outcome = "replied" | "silent" | "failed" | "timed_out";

/**
 * What one agent turn works from. `firstRow` is the id of the turn's first transcript row, which
 * compaction keeps. `requestText` identifies an ad hoc job started in the turn.
 */
type TurnInput = {
  rows: TranscriptRow[];
  firstRow: number | null;
  messages: string[];
  requestText: string;
};

/** What the decisions model read in the message of the person who waits on the turn. Null when nobody wrote. */
type Reply = PersonMessage | null;

/** What the turn did so far that a retry or a second pass must not forget. */
type TurnProgress = { boardChanged: boolean };

/** What every model run of one turn shares. */
type GenerateInput = { tools: ToolSet; signal: AbortSignal; reply: Reply; progress: TurnProgress };

/** What the tools of a turn share with the rest of the turn. */
type TurnToolsInput = { runtimeRequest: Promise<RuntimeRequest | null>; decisions: TurnDecisions };

/** What one run of the model works with. `stepsBefore` numbers its status lines after an earlier pass. */
type ModelPassInput = {
  model: LanguageModel;
  tools: ToolSet;
  signal: AbortSignal;
  turn: TurnFacts;
  progress: TurnProgress;
  stepsBefore: number;
};

/** What one run of the model left behind: its closing text, and whether a tool ended the turn. */
type ModelPass = { text: string; steps: number; endedByTool: boolean };

/**
 * One turn of the orchestrator agent: move the inbox into the transcript, let the model call
 * tools until it stops, persist what it said, and post its final text. An empty inbox does
 * nothing. A superseded isolate throws out of here for the new instance to resume.
 */
export async function runAgentTurn(workflow: WorkflowRuntime): Promise<void> {
  const inbox = workflow.transcript.inbox();
  if (inbox.length === 0) return;
  const messages = [
    ...(workflow.state.turn_messages ?? []),
    ...inbox.filter((row) => row.wake === "message").map((row) => eventBody(row.text)),
  ];
  const prompts = messages.length ? messages : inbox.map((row) => row.text);
  workflow.log(null, `agent turn started${messages.length ? " on a person's message" : ""}`);
  const startedAt = await armTurnWatchdog(workflow, messages);
  const drainedRow = workflow.transcript.drainInbox();
  const firstRow = workflow.state.turn_first_row ?? drainedRow;
  workflow.patchState({ turn_first_row: firstRow });
  const outcome = await boundedAttempt(workflow, {
    rows: workflow.transcript.all(),
    firstRow,
    messages,
    requestText: prompts.join("\n"),
  });
  const turnOwnsTheReply = await disarmTurnWatchdog(workflow, startedAt);
  if (!turnOwnsTheReply) return;
  await conclude(workflow, outcome);
}

/** Post what the outcome calls for. A turn with nothing to say always releases its reply targets. */
async function conclude(workflow: WorkflowRuntime, outcome: Outcome): Promise<void> {
  switch (outcome) {
    case "replied":
      return;
    case "silent":
      return workflow.release();
    case "failed":
      return workflow.post({ type: "info", text: STUCK_TEXT });
    case "timed_out": {
      const minutes = workflow.config().orchestrator.turn_timeout_minutes;
      workflow.log(null, `agent turn timed out after ${minutes} minutes`);
      return workflow.post({ type: "info", text: turnTimeoutText(minutes) });
    }
  }
}

/** The whole attempt, setup included, under the turn deadline. Throws only for a superseded isolate. */
async function boundedAttempt(workflow: WorkflowRuntime, turn: TurnInput): Promise<Outcome> {
  const timeoutMs = workflow.config().orchestrator.turn_timeout_minutes * 60_000;
  try {
    const bounded = await runUnderDeadline(timeoutMs, (signal) => attempt(workflow, turn, signal));
    return bounded.kind === "done" ? bounded.result : "timed_out";
  } catch (error) {
    if (isSupersededIsolate(error)) throw error;
    workflow.log(null, `agent turn failed outside the model: ${String(error).slice(0, 300)}`);
    return "failed";
  }
}

/** Run the model. One retry, unless the deadline is what ended the first try. */
async function attempt(
  workflow: WorkflowRuntime,
  turn: TurnInput,
  signal: AbortSignal,
): Promise<Outcome> {
  const message = turn.messages.join("\n\n");
  const decisions: TurnDecisions = { signal, failed: false };
  const reading = turn.messages.length ? readPersonMessage(workflow, message, decisions) : null;
  const runtimeRequest = Promise.resolve(reading).then((reply) =>
    reply?.namesModel ? requestedRuntime(workflow, message, decisions) : null,
  );
  const [reply, tools] = await Promise.all([
    reading,
    loadTools(workflow, turn, { runtimeRequest, decisions }),
  ]);
  await compactIfLarge(workflow, turn, signal);
  const run = { tools, signal, reply, progress: { boardChanged: false } };
  try {
    return await generate(workflow, run);
  } catch (firstError) {
    if (isSupersededIsolate(firstError)) throw firstError;
    workflow.log(null, `agent turn failed: ${String(firstError).slice(0, 300)}`);
    if (signal.aborted) return "timed_out";
  }
  try {
    return await generate(workflow, run);
  } catch (secondError) {
    if (isSupersededIsolate(secondError)) throw secondError;
    workflow.log(null, `agent turn failed again: ${String(secondError).slice(0, 300)}`);
    return signal.aborted ? "timed_out" : "failed";
  }
}

/**
 * MCP tools plus the workflow tools, each with its result held to the size limit. A result that
 * holds text written outside the orchestrator is screened first. `start_job` waits on
 * `runtimeRequest`, so the model a message named resolves while the model runs.
 */
async function loadTools(
  workflow: WorkflowRuntime,
  turn: TurnInput,
  { runtimeRequest, decisions }: TurnToolsInput,
): Promise<ToolSet> {
  let mcp: ToolSet = {};
  try {
    mcp = abortableTools(await workflow.mcpTools());
  } catch (error) {
    workflow.log(null, `mcp tools unavailable this turn: ${String(error).slice(0, 300)}`);
  }
  const tools = workflowTools(workflow, turn.messages, {
    requestText: turn.requestText,
    runtimeRequest,
    decisions,
  });
  const foreign = new Set<string>([...Object.keys(mcp), ...FOREIGN_TEXT_TOOLS]);
  return condensingTools(
    workflow,
    screeningTools(workflow, { ...mcp, ...tools }, foreign, decisions),
  );
}

/**
 * Run the model. Its closing text is posted only as the answer to a person who wrote. When
 * nobody wrote, the model speaks through a tool or not at all.
 */
async function generate(
  workflow: WorkflowRuntime,
  { tools, signal, reply, progress }: GenerateInput,
): Promise<Outcome> {
  const model = await workflow.model();
  const turn = turnFacts(reply);
  const input = { model, tools, signal, turn, progress };
  let pass = await modelPass(workflow, { ...input, stepsBefore: 0 });
  if (signal.aborted) return "timed_out";
  if (reply && !replied(pass, progress)) {
    workflow.log(null, "agent ended a person's turn with nothing for them, one more pass");
    workflow.transcript.append([{ role: "user", content: noteMessage(UNANSWERED_TEXT) }]);
    pass = await modelPass(workflow, { ...input, stepsBefore: pass.steps });
    if (signal.aborted) return "timed_out";
  }
  if (pass.endedByTool || !pass.text) return "silent";
  const withheld = closingTextWithheld(reply ? reply.owed : null, progress.boardChanged);
  if (withheld) {
    workflow.log(null, `closing text not posted, ${withheld}: ${pass.text.slice(0, 200)}`);
    return "silent";
  }
  await workflow.post({ type: "info", text: pass.text });
  return "replied";
}

/** What the rule blocks read about the turn. An unprompted turn carries the planning rules. */
function turnFacts(reply: Reply): TurnFacts {
  return {
    personWrote: reply !== null,
    requestsWork: reply === null || reply.requestsWork,
    inputArtifact: reply?.inputArtifact ?? null,
  };
}

/** True when the pass left the person something: text, a turn-ending message, or a board change. */
function replied(pass: ModelPass, progress: TurnProgress): boolean {
  return pass.text !== "" || pass.endedByTool || progress.boardChanged;
}

/**
 * One run of the model over the transcript as it stands now. Every step lands in the
 * transcript and on the channels as a status line numbered from `stepsBefore`.
 */
async function modelPass(
  workflow: WorkflowRuntime,
  { model, tools, signal, turn, progress, stepsBefore }: ModelPassInput,
): Promise<ModelPass> {
  const config = workflow.config().orchestrator;
  const activeTools = activeToolNames(workflow, tools, turn);
  const endingTools = TURN_ENDING_TOOLS.filter((name) => activeTools.includes(name));
  const pass: ModelPass = { text: "", steps: stepsBefore, endedByTool: false };
  pass.text = await generateSteps({
    model,
    system: systemPrompt(workflow, turn),
    messages: workflow.transcript.all().map((row) => row.message),
    tools,
    activeTools,
    maxSteps: config.max_steps,
    identity: orchestratorIdentity(workflow.state.workflow_id),
    abortSignal: signal,
    stopTools: endingTools,
    onStep: async (step) => {
      pass.steps += 1;
      const failed = new Set(step.toolErrors.map((error) => error.toolName));
      for (const call of step.toolCalls) {
        workflow.log(null, `agent: ${call.toolName} ${JSON.stringify(call.input).slice(0, 300)}`);
        if (endingTools.includes(call.toolName)) pass.endedByTool = true;
        if (REPLYING_TOOLS.includes(call.toolName) && !failed.has(call.toolName)) {
          progress.boardChanged = true;
        }
      }
      for (const error of step.toolErrors) {
        workflow.log(null, `agent: ${error.toolName} failed: ${error.error}`);
      }
      workflow.transcript.append(step.messages);
      workflow.store.recordModelUsage({
        purpose: TURN_PURPOSE,
        model: config.model,
        ...step.usage,
      });
      const status = stepStatus(pass.steps, step.toolCalls);
      if (status) await workflow.working(status);
    },
  });
  return pass;
}

/**
 * True when the last turn's input tokens passed the limit and the `older` rows compaction would
 * take out clear the floor. Under the floor, the system prompt and the tool set hold the size.
 */
function shouldCompact(workflow: WorkflowRuntime, older: string): boolean {
  const { context_tokens } = workflow.config().orchestrator;
  if (estimatedTokens(older) < context_tokens * FLOOR_SHARE) return false;
  return workflow.store.lastTurnInputTokens() > context_tokens;
}

/**
 * When the request passes the configured size, replace every row before this turn's own rows
 * with one recap. A resumed turn owns the rows of the lost turn. A recap that could not be
 * written leaves the transcript whole.
 */
async function compactIfLarge(
  workflow: WorkflowRuntime,
  { rows, firstRow }: TurnInput,
  signal: AbortSignal,
): Promise<void> {
  const cut = rows.findIndex((row) => row.id === firstRow);
  if (cut <= 0) return;
  const older = rows.slice(0, cut);
  const text = older.map((row) => JSON.stringify(row.message)).join("\n");
  if (!shouldCompact(workflow, text)) return;
  const recap = await runPrompt(workflow, COMPACT_PROMPT, text, { abortSignal: signal });
  if (!recap) {
    workflow.log(null, "agent transcript compaction found no recap, the next turn asks again");
    return;
  }
  workflow.transcript.replaceThrough(older.at(-1)!.id, {
    role: "user",
    content: `${RECAP_MARKER}\n${recap}`,
  });
  workflow.log(null, `agent transcript compacted: ${older.length} messages summarized`);
}
