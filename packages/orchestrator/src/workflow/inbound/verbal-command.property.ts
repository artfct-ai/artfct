import { describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import {
  verbalCommandOnlyFromAnExactWord,
  type AfterTheWord,
  type ComposedMessage,
} from "../../../test/orchestrator-text-invariants";
import { parseVerbalCommand } from "./verbal-command";

const RUNS = 100;

const BARE_COMMAND_WORDS = ["cancel", "stop", "pause", "resume", "continue", "retry"];

const COMMAND_WORDS = [...BARE_COMMAND_WORDS, "instruct"];

const SHARED_PREFIX_WORDS = [
  "stopping",
  "stopped",
  "stops",
  "nonstop",
  "cancelled",
  "cancels",
  "cancellation",
  "precancel",
  "paused",
  "pauses",
  "unpause",
  "resumed",
  "resumes",
  "continued",
  "continues",
  "retrying",
  "retries",
  "cancel's",
  "stop's",
];

const LONGER_INSTRUCT_WORDS = ["instructions", "instructed", "instructor", "instructs"];

const LOOKALIKE_WORDS = [
  "ſtop",
  "ѕtop",
  "stoр",
  "ｓｔｏｐ",
  "сancel",
  "can​cel",
  "ınstruct",
  "pauѕe",
  "reſume",
];

const space = fc.constantFrom(" ", "  ", "\t", "\n", " ");
const optionalSpace = fc.oneof(fc.constant(""), space);

const mention = fc.constantFrom("<@U0AB12CD>", "<@u1>", "@ao", "@artfct-bot", "@a.o");

const lead = fc.oneof(
  fc.tuple(optionalSpace, fc.constant(""), fc.constant("")).map(([before]) => ({
    text: before,
    onlyAMention: true,
  })),
  fc.tuple(optionalSpace, mention, space).map(([before, name, after]) => ({
    text: `${before}${name}${after}`,
    onlyAMention: true,
  })),
  fc
    .tuple(
      optionalSpace,
      fc.constantFrom(
        "please ",
        "don't ",
        "ok ",
        "never ",
        "@ao please ",
        "<@U1> <@U2> ",
        "@ao @bo ",
        "> ",
      ),
    )
    .map(([before, words]) => ({ text: `${before}${words}`, onlyAMention: false })),
);

const word = fc.oneof(
  { weight: 3, arbitrary: fc.mixedCase(fc.constantFrom(...COMMAND_WORDS)) },
  { weight: 2, arbitrary: fc.mixedCase(fc.constantFrom(...SHARED_PREFIX_WORDS)) },
  { weight: 1, arbitrary: fc.mixedCase(fc.constantFrom(...LONGER_INSTRUCT_WORDS)) },
  { weight: 1, arbitrary: fc.constantFrom(...LOOKALIKE_WORDS) },
);

const afterTheWord: fc.Arbitrary<{ text: string; after: AfterTheWord }> = fc.oneof(
  fc.constant({ text: "", after: { kind: "nothing" } as const }),
  fc.constantFrom(".", "!", "?", "...", "?!", "!!!").map((punctuation) => ({
    text: punctuation,
    after: { kind: "punctuation", text: punctuation } as const,
  })),
  fc
    .tuple(
      fc.constantFrom(" ", ": ", ":", "\t", "\n", " : ", "  "),
      fc.constantFrom(
        "now",
        "using mocks in the tests",
        "with the API change, then add tests",
        "use bun",
        "waiting on design",
        "stop",
        "cancel",
        "it.",
        "😀 later",
      ),
    )
    .map(([separator, content]) => ({
      text: `${separator}${content}`,
      after: { kind: "text", content } as const,
    })),
);

const composedMessage: fc.Arbitrary<ComposedMessage> = fc
  .tuple(lead, word, afterTheWord, optionalSpace)
  .map(([before, commandWord, rest, trailing]) => ({
    text: `${before.text}${commandWord}${rest.text}${trailing}`,
    onlyAMention: before.onlyAMention,
    word: commandWord,
    after: rest.after,
  }));

const isBareWord = (candidate: string) => BARE_COMMAND_WORDS.includes(candidate.toLowerCase());

describe("verbal command invariants", () => {
  it(
    "only an exact command word after an optional mention acts as a command",
    () => {
      let wordBeforeTheCommand = 0;
      let textAfterABareWord = 0;
      let longerInstructWord = 0;
      fc.assert(
        fc.property(composedMessage, (message) => {
          if (!message.onlyAMention && isBareWord(message.word)) wordBeforeTheCommand++;
          if (message.after.kind === "text" && isBareWord(message.word)) textAfterABareWord++;
          if (/^instruct[a-z]/i.test(message.word)) longerInstructWord++;
          verbalCommandOnlyFromAnExactWord(message, parseVerbalCommand(message.text));
        }),
        propertyRuns("verbal command only from an exact word", RUNS),
      );
      expect(wordBeforeTheCommand).toBeGreaterThan(0);
      expect(textAfterABareWord).toBeGreaterThan(0);
      expect(longerInstructWord).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
