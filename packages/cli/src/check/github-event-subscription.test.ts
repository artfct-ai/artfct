import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyTemplate } from "../../test/template";
import { checkGithubEventSubscription } from "./github-event-subscription";
import type { RunGh } from "./types";

const repoDirs: string[] = [];

const TRIGGERS = `
triggers:
  - event: github.pull_request.opened
    prompt: Review the pull request.
  - event: github.workflow_run.completed
    channel: C0123456
    prompt: Look at the run.
  - event: github.installation_repositories.added
    channel: C0123456
    prompt: Onboard the repository.
  - event: slack.member_joined_channel
    channel: C0123456
    prompt: Say hello.
`;

function deploymentRepo(options: { triggers: string; appLogin: string }): string {
  const repoDir = copyTemplate();
  repoDirs.push(repoDir);
  appendFileSync(join(repoDir, "orchestrator/workflows/development.yaml"), options.triggers);
  mkdirSync(join(repoDir, "ingress"));
  writeFileSync(
    join(repoDir, "ingress/wrangler.jsonc"),
    `{\n  // The slug of your GitHub App.\n  "vars": { "GITHUB_APP_LOGIN": "${options.appLogin}" },\n}\n`,
  );
  return repoDir;
}

function ghAnswering(events: string[]): { runGh: RunGh; calls: string[][] } {
  const calls: string[][] = [];
  const runGh: RunGh = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: JSON.stringify({ slug: "artfct-acme", events }), stderr: "" };
  };
  return { runGh, calls };
}

const ghNotInstalled: RunGh = async () => {
  throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
};

const ghNotFound: RunGh = async () => ({
  exitCode: 1,
  stdout: '{"message":"Not Found","status":"404"}',
  stderr: "gh: Not Found (HTTP 404)\n",
});

const ghUnreadable: RunGh = async () => ({ exitCode: 0, stdout: "<html>", stderr: "" });

function check(repoDir: string, runGh: RunGh | null) {
  return checkGithubEventSubscription({
    configDir: join(repoDir, "orchestrator"),
    ingressConfigPath: join(repoDir, "ingress/wrangler.jsonc"),
    runGh,
  });
}

afterEach(() => {
  for (const repoDir of repoDirs.splice(0)) rmSync(repoDir, { recursive: true, force: true });
});

describe("checkGithubEventSubscription", () => {
  it("passes without asking GitHub when no trigger names a GitHub event", async () => {
    const repoDir = deploymentRepo({ triggers: "", appLogin: "artfct-acme" });
    const gh = ghAnswering([]);
    expect(await check(repoDir, gh.runGh)).toEqual({
      outcome: "passed",
      detail: "no trigger names a GitHub event",
    });
    expect(gh.calls).toEqual([]);
  });

  it("reads the App through the GitHub CLI and passes when it receives every event", async () => {
    const repoDir = deploymentRepo({ triggers: TRIGGERS, appLogin: "artfct-acme" });
    const gh = ghAnswering(["pull_request", "workflow_run", "push"]);
    expect(await check(repoDir, gh.runGh)).toEqual({
      outcome: "passed",
      detail: "the GitHub App artfct-acme receives every GitHub event the triggers name",
    });
    expect(gh.calls).toEqual([["api", "apps/artfct-acme"]]);
  });

  it("names every trigger whose event the App does not receive", async () => {
    const repoDir = deploymentRepo({ triggers: TRIGGERS, appLogin: "artfct-acme" });
    expect(await check(repoDir, ghAnswering(["push"]).runGh)).toEqual({
      outcome: "failed",
      problems: [
        "workflows/development.yaml triggers[0]: the GitHub App artfct-acme does not receive pull_request events, so github.pull_request.opened never fires. Subscribe the App to pull_request under Permissions & events in its settings",
        "workflows/development.yaml triggers[1]: the GitHub App artfct-acme does not receive workflow_run events, so github.workflow_run.completed never fires. Subscribe the App to workflow_run under Permissions & events in its settings",
      ],
    });
  });

  it("skips offline", async () => {
    const repoDir = deploymentRepo({ triggers: TRIGGERS, appLogin: "artfct-acme" });
    expect(await check(repoDir, null)).toEqual({
      outcome: "skipped",
      detail: "--offline skips it",
    });
  });

  it("fails while the ingress config holds the App slug placeholder", async () => {
    const repoDir = deploymentRepo({ triggers: TRIGGERS, appLogin: "<your GitHub App slug>" });
    const gh = ghAnswering(["pull_request"]);
    expect((await check(repoDir, gh.runGh)).outcome).toBe("failed");
    expect(gh.calls).toEqual([]);
  });

  it("skips when the GitHub CLI is not installed", async () => {
    const repoDir = deploymentRepo({ triggers: TRIGGERS, appLogin: "artfct-acme" });
    expect((await check(repoDir, ghNotInstalled)).outcome).toBe("skipped");
  });

  it("fails with the GitHub CLI's error when it cannot read the App", async () => {
    const repoDir = deploymentRepo({ triggers: TRIGGERS, appLogin: "artfct-acme" });
    expect(await check(repoDir, ghNotFound)).toEqual({
      outcome: "failed",
      problems: [
        "gh api apps/artfct-acme exited with 1. Log the GitHub CLI in with `gh auth login` as a person who can see the GitHub App artfct-acme. gh: Not Found (HTTP 404)",
      ],
    });
  });

  it("fails when GitHub answers without the App's events", async () => {
    const repoDir = deploymentRepo({ triggers: TRIGGERS, appLogin: "artfct-acme" });
    expect(await check(repoDir, ghUnreadable)).toEqual({
      outcome: "failed",
      problems: ["GitHub answered gh api apps/artfct-acme without the App's events"],
    });
  });
});
