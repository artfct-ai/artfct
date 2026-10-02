import { describe, expect, it } from "bun:test";
import type { ProcessResult } from "../process";
import { checkCloudflareCredential } from "./cloudflare";

function wranglerAnswers(result: ProcessResult) {
  const calls: string[][] = [];
  const runWrangler = async (args: string[]) => {
    calls.push(args);
    return result;
  };
  return { calls, runWrangler };
}

describe("checkCloudflareCredential", () => {
  it("passes when wrangler reports a login", async () => {
    const { calls, runWrangler } = wranglerAnswers({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authType: "API Token" }),
      stderr: "",
    });
    expect(await checkCloudflareCredential(runWrangler)).toEqual({
      outcome: "passed",
      detail: "wrangler is authenticated",
    });
    expect(calls).toEqual([["whoami", "--json"]]);
  });

  it("reports a missing credential", async () => {
    const { runWrangler } = wranglerAnswers({
      exitCode: 1,
      stdout: '{"loggedIn":false}',
      stderr: "",
    });
    const outcome = await checkCloudflareCredential(runWrangler);
    expect(outcome.outcome).toBe("failed");
    expect(JSON.stringify(outcome)).toContain("no Cloudflare credential");
  });

  it("reports a failed wrangler run with its error output", async () => {
    const { runWrangler } = wranglerAnswers({
      exitCode: 1,
      stdout: "",
      stderr: "A request to the Cloudflare API (/user/tokens/verify) failed.\n",
    });
    expect(await checkCloudflareCredential(runWrangler)).toEqual({
      outcome: "failed",
      problems: [
        "wrangler whoami exited with 1. A request to the Cloudflare API (/user/tokens/verify) failed.",
      ],
    });
  });

  it("reports a run that exits 0 without the whoami JSON", async () => {
    const { runWrangler } = wranglerAnswers({ exitCode: 0, stdout: "not json", stderr: "" });
    expect(await checkCloudflareCredential(runWrangler)).toEqual({
      outcome: "failed",
      problems: ["wrangler whoami exited with 0."],
    });
  });
});
