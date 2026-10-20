import { describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import { bridgeKeepsEveryHarnessLineWhole } from "../test/line-reader-invariants";
import { readLines } from "./line-reader";

const RUNS = 100;

const lineCharacter = fc.oneof(
  fc.string({ unit: "binary", minLength: 1, maxLength: 1 }),
  fc.constantFrom("é", "€", "ह", "😀", "\u{10FFFF}", "﻿", " ", "　"),
  fc.constantFrom(" ", "\t", "\r", "{", '"', "a"),
);

const line = fc.array(lineCharacter, { maxLength: 12 }).map((characters) => characters.join(""));

const harnessText = fc
  .tuple(
    fc.array(fc.tuple(line, fc.constantFrom("\n", "\r\n")), { maxLength: 8 }),
    fc.oneof(fc.constant(""), line),
  )
  .map(([ended, tail]) => `${ended.map(([text, end]) => `${text}${end}`).join("")}${tail}`);

const byteCuts = fc.array(fc.nat({ max: 400 }), { maxLength: 10 });

function chunksAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const offsets = [
    0,
    ...cuts.map((cut) => cut % (bytes.length + 1)).toSorted((left, right) => left - right),
  ];
  return offsets.map((offset, index) => bytes.slice(offset, offsets[index + 1] ?? bytes.length));
}

async function linesRead(chunks: Uint8Array[]): Promise<string[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const lines: string[] = [];
  await readLines(stream, (read) => lines.push(read));
  return lines;
}

function cutsInsideACharacter(chunks: Uint8Array[]): boolean {
  return chunks.slice(1).some((chunk) => ((chunk[0] ?? 0) & 0xc0) === 0x80);
}

describe("bridge line reader invariants", () => {
  it(
    "reads every harness line whole however the stream splits its bytes",
    async () => {
      let cutInsideACharacter = 0;
      let emptyChunk = 0;
      let unendedTail = 0;
      let loneCarriageReturn = 0;
      await fc.assert(
        fc.asyncProperty(harnessText, byteCuts, async (text, cuts) => {
          const chunks = chunksAt(new TextEncoder().encode(text), cuts);
          if (cutsInsideACharacter(chunks)) cutInsideACharacter++;
          if (chunks.some((chunk) => chunk.length === 0)) emptyChunk++;
          if (text.slice(text.lastIndexOf("\n") + 1).trim()) unendedTail++;
          if (/\r(?!\n)/.test(text.trim())) loneCarriageReturn++;
          bridgeKeepsEveryHarnessLineWhole(text, await linesRead(chunks));
        }),
        propertyRuns("bridge keeps every harness line whole", RUNS),
      );
      expect(cutInsideACharacter).toBeGreaterThan(0);
      expect(emptyChunk).toBeGreaterThan(0);
      expect(unendedTail).toBeGreaterThan(0);
      expect(loneCarriageReturn).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
