import { afterAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import {
  linearWriteKeepsTheConcurrentEdit,
  type LinearWriteOutcome,
} from "../../../test/documents-invariants";
import { fakeLinear, PAGE } from "../../../test/linear-graphql";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { LinearDocuments } from "./documents";

const RUNS = 100;

afterAll(() => mock.restore());

type LineChange = { keep: "kept" | "deleted" | "replaced"; inserted: number };

const words = fc.string({ unit: fc.constantFrom("a", "b", "c", " ", "x", "y", "z"), maxLength: 12 });

const writeCase = fc.record({
  readLines: fc.oneof(
    { weight: 1, arbitrary: fc.constant<string[]>([]) },
    { weight: 6, arbitrary: fc.array(words, { minLength: 1, maxLength: 10 }) },
  ),
  leadingInserts: fc.nat({ max: 2 }),
  changes: fc.array(
    fc.record({
      keep: fc.constantFrom<LineChange["keep"]>("kept", "kept", "kept", "deleted", "replaced"),
      inserted: fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, fc.nat({ max: 2 })),
    }),
    { minLength: 10, maxLength: 10 },
  ),
  personGap: fc.nat({ max: 10 }),
  personWords: words,
});

type WriteCase = typeof writeCase extends fc.Arbitrary<infer Case> ? Case : never;

function documentVersions(write: WriteCase) {
  let lineNumber = 0;
  const newLine = (text: string) => `L${(lineNumber += 1)}: ${text}`;
  const read = write.readLines.map(newLine);
  const changes = write.changes.slice(0, read.length);
  const authored = Array.from({ length: write.leadingInserts }, () => newLine("new"));
  const changedGaps = write.leadingInserts ? [0] : [];
  const changedLines: number[] = [];
  for (const [index, line] of read.entries()) {
    const change = changes[index]!;
    if (change.keep === "kept") authored.push(line);
    if (change.keep === "replaced") authored.push(newLine("new"));
    if (change.keep !== "kept") changedLines.push(index);
    authored.push(...Array.from({ length: change.inserted }, () => newLine("new")));
    if (change.inserted) changedGaps.push(index + 1);
  }
  const personGap = Math.min(write.personGap, read.length);
  const personLine = `M: ${write.personWords}`;
  const current = [...read.slice(0, personGap), personLine, ...read.slice(personGap)];
  const unchangedLinesAway = [
    ...changedLines.map((line) => (line < personGap ? personGap - line - 1 : line - personGap)),
    ...changedGaps.map((gap) => Math.abs(gap - personGap)),
  ];
  return {
    before: read.join("\n"),
    after: authored.join("\n"),
    current: current.join("\n"),
    personLine,
    farFromEveryChange: read.length > 0 && unchangedLinesAway.every((away) => away >= 2),
  };
}

let content = "";

fakeLinear({
  documents: () => ({
    documents: {
      pageInfo: PAGE,
      nodes: [
        {
          id: "d1",
          documentContentId: "dc1",
          content,
          url: "https://l/d1",
          updatedAt: "2026-09-04T00:00:00.000Z",
        },
      ],
    },
  }),
  updateDocument: (call) => {
    const input = call.variables.input as { content: string };
    content = input.content;
    return { documentUpdate: { success: true, lastSyncId: 2, document: { id: "d1" } } };
  },
});

const linear = new LinearDocuments("lin_api_x");

async function writeOutcome(before: string, after: string): Promise<LinearWriteOutcome> {
  try {
    await linear.updatePageContent("dc1", { before, after });
    return { content };
  } catch (error) {
    return { error };
  }
}

describe("Linear document write invariants", () => {
  it(
    "a write keeps a person's concurrent line or throws",
    async () => {
      let farFromEveryChange = 0;
      let readEmpty = 0;
      await fc.assert(
        fc.asyncProperty(writeCase, async (write) => {
          const versions = documentVersions(write);
          if (versions.farFromEveryChange) farFromEveryChange++;
          if (!versions.before) readEmpty++;
          content = versions.current;
          linearWriteKeepsTheConcurrentEdit({
            authorText: versions.after,
            personLine: versions.personLine,
            farFromEveryChange: versions.farFromEveryChange,
            outcome: await writeOutcome(versions.before, versions.after),
          });
        }),
        propertyRuns("linear write keeps the concurrent edit", RUNS),
      );
      expect(farFromEveryChange).toBeGreaterThan(0);
      expect(readEmpty).toBeGreaterThan(0);
    },
    propertyTimeoutMs(10_000, RUNS),
  );
});
