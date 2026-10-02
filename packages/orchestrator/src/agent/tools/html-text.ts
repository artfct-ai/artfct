const HIDDEN_ELEMENTS = /<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS =
  /<\/?(p|div|br|hr|li|ul|ol|tr|table|section|article|header|footer|nav|main|aside|pre|blockquote|h[1-6])\b[^>]*>/gi;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The readable text of an HTML page with tags removed and blocks separated by newlines. */
export function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(HIDDEN_ELEMENTS, "")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

const MAX_CODE_POINT = 0x10ffff;

function decodeEntity(entity: string, name: string): string {
  if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? entity;
  const hex = name[1] === "x" || name[1] === "X";
  const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : entity;
}
