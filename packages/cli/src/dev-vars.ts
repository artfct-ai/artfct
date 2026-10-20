import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OWNER_ONLY = 0o600;

function devVarsPath(workerDir: string): string {
  return join(workerDir, ".dev.vars");
}

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

function readTextFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The text of a Worker's `.dev.vars` file. Undefined when the Worker has none. */
export function readDevVarsFile(workerDir: string): string | undefined {
  return readTextFile(devVarsPath(workerDir));
}

/**
 * Write values into a Worker's `.dev.vars` file and make it readable only by its owner. A missing
 * file starts from its `.example`.
 */
export function writeDevVarsFile(workerDir: string, values: Record<string, string>): void {
  const path = devVarsPath(workerDir);
  const base = readTextFile(path) ?? readTextFile(`${path}.example`) ?? "";
  if (existsSync(path)) chmodSync(path, OWNER_ONLY);
  writeFileSync(path, setDevVars(base, values), { mode: OWNER_ONLY });
}
