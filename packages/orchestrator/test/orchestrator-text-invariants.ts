import type { VerbalCommand } from "@artfct-ai/contracts/inbound";
import type { ParsedVerbalCommand } from "../src/workflow/inbound/verbal-command";

/** The most characters one screen part holds. */
const SCREEN_PART_CHARS = 20_000;

/** The most characters the task digest holds. */
const TASK_DIGEST_CHARS = 500;

/** Each bare command word and the verbal command it names. */
const BARE_COMMAND_WORDS: Record<string, Exclude<VerbalCommand, "instruct">> = {
  cancel: "cancel",
  stop: "cancel",
  pause: "pause",
  resume: "resume",
  continue: "resume",
  retry: "resume",
};

/** What follows the word of a composed message: nothing, closing punctuation, or more text. */
export type AfterTheWord =
  | { kind: "nothing" }
  | { kind: "punctuation"; text: string }
  | { kind: "text"; content: string };

/**
 * A person's message built from its parts. `onlyAMention` is true when nothing but whitespace and
 * one bot mention comes before `word`.
 */
export type ComposedMessage = {
  text: string;
  onlyAMention: boolean;
  word: string;
  after: AfterTheWord;
};

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

function expectedVerbalCommand(message: ComposedMessage): ParsedVerbalCommand | null {
  const { onlyAMention, word, after } = message;
  if (!onlyAMention || !/^[A-Za-z]+$/.test(word)) return null;
  const lowered = word.toLowerCase();
  if (lowered === "instruct") {
    if (after.kind === "nothing") return { control: "instruct", rest: "" };
    if (after.kind === "punctuation") return { control: "instruct", rest: after.text };
    return { control: "instruct", rest: after.content };
  }
  const control = BARE_COMMAND_WORDS[lowered];
  if (!control || after.kind === "text") return null;
  return { control, rest: "" };
}

/**
 * A message is a verbal command only when, after an optional bot mention, its whole text is one
 * command word with optional closing punctuation, or it starts with the whole word instruct.
 */
export function verbalCommandOnlyFromAnExactWord(
  message: ComposedMessage,
  parsed: ParsedVerbalCommand | null,
): void {
  const expected = expectedVerbalCommand(message);
  if (JSON.stringify(parsed) === JSON.stringify(expected)) return;
  violated(
    "verbalCommandOnlyFromAnExactWord",
    `${JSON.stringify(message.text)} read as ${JSON.stringify(parsed)}, expected ${JSON.stringify(expected)}`,
  );
}

/** Where each part starts in the text, or the reason the parts do not cover it in order. */
function screenPartStarts(text: string, parts: string[]): number[] | string {
  if (!text) return parts.every((part) => !part) ? [] : "an empty text has a part with text";
  const starts: number[] = [];
  let coveredTo = 0;
  for (const [index, part] of parts.entries()) {
    const previous = starts.at(-1);
    const start = previous === undefined ? 0 : text.indexOf(part, previous + 1);
    if (!part || start === -1 || !text.startsWith(part, start)) {
      return `part ${index} is not the text after part ${index - 1}`;
    }
    if (start > coveredTo) return `characters ${coveredTo} to ${start} are in no part`;
    starts.push(start);
    coveredTo = start + part.length;
  }
  return coveredTo === text.length ? starts : `characters from ${coveredTo} are in no part`;
}

/** The longest span of text that lies whole in one screen part, wherever it sits. */
const SCREEN_WHOLE_SPAN_CHARS = 1_000;

/**
 * The first character where a span of `spanLength` characters lies in no single part, or null
 * when every such span lies whole in one part. The parts start at `starts`.
 */
function firstSplitSpan(
  textLength: number,
  parts: string[],
  starts: number[],
  spanLength: number,
): number | null {
  let reach = 0;
  let next = 0;
  for (let spanStart = 0; spanStart + spanLength <= textLength; spanStart++) {
    while (next < starts.length && (starts[next] ?? 0) <= spanStart) {
      reach = Math.max(reach, (starts[next] ?? 0) + (parts[next]?.length ?? 0));
      next++;
    }
    if (reach < spanStart + spanLength) return spanStart;
  }
  return null;
}

/**
 * The screen parts cover the text in order. Each part holds at most 20,000 characters, and every
 * span of up to 1000 characters lies whole in one part.
 */
export function screenPartsHoldEverySpanWhole(text: string, parts: string[]): void {
  const name = "screenPartsHoldEverySpanWhole";
  const long = parts.findIndex((part) => part.length > SCREEN_PART_CHARS);
  if (long !== -1) violated(name, `part ${long} holds ${parts[long]?.length} characters`);
  const starts = screenPartStarts(text, parts);
  if (typeof starts === "string") violated(name, starts);
  const spanLength = Math.min(SCREEN_WHOLE_SPAN_CHARS, text.length);
  const split = firstSplitSpan(text.length, parts, starts, spanLength);
  if (split !== null) {
    violated(name, `characters ${split} to ${split + spanLength} lie in no single part`);
  }
}

/** The task digest holds at most 500 characters. */
export function taskDigestStaysWithinItsCap(digest: string): void {
  if (digest.length <= TASK_DIGEST_CHARS) return;
  violated("taskDigestStaysWithinItsCap", `the digest holds ${digest.length} characters`);
}
