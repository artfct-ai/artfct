import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { OPTIONS_HEADING } from "../src/artifact/options";
import {
  CLOSING_TEXT_MARKER,
  PRODUCE_PAGE_OPENING,
  REVISE_OPENING,
} from "../src/prompts/model-author-prompt";
import { BLOCKING_REVIEW_OPENING } from "../src/prompts/review-prompt";
import { parseHeader } from "../src/agent/transcript/envelope";

/** A tool call the scripted model decided on. */
export type ScriptedDecision = { tool: string; input: Record<string, unknown> } | { text: string };

/**
 * A deterministic stand-in for the orchestrator model, for the smoke test and the unit tests.
 * It never streams.
 */
export class ScriptedModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "artfct-mock";
  readonly modelId = "scripted";
  readonly supportedUrls = {};
  private calls = 0;

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    this.calls += 1;
    const offered = (options.tools ?? []).map((offeredTool) => offeredTool.name);
    const decision = replyingFirst(scriptedDecision(options.prompt), offered);
    const content = toContent(decision, `mock-${this.calls}`);
    return {
      content,
      finishReason: { unified: "text" in decision ? "stop" : "tool-calls", raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      },
      warnings: [],
    };
  }

  doStream(): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("the scripted model does not stream"));
  }
}

/** Stage the mock plans when the system prompt lists none. */
const FALLBACK_STAGES = ["implement"];

/** The one line the mock sends back on a request before it plans, as the speaking rules ask. */
export const ACK_TEXT = "Got it. Launching an agent now.";

type UserMessage = Extract<LanguageModelV4Message, { role: "user" }>;
type ToolMessage = Extract<LanguageModelV4Message, { role: "tool" }>;

/** The event a user message carries: its parsed header and the text it came in. */
type ScriptedEvent = { header: Record<string, string>; body: string };

/**
 * The acknowledge line in place of a tool the step does not offer yet. A person's turn offers only
 * the first reply tools until the person heard back.
 */
function replyingFirst(decision: ScriptedDecision, offered: string[]): ScriptedDecision {
  if (!("tool" in decision) || offered.includes(decision.tool)) return decision;
  if (!offered.includes("acknowledge")) return decision;
  return { tool: "acknowledge", input: { reply: { kind: "text", text: ACK_TEXT } } };
}

/** The scripted policy. Exported so tests can check it without the provider plumbing. */
export function scriptedDecision(prompt: LanguageModelV4Prompt): ScriptedDecision {
  const system = prompt.find((message) => message.role === "system");
  if (system?.content.startsWith("Summarize"))
    return { text: "Summary of the earlier conversation." };
  const stages = stagesFromSystemPrompt(system?.content ?? "");
  const last = prompt.at(-1);
  if (!last) return { text: "" };
  if (last.role === "tool") return afterTool(last, lastEvent(prompt), stages);
  if (last.role !== "user") return { text: "" };
  const text = messageText(last);
  if (text.startsWith(PRODUCE_PAGE_OPENING)) return { text: scriptedDocument(text) };
  if (text.startsWith(REVISE_OPENING)) return { text: scriptedRevision(text) };
  const event = eventOf(last);
  if (event) return onEvent(event.header, event.body, stages);
  return routeReviewedArtifact(text);
}

/** The options every document of the scripted author lists on a stage with a choice ending. */
export const SCRIPTED_AUTHOR_OPTIONS = ["Feature flag", "Direct fix"];

/** The document a scripted model-call author answers with. */
function scriptedDocument(prompt: string): string {
  const research = promptSection(prompt, "Research payload", 1);
  const direction = directionOf(prompt);
  const lines = ["The scripted author wrote this document.", "", "## Research"];
  lines.push(research ?? "No research payload.");
  if (direction !== null) lines.push("", "## Direction", direction);
  if (promptSection(prompt, "Options", 0) !== null) {
    const items = SCRIPTED_AUTHOR_OPTIONS.map((option, index) => `${index + 1}. ${option}`);
    lines.push("", `## ${OPTIONS_HEADING}`, ...items);
  }
  return lines.join("\n");
}

/** The closing text of a scripted revision that asks for the reviewers to run again. */
export const SCRIPTED_REVIEW_REQUEST = "Run the reviewers again.";

/** The closing text of a scripted revision that needs no other review. */
export const SCRIPTED_NO_REVIEW = "The changes were straightforward. No other review is needed.";

/**
 * The revised document: the page as it is now, with a note of the last line of the findings,
 * then the closing text. It asks for another review after a review that asked for changes.
 */
function scriptedRevision(prompt: string): string {
  const [before, document = ""] = prompt.split("\n## Document\n");
  const findings = before!.split("\n## Findings\n")[1] ?? "";
  const asked =
    findings
      .split("\n")
      .findLast((line) => line.trim() !== "")
      ?.trim() ?? "";
  const page = document.split("\n").slice(1).join("\n").trim();
  const blocked = findings.includes(BLOCKING_REVIEW_OPENING);
  const closingText = blocked ? SCRIPTED_REVIEW_REQUEST : SCRIPTED_NO_REVIEW;
  return [page, "", "## Revision", `Revised for: ${asked}`, CLOSING_TEXT_MARKER, closingText].join(
    "\n",
  );
}

/**
 * The text of the input page under the direction section of a produce prompt, which may hold
 * headings of its own. It runs to the options section or the end. Null without one.
 */
function directionOf(prompt: string): string | null {
  const body = prompt.split("\n## Direction\n")[1];
  if (body === undefined) return null;
  return body.split("\n## Options\n")[0]!.split("\n").slice(1).join("\n").trim();
}

/** The text of a `## <heading>` section of a prompt, less its first `introLines` lines. */
function promptSection(prompt: string, heading: string, introLines: number): string | null {
  const body = prompt.split(`\n## ${heading}\n`)[1];
  if (body === undefined) return null;
  return body.split("\n## ")[0]!.split("\n").slice(introLines).join("\n").trim();
}

/** The note the workflow sends when a reviewed artifact is back with the agent to route. */
const ROUTING_NOTE =
  /The agent review of \S+ in job (\S+) is with you\. Its author \S+ is idle after a reviewer run\./;

/** Where a reviewed artifact goes next. The scripted answer is one more review. */
function routeReviewedArtifact(text: string): ScriptedDecision {
  const job = ROUTING_NOTE.exec(text)?.[1];
  return job ? { tool: "request_review", input: { job_id: job } } : { text: "" };
}

/** The text of a user message, with its content parts joined. */
function messageText(message: UserMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The event in a user message. Null for text without an event header. */
function eventOf(message: UserMessage): ScriptedEvent | null {
  const text = messageText(message).split("\n\n[").at(-1)!;
  const body = text.startsWith("event ") ? `[${text}` : text;
  const header = parseHeader(body);
  return header ? { header, body } : null;
}

/** The event of the last user message, which the tool result at the end of the prompt answers. */
function lastEvent(prompt: LanguageModelV4Prompt): ScriptedEvent | null {
  const user = prompt.findLast((message): message is UserMessage => message.role === "user");
  return user ? eventOf(user) : null;
}

/** The stage names under "## Stages" in the system prompt, in order. */
export function stagesFromSystemPrompt(system: string): string[] {
  const section = system.split("## Stages")[1]?.split("\n## ")[0] ?? "";
  const names = section
    .split("\n")
    .map((line) => /^- ([^\s:]+):/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  return names.length ? names : FALLBACK_STAGES;
}

function onEvent(header: Record<string, string>, body: string, stages: string[]): ScriptedDecision {
  const task = header.task === "none" ? null : (header.task ?? null);
  const job = header.job === "none" ? null : (header.job ?? null);
  switch (header.kind) {
    case "request":
      return { tool: "acknowledge", input: { reply: { kind: "text", text: ACK_TEXT } } };
    case "start":
    case "prompt":
      if (!task || !job) return plan(body, stages);
      return answerReply(task, job, body);
    case "status":
      return { tool: "status", input: {} };
    case "feedback":
      return task ? promptTask(task, body) : { text: "" };
    case "ci_event":
      return { text: "" };
    case "pr_event":
      return job && header.pull_action === "merged"
        ? completeJob(job, "Pull request merged.")
        : { text: "" };
    default:
      return { text: "" };
  }
}

function promptTask(task: string, text: string): ScriptedDecision {
  return { tool: "prompt_task", input: { task_id: task, text } };
}

/** An approval completes the job, a selection completes it on that option, and anything else is feedback. */
function answerReply(task: string, job: string, body: string): ScriptedDecision {
  const reply = replyOf(body);
  if (approvesReply(reply)) return completeJob(job, "Approved.");
  const option = selectedOption(reply);
  if (option) return completeJob(job, `Selected ${option}.`, option);
  return promptTask(task, body);
}

function completeJob(job: string, result: string, option?: string): ScriptedDecision {
  return {
    tool: "complete_job",
    input: option ? { job_id: job, result, option } : { job_id: job, result },
  };
}

/** What the person wrote in an event body, below its header lines. */
function replyOf(body: string): string {
  return body.split("\n").slice(2).join("\n").trim();
}

/** The judgement the real model makes from a reply: a plain yes means the artifact is accepted. */
export function approvesReply(reply: string): boolean {
  return /^(approve|approved|lgtm|looks good|ship it)\b|^reacted with :white_check_mark:/i.test(
    reply.trim(),
  );
}

/** The option a reply selects, as in "go with Feature flag". Null when it selects none. */
function selectedOption(reply: string): string | null {
  return /^go with (.+?)\.?$/im.exec(reply)?.[1]?.trim() ?? null;
}

/** The plan for a request, in the repository it links. */
function plan(body: string, stages: string[]): ScriptedDecision {
  const repo = repoOf(body);
  if (!repo) return { tool: "ask", input: { text: "Which repository should this change go in?" } };
  return {
    tool: "set_plan",
    input: {
      name: planName(body),
      ...plannedStages(body, stages),
      repo,
      page_parent: /^Page parent: (\S+)$/m.exec(body)?.[1] ?? null,
    },
  };
}

function plannedStages(body: string, stages: string[]): { stages: string[]; reason: string } {
  const named = namedStageOf(body);
  if (named) return { stages: [named], reason: "the request names the stage" };
  if (inputPageOf(body) !== null) {
    return { stages: stages.slice(1), reason: "the request links the artifact of the first stage" };
  }
  return { stages, reason: "default: every configured stage in order" };
}

function namedStageOf(body: string): string | null {
  return /^Stage: (\S+)$/m.exec(body)?.[1] ?? null;
}

function linkedIssueOf(body: string): string | null {
  return /https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z]+-\d+)/.exec(body)?.[1] ?? null;
}

function firstJobInput(body: string): JobInputFields {
  const artifact = inputPageOf(body);
  if (artifact) return { artifact };
  const issue = namedStageOf(body) ? linkedIssueOf(body) : null;
  return issue ? { issue } : {};
}

/** The repository the request links on the code host. */
function repoOf(body: string): string | null {
  return /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/.exec(body)?.[1] ?? null;
}

/** The link the request introduces as a doc, as in `design doc https://...`. Null without one. */
function inputPageOf(body: string): string | null {
  return /\bdoc (https?:\/\/[^\s>|]+)/i.exec(body)?.[1] ?? null;
}

/** The title the event carried, else a fixed name. The real model writes its own. */
function planName(body: string): string {
  return /^Title: (.+)$/m.exec(body)?.[1]?.trim() || "Mock workflow";
}

/** What follows the first reply: the plan for a request, else what the event asks for. */
function afterAcknowledge(event: ScriptedEvent, stages: string[]): ScriptedDecision {
  if (event.header.kind === "request") return plan(event.body, stages);
  return onEvent(event.header, event.body, stages);
}

/** The scripted answer to a tool result: the next step of the default route. */
function afterTool(
  message: ToolMessage,
  event: ScriptedEvent | null,
  stages: string[],
): ScriptedDecision {
  const result = message.content.at(-1);
  if (!result || result.type !== "tool-result") return { text: "" };
  const text = outputText(result.output);
  if (result.toolName === "acknowledge")
    return event ? afterAcknowledge(event, stages) : { text: "" };
  if (result.toolName === "set_plan") {
    const stage = /with stage ([^\s.]+)/.exec(text)?.[1];
    return startStage(stage, event ? firstJobInput(event.body) : {});
  }
  if (result.toolName === "complete_job") {
    const next = /Next stage: ([^\s.]+)/.exec(text)?.[1];
    if (next) return startStage(next);
    if (text.includes("last planned stage")) {
      return { tool: "finish_workflow", input: { result: "Every planned stage is done." } };
    }
    return { text: "" };
  }
  if (result.toolName === "status") return { text };
  return { text: "" };
}

type JobInputFields = { artifact?: string; issue?: string };

function startStage(stage: string | undefined, input: JobInputFields = {}): ScriptedDecision {
  const name = stage ?? "implement";
  return {
    tool: "start_job",
    input: { stage: name, brief: `Work the ${name} stage of the request.`, ...input },
  };
}

function outputText(output: { type: string; value?: unknown }): string {
  if (output.type === "text" && typeof output.value === "string") return output.value;
  if (output.type === "json") return typeof output.value === "string" ? output.value : "";
  return "";
}

function toContent(decision: ScriptedDecision, callId: string): LanguageModelV4Content[] {
  if ("text" in decision) return decision.text ? [{ type: "text", text: decision.text }] : [];
  return [
    {
      type: "tool-call",
      toolCallId: callId,
      toolName: decision.tool,
      input: JSON.stringify(decision.input),
    },
  ];
}
