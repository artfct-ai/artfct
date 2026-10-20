function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * However a stream splits the bytes of a text, the bridge reads the lines the text holds, each
 * whole. It drops only blank lines and the whitespace around a line.
 */
export function bridgeKeepsEveryHarnessLineWhole(text: string, lines: string[]): void {
  const expected = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = expected.findIndex((line, index) => lines[index] !== line);
  if (first === -1 && lines.length === expected.length) return;
  const at = first === -1 ? expected.length : first;
  violated(
    "bridgeKeepsEveryHarnessLineWhole",
    `line ${at} reads ${JSON.stringify(lines[at])} where the text holds ${JSON.stringify(expected[at])}`,
  );
}
