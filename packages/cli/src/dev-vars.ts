import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const OWNER_ONLY = 0o600;

function formatDevVar(name: string, value: string): string {
  return value.includes("\n") ? `${name}="${value.trim()}"` : `${name}=${value}`;
}

function devVarLineCount(lines: string[], start: number, firstLine: string, name: string): number {
  const value = firstLine.slice(name.length + 1);
  if (!value.startsWith('"') || (value.length > 1 && value.endsWith('"'))) return 1;
  const closing = lines.findIndex((line, index) => index > start && line.endsWith('"'));
  return closing === -1 ? lines.length - start : closing - start + 1;
}

/** Set each value in a `.dev.vars` text. A set name keeps its place and other lines stay as they are. */
export function setDevVars(text: string, values: Record<string, string>): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const [name, value] of Object.entries(values)) {
    const formatted = formatDevVar(name, value).split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${name}=`));
    const firstLine = lines[start];
    if (firstLine === undefined) lines.push(...formatted);
    else lines.splice(start, devVarLineCount(lines, start, firstLine, name), ...formatted);
  }
  return `${lines.join("\n")}\n`;
}

/** The value of one single-line entry in a `.dev.vars` text. Undefined when the name is missing or empty. */
export function readDevVar(text: string, name: string): string | undefined {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${name}=`));
  const value = line
    ?.slice(name.length + 1)
    .trim()
    .replace(/^"(.*)"$/, "$1");
  return value || undefined;
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
