import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { EchoModel } from "./fake-model";

/** A page model call that waits for its answer. */
type HeldCall = { userText: string; answer: (text: string) => void };

/**
 * A page model that holds each call until a test answers it, so a model turn stays in flight
 * across the events that land meanwhile.
 */
export class HeldPageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "test";
  readonly modelId = "held-page";
  readonly supportedUrls = {};
  private held: HeldCall | null = null;
  private onCallOut: (() => void) | null = null;
  /** The user text of every call that went out, also one a restart dropped. */
  readonly userTexts: string[] = [];

  /** Resolves once the next call is out. */
  nextCall(): Promise<"call_out"> {
    return new Promise((callOut) => {
      this.onCallOut = () => callOut("call_out");
    });
  }

  /** The user text of the call that waits, or null when none does. */
  get heldUserText(): string | null {
    return this.held?.userText ?? null;
  }

  /** Forget the call that waits, as a restart loses it. It never answers. */
  drop(): void {
    this.held = null;
  }

  /** Answer the call that waits with `text`. */
  answer(text: string): void {
    const held = this.held;
    if (!held) throw new Error("no page model call is out");
    this.held = null;
    held.answer(text);
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const userText = options.prompt
      .flatMap((message) => (message.role === "user" ? message.content : []))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    this.userTexts.push(userText);
    const text = await new Promise<string>((answer) => {
      this.held = { userText, answer };
      const callOut = this.onCallOut;
      this.onCallOut = null;
      callOut?.();
    });
    return new EchoModel(text).doGenerate(options);
  }

  async doStream(_options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return Promise.reject(new Error("no streaming"));
  }
}
