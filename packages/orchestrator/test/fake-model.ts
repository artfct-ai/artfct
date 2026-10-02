import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";

/** What a model call does. */
export type Action =
  | "call"
  | "silent"
  | "acknowledge"
  | "tell"
  | "prompt_task"
  | "fetch"
  | "empty"
  | "throw"
  | "text";

/** The text a `text` step ends a model pass with. */
export const SCRIPTED_CLOSING_TEXT = "done";
/** The task a `prompt_task` step prompts. */
export const SCRIPTED_TASK = "wf_x.1";
/** The page a `fetch` step reads. */
export const SCRIPTED_PAGE_URL = "https://pages.test/notes";

/**
 * A model that follows a script. Past the end of the script it answers with text. A `throw`
 * step throws `failure`. `inputTokens` is what it reports having read.
 */
export class ScriptedFailure implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "scripted-failure";
  readonly supportedUrls = {};
  private calls = 0;

  constructor(
    private script: Action[],
    private failure = "model outage",
    private inputTokens = 0,
  ) {}

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const scripted = this.script[this.calls] ?? "text";
    this.calls += 1;
    const action = options.toolChoice?.type === "none" && scripted !== "throw" ? "text" : scripted;
    if (action === "throw") throw new Error(this.failure);
    const content = scriptedContent(action, `call-${this.calls}`);
    const callsTool = content.some((part) => part.type === "tool-call");
    return {
      content,
      finishReason: { unified: callsTool ? "tool-calls" : "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: this.inputTokens,
          noCache: this.inputTokens,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      },
      warnings: [],
    };
  }

  doStream(): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("no streaming"));
  }
}

function scriptedContent(
  action: Exclude<Action, "throw">,
  callId: string,
): LanguageModelV4Content[] {
  switch (action) {
    case "call":
      return [{ type: "tool-call", toolCallId: callId, toolName: "ping", input: "{}" }];
    case "silent":
      return [{ type: "tool-call", toolCallId: callId, toolName: "stay_silent", input: "{}" }];
    case "acknowledge":
      return [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "acknowledge",
          input: JSON.stringify({ text: "Got it." }),
        },
      ];
    case "tell":
      return [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "tell",
          input: JSON.stringify({ text: "The harness is stuck." }),
        },
      ];
    case "prompt_task":
      return [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "prompt_task",
          input: JSON.stringify({ task_id: SCRIPTED_TASK, text: "Apply the feedback." }),
        },
      ];
    case "fetch":
      return [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "fetch_url",
          input: JSON.stringify({ url: SCRIPTED_PAGE_URL }),
        },
      ];
    case "empty":
      return [];
    case "text":
      return [{ type: "text", text: SCRIPTED_CLOSING_TEXT }];
    default: {
      const unreachable: never = action;
      throw new Error(`unhandled action ${String(unreachable)}`);
    }
  }
}

/** A model that never answers. Its call ends only when the caller's deadline aborts it. */
export class SilentModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "silent";
  readonly supportedUrls = {};

  doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const signal = options.abortSignal;
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }

  doStream(): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("no streaming"));
  }
}

/**
 * A model that answers every call with fixed text and keeps the system prompts it was given.
 * `inputTokens` is what it reports having read, for a test that measures a request. `costUsd` is
 * the cost it reports for each call.
 */
export class EchoModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "echo";
  readonly supportedUrls = {};
  /** The system prompt of every call, in order. */
  systems: string[] = [];
  /** The text of the user messages of every call, in order. */
  userTexts: string[] = [];
  /** The abort signal of every call, in order. Undefined when the caller passed none. */
  signals: (AbortSignal | undefined)[] = [];
  /** The names of the tools each call offered, in order. */
  toolNames: string[][] = [];

  constructor(
    private answer: string,
    private inputTokens = 0,
    private costUsd = 0,
  ) {}

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const system = options.prompt.find((message) => message.role === "system");
    this.systems.push(typeof system?.content === "string" ? system.content : "");
    this.userTexts.push(
      options.prompt
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
    );
    this.signals.push(options.abortSignal);
    this.toolNames.push((options.tools ?? []).map((offered) => offered.name));
    return {
      content: [{ type: "text", text: this.answer }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: this.inputTokens,
          noCache: this.inputTokens,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
        raw: { cost: this.costUsd },
      },
      warnings: [],
    };
  }

  doStream(): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("no streaming"));
  }
}
