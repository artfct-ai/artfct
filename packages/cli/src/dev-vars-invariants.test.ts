import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import {
  aRepeatedSetChangesNothing,
  aSetKeepsEveryOtherEntry,
  aSetValueReadsBack,
} from "../test/dev-vars-invariants";
import { readDevVar, setDevVars } from "./dev-vars";

const RUNS = 100;

const TEMPLATE_DIR = join(import.meta.dir, "../../../template");

const templateTexts = ["orchestrator", "ingress"].map((worker) =>
  readFileSync(join(TEMPLATE_DIR, worker, ".dev.vars.example"), "utf8"),
);

const devVarName = fc.oneof(
  fc.constantFrom("A", "AB", "PUBLIC_URL", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "_KEY"),
  fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,8}$/),
);

const lineCharacter = fc.constantFrom(
  "a",
  "Z",
  "0",
  "-",
  "+",
  "/",
  " ",
  "\t",
  '"',
  "'",
  "#",
  "=",
  "é",
  "😀",
);

const singleLineValue = fc
  .array(lineCharacter, { maxLength: 12 })
  .map((characters) => characters.join(""));

const multiLineValue = fc
  .array(singleLineValue, { minLength: 2, maxLength: 4 })
  .map((lines) => lines.join("\n"));

const entryLinesValue = fc
  .tuple(
    singleLineValue,
    fc.array(fc.tuple(devVarName, singleLineValue), { minLength: 1, maxLength: 3 }),
  )
  .map(
    ([first, entries]) =>
      `${first}\n${entries.map(([name, value]) => `${name}=${value}`).join("\n")}`,
  );

const privateKey = fc
  .array(fc.base64String({ minLength: 4, maxLength: 64 }), { minLength: 1, maxLength: 4 })
  .map(
    (lines) =>
      `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----\n`,
  );

const quotedStartValue = fc
  .tuple(fc.constantFrom('"', "'"), singleLineValue)
  .map(([quote, rest]) => `${quote}${rest}`);

const devVarValue = fc.oneof(
  fc.constant(""),
  singleLineValue,
  quotedStartValue,
  multiLineValue,
  entryLinesValue,
  privateKey,
);

const handWrittenLine: fc.Arbitrary<{ name: string | null; line: string }> = fc.oneof(
  singleLineValue.map((text) => ({ name: null, line: `#${text}` })),
  fc.constant({ name: null, line: "" }),
  devVarName.map((name) => ({ name, line: `${name}=` })),
  devVarName.map((name) => ({ name, line: `${name}=""` })),
  fc
    .tuple(devVarName, fc.stringMatching(/^[A-Za-z0-9.:/_-]{1,16}$/))
    .map(([name, value]) => ({ name, line: `${name}=${value}` })),
  fc.tuple(devVarName, privateKey).map(([name, key]) => ({ name, line: `${name}="${key}"` })),
);

const handWrittenText = fc
  .tuple(fc.array(handWrittenLine, { maxLength: 8 }), fc.boolean())
  .map(([lines, endsWithNewline]) => {
    const seen = new Set<string>();
    const kept = lines.filter(({ name }) => {
      if (name === null) return true;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    const text = kept.map(({ line }) => line).join("\n");
    return endsWithNewline && text ? `${text}\n` : text;
  });

const devVarValues = (minKeys: number) =>
  fc.dictionary(devVarName, devVarValue, { minKeys, maxKeys: 3 });

const writes = fc.record({
  base: fc.oneof(handWrittenText, fc.constantFrom(...templateTexts)),
  earlierWrites: fc.array(devVarValues(0), { maxLength: 2 }),
  values: devVarValues(1),
});

const DEV_VAR_QUOTES = ['"', "'", "`"];

describe(".dev.vars invariants", () => {
  it(
    "reads each set value back, keeps every other entry, and does not change on a repeated write",
    () => {
      const reached = {
        bothQuoteMarks: 0,
        commentMark: 0,
        edgeWhitespace: 0,
        leadingQuote: 0,
        entryLikeLine: 0,
        multiLineRewrite: 0,
      };
      fc.assert(
        fc.property(writes, ({ base, earlierWrites, values }) => {
          const before = earlierWrites.reduce(setDevVars, base);
          for (const [name, value] of Object.entries(values)) {
            if (value.includes('"') && value.includes("'")) reached.bothQuoteMarks++;
            if (value.includes("#")) reached.commentMark++;
            if (value && value.trim() !== value) reached.edgeWhitespace++;
            if (DEV_VAR_QUOTES.includes(value.charAt(0))) reached.leadingQuote++;
            if (
              value
                .split("\n")
                .slice(1)
                .some((line) => /^[A-Za-z_]\w*=/.test(line))
            ) {
              reached.entryLikeLine++;
            }
            if (readDevVar(before, name)?.includes("\n")) reached.multiLineRewrite++;
          }
          const written = setDevVars(before, values);
          aSetValueReadsBack(written, values);
          aSetKeepsEveryOtherEntry(before, values, written);
          aRepeatedSetChangesNothing(written, setDevVars(written, values));
        }),
        propertyRuns(".dev.vars entries round trip", RUNS),
      );
      for (const count of Object.values(reached)) expect(count).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
