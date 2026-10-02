import { describe, expect, it } from "bun:test";
import {
  githubCommitChecks,
  type CommitCheckRunPayload,
  type CommitStatusPayload,
} from "./commit-checks";

function run(patch: Partial<CommitCheckRunPayload> = {}): CommitCheckRunPayload {
  return {
    name: "unit",
    conclusion: "success",
    completed_at: "2026-09-30T10:00:00Z",
    html_url: "https://github.com/acme/app/runs/1",
    output: { title: null, summary: null },
    ...patch,
  };
}

function status(patch: Partial<CommitStatusPayload> = {}): CommitStatusPayload {
  return {
    context: "jenkins/build",
    state: "success",
    description: null,
    target_url: "https://ci.acme.dev/build/1",
    updated_at: "2026-09-30T10:05:00Z",
    ...patch,
  };
}

const COMPLETED_SUITE = { status: "completed", latest_check_runs_count: 1 };

describe("the checks GitHub holds for one commit", () => {
  it("are unreported when no run and no status exists", () => {
    expect(githubCommitChecks({ runs: [], suites: [], statuses: [] })).toEqual({
      state: "unreported",
    });
  });

  it("ignore the suite GitHub opened for an App that never posted a run", () => {
    const suites = [{ status: "queued", latest_check_runs_count: 0 }];
    expect(githubCommitChecks({ runs: [], suites, statuses: [] })).toEqual({
      state: "unreported",
    });
  });

  it("passed when the newest of them finished, across runs and statuses", () => {
    const checks = githubCommitChecks({
      runs: [run(), run({ name: "docs", conclusion: "skipped" })],
      suites: [COMPLETED_SUITE],
      statuses: [status()],
    });
    expect(checks).toEqual({ state: "passed", settled_at: "2026-09-30T10:05:00Z" });
  });

  it("run while a run has no conclusion", () => {
    const runs = [run(), run({ name: "e2e", conclusion: null, completed_at: null })];
    expect(githubCommitChecks({ runs, suites: [], statuses: [] })).toEqual({ state: "running" });
  });

  it("run while a status is pending", () => {
    const statuses = [status({ state: "pending" })];
    expect(githubCommitChecks({ runs: [run()], suites: [], statuses })).toEqual({
      state: "running",
    });
  });

  it("run while a suite with runs is between two of its jobs", () => {
    const suites = [{ status: "in_progress", latest_check_runs_count: 1 }];
    expect(githubCommitChecks({ runs: [run()], suites, statuses: [] })).toEqual({
      state: "running",
    });
  });

  it("failed as soon as one run fails, with what it said", () => {
    const runs = [
      run({ name: "e2e", conclusion: null, completed_at: null }),
      run({ conclusion: "failure", output: { title: "2 tests failed", summary: "login.test" } }),
    ];
    expect(githubCommitChecks({ runs, suites: [], statuses: [] })).toEqual({
      state: "failed",
      failures: [
        {
          name: "unit",
          conclusion: "failure",
          detail: "2 tests failed\nlogin.test",
          url: "https://github.com/acme/app/runs/1",
        },
      ],
    });
  });

  it("failed when a status reports a failure", () => {
    const statuses = [status({ state: "failure", description: "Build 12 failed" })];
    expect(githubCommitChecks({ runs: [run()], suites: [], statuses })).toEqual({
      state: "failed",
      failures: [
        {
          name: "jenkins/build",
          conclusion: "failure",
          detail: "Build 12 failed",
          url: "https://ci.acme.dev/build/1",
        },
      ],
    });
  });

  it("stopped when a run was cancelled and none failed", () => {
    const runs = [run(), run({ name: "deploy", conclusion: "cancelled" })];
    const checks = githubCommitChecks({ runs, suites: [], statuses: [] });
    expect(checks).toMatchObject({
      state: "stopped",
      failures: [{ name: "deploy", conclusion: "cancelled" }],
    });
  });

  it("failed over stopped, because a push runs every check again", () => {
    const runs = [run({ conclusion: "failure" }), run({ name: "deploy", conclusion: "cancelled" })];
    const checks = githubCommitChecks({ runs, suites: [], statuses: [] });
    expect(checks).toMatchObject({ state: "failed", failures: [{ name: "unit" }] });
  });
});
