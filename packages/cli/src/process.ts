import { spawn } from "node:child_process";

/** How a child process ended and what it printed. A signal that ended it leaves `exitCode` null. */
export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string };

/** Run a program to its end and collect its output. Rejects when the program does not start. */
export function runProcess(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/** Run a program on this process's terminal, so the person answers its prompts. Rejects when the program does not start. */
export function runInteractiveProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", resolve);
  });
}
