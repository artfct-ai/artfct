/** One row of a glossary table: the term, its code names, and the words not to say for it. */
export type GlossaryRow = { term: string; codeNames: string[]; doNotSay: string[] };

/** A source file by its path from the repository root. */
export type SourceFile = { path: string; text: string };

/** A use of a word the glossary says not to say for a term. */
export type BannedWordHit = { word: string; term: string; path: string; line: number };

/** A use of a banned word that names a different concept, and why. */
export type AllowedWord = { word: string; paths: "everywhere" | string[]; reason: string };

/** The rows of every glossary table that has a code name column. */
export function glossaryRows(markdown: string): GlossaryRow[] {
  return markdown.split("\n").flatMap((line) => {
    if (!line.startsWith("|") || line.startsWith("|---")) return [];
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length !== 4 || cells[0] === "Term") return [];
    const [term = "", , codeNames = "", doNotSay = ""] = cells;
    return [
      {
        term,
        codeNames: [...codeNames.matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
        doNotSay: doNotSay
          .split(",")
          .map((word) => word.trim())
          .filter(Boolean),
      },
    ];
  });
}

/** Text as lowercase words, with camelCase, snake_case, and kebab-case names split apart. */
export function wordsOf(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .toLowerCase();
}

function wholeWord(word: string): RegExp {
  return new RegExp(`\\b${wordsOf(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}

function isAllowed(hit: BannedWordHit, allowlist: AllowedWord[]): boolean {
  return allowlist.some(
    (entry) =>
      entry.word === hit.word && (entry.paths === "everywhere" || entry.paths.includes(hit.path)),
  );
}

function containsPhrase(words: string, phrase: string): boolean {
  return wholeWord(phrase).test(words);
}

/**
 * Each line of the files that uses a banned word, past the allowlist. A banned word inside a
 * longer glossary term or code name, such as "read token" in "all-repos read token", is that term.
 */
export function bannedWordHits(
  rows: GlossaryRow[],
  files: SourceFile[],
  allowlist: AllowedWord[],
): BannedWordHit[] {
  const names = rows.flatMap((row) => [row.term, ...row.codeNames]).map(wordsOf);
  const banned = rows.flatMap((row) =>
    row.doNotSay.map((word) => {
      const phrase = wordsOf(word);
      const longerNames = names.filter((name) => name !== phrase && containsPhrase(name, phrase));
      return {
        word,
        term: row.term,
        pattern: wholeWord(word),
        longerNames: longerNames.map((name) => new RegExp(wholeWord(name).source, "g")),
      };
    }),
  );
  return files.flatMap((file) =>
    file.text.split("\n").flatMap((text, index) => {
      const words = wordsOf(text);
      return banned
        .filter((entry) =>
          entry.pattern.test(
            entry.longerNames.reduce((line, name) => line.replace(name, " "), words),
          ),
        )
        .map((entry) => ({ word: entry.word, term: entry.term, path: file.path, line: index + 1 }))
        .filter((hit) => !isAllowed(hit, allowlist));
    }),
  );
}

/**
 * The code names whose identifiers no longer occur in the code. A name with a slash is a path
 * pattern, where `<name>` stands for any file name.
 */
export function staleCodeNames(
  rows: GlossaryRow[],
  code: string,
  pathExists: (pattern: string) => boolean,
): string[] {
  const codeNames = [...new Set(rows.flatMap((row) => row.codeNames))];
  return codeNames.filter((codeName) => {
    if (codeName.includes("/")) return !pathExists(codeName.replaceAll(/<[^>]+>/g, "*"));
    const identifiers = codeName.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    return identifiers.some((identifier) => !new RegExp(`\\b${identifier}\\b`).test(code));
  });
}
