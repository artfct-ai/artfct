import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const OWNER_ONLY = 0o600;

const DEV_VAR_QUOTES = ['"', "'", "`"];

/** One `NAME=value` entry of a `.dev.vars` text, and its span from the name to the end of its last line. */
type DevVarEntry = { name: string; value: string; start: number; end: number };

function lineEndAt(text: string, position: number): number {
  const lineEnd = text.indexOf("\n", position);
  return lineEnd === -1 ? text.length : lineEnd;
}

function readDevVarEntry(text: string, start: number, name: string): DevVarEntry {
  const valueStart = start + name.length + 1;
  const quote = text.charAt(valueStart);
  const closing = DEV_VAR_QUOTES.includes(quote) ? text.indexOf(quote, valueStart + 1) : -1;
  if (closing !== -1) {
    const end = lineEndAt(text, closing);
    return { name, value: text.slice(valueStart + 1, closing), start, end };
  }
  const end = lineEndAt(text, valueStart);
  return { name, value: text.slice(valueStart, end).trim(), start, end };
}

function readDevVarEntries(text: string): DevVarEntry[] {
  const entries: DevVarEntry[] = [];
  const entryStart = /^([A-Za-z_]\w*)=/gm;
  for (let match = entryStart.exec(text); match; match = entryStart.exec(text)) {
    const entry = readDevVarEntry(text, match.index, match[1] ?? "");
    entries.push(entry);
    entryStart.lastIndex = entry.end;
  }
  return entries;
}

function isBareDevVarValue(value: string): boolean {
  return (
    !/[#\r\n]/.test(value) && value.trim() === value && !DEV_VAR_QUOTES.includes(value.charAt(0))
  );
}

function formatDevVar(name: string, value: string): string {
  if (isBareDevVarValue(value)) return `${name}=${value}`;
  const quote = DEV_VAR_QUOTES.find((candidate) => !value.includes(candidate));
  if (quote === undefined) {
    throw new Error(`The value of ${name} holds every quote mark, so .dev.vars cannot hold it.`);
  }
  return `${name}=${quote}${value}${quote}`;
}

/**
 * Set each value in a `.dev.vars` text, quoted where wrangler would not read it bare. A set name
 * keeps its place and other lines stay as they are.
 */
export function setDevVars(text: string, values: Record<string, string>): string {
  let updated = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  for (const [name, value] of Object.entries(values)) {
    const entry = readDevVarEntries(updated).find((candidate) => candidate.name === name);
    const formatted = formatDevVar(name, value);
    updated = entry
      ? `${updated.slice(0, entry.start)}${formatted}${updated.slice(entry.end)}`
      : `${updated}${formatted}\n`;
  }
  return updated;
}

/** The value of one entry in a `.dev.vars` text. Undefined when the name is missing or empty. */
export function readDevVar(text: string, name: string): string | undefined {
  return readDevVarEntries(text).find((entry) => entry.name === name)?.value || undefined;
}

function readDevVarsBase(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8");
  const examplePath = `${path}.example`;
  return existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
}

/** Write values into a `.dev.vars` file that only its owner can read. A missing file starts from its `.example`. */
export function writeDevVarsFile(path: string, values: Record<string, string>): void {
  const text = setDevVars(readDevVarsBase(path), values);
  if (existsSync(path)) chmodSync(path, OWNER_ONLY);
  writeFileSync(path, text, { mode: OWNER_ONLY });
}
