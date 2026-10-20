import { parse as parseWithDotenv } from "dotenv";
import { readDevVar } from "../src/dev-vars";

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * After a write, the CLI reader and dotenv, the parser wrangler reads `.dev.vars` with, both read
 * each set value back. The CLI reader reads an empty value as missing.
 */
export function aSetValueReadsBack(written: string, values: Record<string, string>): void {
  const wranglerValues = parseWithDotenv(written);
  for (const [name, value] of Object.entries(values)) {
    const read = readDevVar(written, name);
    if (read !== (value || undefined)) {
      violated(
        "aSetValueReadsBack",
        `${name} reads ${JSON.stringify(read)} after setting ${JSON.stringify(value)}`,
      );
    }
    if (wranglerValues[name] !== value) {
      violated(
        "aSetValueReadsBack",
        `wrangler reads ${name} as ${JSON.stringify(wranglerValues[name])} after setting ${JSON.stringify(value)}`,
      );
    }
  }
}

/** A write keeps every entry it does not set, as both the CLI reader and wrangler read it, and adds only the set names. */
export function aSetKeepsEveryOtherEntry(
  before: string,
  values: Record<string, string>,
  written: string,
): void {
  const wranglerBefore = parseWithDotenv(before);
  const wranglerAfter = parseWithDotenv(written);
  for (const name of new Set([...Object.keys(wranglerBefore), ...Object.keys(wranglerAfter)])) {
    if (name in values) continue;
    if (wranglerAfter[name] !== wranglerBefore[name]) {
      violated(
        "aSetKeepsEveryOtherEntry",
        `wrangler reads ${name} as ${JSON.stringify(wranglerAfter[name])} where it read ${JSON.stringify(wranglerBefore[name])}`,
      );
    }
    if (readDevVar(written, name) !== readDevVar(before, name)) {
      violated(
        "aSetKeepsEveryOtherEntry",
        `${name} reads ${JSON.stringify(readDevVar(written, name))} where it read ${JSON.stringify(readDevVar(before, name))}`,
      );
    }
  }
}

/** Setting the same values a second time leaves the text as the first write left it. */
export function aRepeatedSetChangesNothing(writtenOnce: string, writtenTwice: string): void {
  if (writtenTwice === writtenOnce) return;
  violated(
    "aRepeatedSetChangesNothing",
    `${JSON.stringify(writtenOnce)} became ${JSON.stringify(writtenTwice)}`,
  );
}
