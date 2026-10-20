import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import {
  slackChunksKeepTheText,
  slackMrkdwnIsStable,
  slackTextNeverNotifies,
} from "../../../test/slack-text-invariants";
import { splitSlackText } from "./chat";
import { toSlackMrkdwn } from "./mrkdwn";

const RUNS = 100;

const slackTag = fc.constantFrom(
  "<@U1>",
  "<@U1|ann>",
  "<!channel>",
  "<!here>",
  "<!everyone>",
  "<!subteam^S1>",
  "<!subteam^S1|@eng>",
);

const splitTag = fc
  .tuple(slackTag, fc.constantFrom("**", "~~", "`", "****"))
  .map(([tag, marker]) => `${tag.slice(0, 1)}${marker}${tag.slice(1)}`);

const markdownFragment = fc.constantFrom(
  "<",
  ">",
  "@U1>",
  "!here>",
  "**",
  "~~",
  "*",
  "~",
  "`",
  "[",
  "]",
  "](",
  "(",
  ")",
  "|",
  "&",
  "&lt;",
  "#",
  " ",
  "\n",
  "https://a.test",
);

const word = fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 6 });

const linkTarget = fc.oneof(
  fc.constantFrom("https://a.test", "https://a.test/p_(q)", "mailto:a@b.test", "./readme.md"),
  fc.tuple(fc.constantFrom("https://a.test/", "mailto:"), slackTag).map((parts) => parts.join("")),
);

const { inline } = fc.letrec<{ inline: string }>((tie) => ({
  inline: fc.oneof(
    { maxDepth: 4, depthIdentifier: "inline" },
    word,
    slackTag,
    splitTag,
    markdownFragment,
    fc.array(tie("inline"), { minLength: 2, maxLength: 5 }).map((parts) => parts.join("")),
    tie("inline").map((text) => `**${text}**`),
    tie("inline").map((text) => `~~${text}~~`),
    tie("inline").map((text) => `\`${text}\``),
    fc
      .tuple(fc.constantFrom("", "!"), tie("inline"), linkTarget)
      .map(([image, label, target]) => `${image}[${label}](${target})`),
  ),
}));

const markdownBlock = fc.oneof(
  inline,
  fc
    .tuple(fc.integer({ min: 1, max: 6 }), inline, fc.constantFrom("", " #", " ##"))
    .map(([level, text, closing]) => `${"#".repeat(level)} ${text}${closing}`),
  fc
    .tuple(fc.integer({ min: 1, max: 6 }), slackTag, inline)
    .map(([level, tag, text]) => `${"#".repeat(level)} ${tag.slice(0, 1)}**${tag.slice(1)}${text}`),
  inline.map((text) => `- ${text}`),
  inline.map((text) => `\`\`\`\n${text}\n\`\`\``),
);

const markdown = fc.array(markdownBlock, { maxLength: 5 }).map((blocks) => blocks.join("\n"));

const SPLIT_TAG_IN_A_HEADING = /^ {0,3}#{1,6}[ \t][^\n]*<\*\*[!@]/m;

const MARKERS_THAT_TOUCH = /\*\*\*|~~~/;

const emoji = fc.constantFrom("😀", "👍🏽", "🇺🇸", "𝄞", "👩‍💻");

const chunkPiece = fc.oneof(
  word,
  emoji,
  fc.string({ unit: "binary", maxLength: 12 }),
  fc.constantFrom(" ", "\n", "\n\n", "\n\n\n", "\t", "\r\n", "  \n  "),
  fc.string({ unit: "grapheme-ascii", minLength: 30, maxLength: 90 }).map((run) => run.trim()),
  fc.constantFrom("<https://a.test/pull/47|PR #47>", "&lt;!here>"),
);

const chunkText = fc.array(chunkPiece, { maxLength: 40 }).map((pieces) => pieces.join(""));

const runWithoutABreak = fc.constantFrom("a", "b", "-", "#");

const textAndLimit = fc.integer({ min: 2, max: 60 }).chain((limit) =>
  fc.record({
    limit: fc.constant(limit),
    text: fc.oneof(
      chunkText,
      fc
        .tuple(
          fc.string({ unit: "grapheme-ascii", minLength: limit - 2, maxLength: limit + 2 }),
          fc.oneof(emoji, fc.constantFrom("\n", "\n\n")),
          chunkText,
        )
        .map((parts) => parts.join("")),
      {
        weight: 2,
        arbitrary: fc
          .tuple(
            fc.string({ unit: runWithoutABreak, minLength: limit - 2, maxLength: limit + 2 }),
            fc.oneof(emoji, fc.constantFrom(" ", ".")),
            chunkText,
          )
          .map((parts) => parts.join("")),
      },
    ),
  }),
);

function cutFallsInsideAPair(text: string, limit: number): boolean {
  if (text.length <= limit || /\s/.test(text.slice(1, limit + 1))) return false;
  if (text.slice(0, limit).includes(".")) return false;
  const unit = text.charCodeAt(limit - 1);
  return unit >= 0xd800 && unit <= 0xdbff;
}

describe("Slack text invariants", () => {
  it(
    "the mrkdwn posted to chat never notifies anyone, for any Markdown",
    () => {
      let splitTagsInHeadings = 0;
      fc.assert(
        fc.property(markdown, (text) => {
          if (SPLIT_TAG_IN_A_HEADING.test(text)) splitTagsInHeadings++;
          slackTextNeverNotifies(toSlackMrkdwn(text));
        }),
        propertyRuns("slack text never notifies", RUNS),
      );
      expect(splitTagsInHeadings).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "the chunks stay under the limit and keep the text in order",
    () => {
      let cutsInsideAPair = 0;
      fc.assert(
        fc.property(textAndLimit, ({ text, limit }) => {
          if (cutFallsInsideAPair(text, limit)) cutsInsideAPair++;
          slackChunksKeepTheText(text, splitSlackText(text, limit), limit);
        }),
        propertyRuns("slack chunks keep the text", RUNS),
      );
      expect(cutsInsideAPair).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "converting converted text changes nothing",
    () => {
      let touchingMarkers = 0;
      fc.assert(
        fc.property(markdown, (text) => {
          if (MARKERS_THAT_TOUCH.test(text)) touchingMarkers++;
          const once = toSlackMrkdwn(text);
          slackMrkdwnIsStable(once, toSlackMrkdwn(once));
        }),
        propertyRuns("slack mrkdwn is stable", RUNS),
      );
      expect(touchingMarkers).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
