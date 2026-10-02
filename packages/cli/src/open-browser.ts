import { spawn } from "node:child_process";

function browserCommand(url: string): [string, string[]] {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** Open a URL in the default browser. Resolves once the opener started. */
export function openBrowser(url: string): Promise<void> {
  const [command, args] = browserCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
