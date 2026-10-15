import { describe, expect, it } from "bun:test";
import { ALLOWED_WORDS } from "./allowlist";
import {
  bannedWordHits,
  glossaryRows,
  missingCodeNames,
  wordsOf,
  type GlossaryRow,
} from "./glossary";
import { codePathExists, codeSources, readGlossary, bannedWordSources } from "./sources";

const GLOSSARY = `# Glossary

| Term | Meaning | Code name | Do not say |
|---|---|---|---|
| all-repos read token | A token. | \`mintAllReposReadToken\`, \`SandboxStartSpec.all_repos_read_token\` | read token |
| stop | Ends a turn. | \`EventKind "stop"\`, \`stopAuthor\` | cancel, interrupt |
| workflow definition | A set of stages. | \`workflows/<name>.yaml\` | |

| Status | Meaning |
|---|---|
| task \`in_review\` | Idle. |
`;

const ROWS: GlossaryRow[] = glossaryRows(GLOSSARY);

describe("glossaryRows", () => {
  it("reads the term, code names, and banned words of each term row", () => {
    expect(ROWS).toEqual([
      {
        term: "all-repos read token",
        codeNames: ["mintAllReposReadToken", "SandboxStartSpec.all_repos_read_token"],
        doNotSay: ["read token"],
      },
      {
        term: "stop",
        codeNames: ['EventKind "stop"', "stopAuthor"],
        doNotSay: ["cancel", "interrupt"],
      },
      { term: "workflow definition", codeNames: ["workflows/<name>.yaml"], doNotSay: [] },
    ]);
  });
});

describe("wordsOf", () => {
  it("splits camelCase, snake_case, and kebab-case names into lowercase words", () => {
    expect(wordsOf("cancelTask all_repos read-token")).toBe("cancel task all repos read token");
  });
});

describe("bannedWordHits", () => {
  const files = [
    { path: "a.ts", text: "export function cancelTask() {}\nconst interrupted = true;" },
    { path: "b.ts", text: "await mintAllReposReadToken();\n// the read token expired" },
  ];

  it("finds a banned word as a whole word inside a name", () => {
    expect(bannedWordHits(ROWS, files, [])).toEqual([
      { word: "cancel", term: "stop", path: "a.ts", line: 1 },
      { word: "read token", term: "all-repos read token", path: "b.ts", line: 2 },
    ]);
  });

  it("skips a use the allowlist names for its file or for every file", () => {
    const allowed = bannedWordHits(ROWS, files, [
      { word: "cancel", paths: ["a.ts"], reason: "a control word" },
      { word: "read token", paths: "everywhere", reason: "a different token" },
    ]);
    expect(allowed).toEqual([]);
  });
});

describe("missingCodeNames", () => {
  it("names a code name whose identifier or path is gone", () => {
    const code = "function stopAuthor() {}\ntype EventKind = 'stop';\nmintAllReposReadToken();";
    expect(missingCodeNames(ROWS, code, () => false)).toEqual([
      "SandboxStartSpec.all_repos_read_token",
      "workflows/<name>.yaml",
    ]);
  });

  it("reads a path code name as a pattern", () => {
    const patterns: string[] = [];
    missingCodeNames(ROWS, "", (pattern) => patterns.push(pattern) > 0);
    expect(patterns).toEqual(["workflows/*.yaml"]);
  });
});

describe("the glossary", () => {
  const rows = glossaryRows(readGlossary());

  it("names only code that exists", () => {
    const code = codeSources()
      .map((file) => file.text)
      .join("\n");
    expect(missingCodeNames(rows, code, codePathExists)).toEqual([]);
  });

  it("is not contradicted by a banned word in code, prompts, or skills", () => {
    const hits = bannedWordHits(rows, bannedWordSources(), ALLOWED_WORDS);
    expect(hits.map((hit) => `${hit.path}:${hit.line} says "${hit.word}" for ${hit.term}`)).toEqual(
      [],
    );
  });

  it("allows only words that are still used", () => {
    const hits = bannedWordHits(rows, bannedWordSources(), []);
    const unused = ALLOWED_WORDS.flatMap((entry) =>
      (entry.paths === "everywhere" ? [null] : entry.paths)
        .filter(
          (path) => !hits.some((hit) => hit.word === entry.word && (!path || hit.path === path)),
        )
        .map((path) => `${entry.word} in ${path ?? "every file"}`),
    );
    expect(unused).toEqual([]);
  });
});
