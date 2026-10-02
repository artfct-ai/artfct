import { beforeEach, describe, expect, it } from "bun:test";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { fakeLoginActor } from "../../../test/fake-actors";
import {
  branch,
  expectEvent,
  expectIgnored,
  forkPr,
  normalizeGithubWebhook,
  OUR_APP_LOGIN,
  pr,
  sam,
} from "../../../test/github-inbound-fixtures";
import { githubInbound } from "./inbound";
import { ownGithubLogins } from "./inbound-shared";

describe("github pull_request", () => {
  describe("a pull request opened on an orchestrator branch", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      const normalized = expectEvent(
        await normalizeGithubWebhook("pull_request", {
          action: "opened",
          pull_request: pr,
          sender: { login: "agent-bot" },
        }),
      );
      event = normalized.event;
    });

    it("takes its id from the delivery", () => {
      expect(event.id).toBe("github:d1");
    });

    it("becomes a pr_event", () => {
      expect(event.kind).toBe("pr_event");
    });

    it("binds to the pull request and to the branch", () => {
      expect(event.bindings).toEqual([
        { source: "code_pull", repo: "acme/app", number: 7 },
        { source: "code_branch", repo: "acme/app", branch },
      ]);
    });

    it("carries the action, the merge state, and both branches", () => {
      expect(event.pull).toMatchObject({ action: "opened", merged: false, branch, base: "main" });
    });

    it("names the sender as the actor", () => {
      expect(event.actor?.display_name).toBe("agent-bot");
    });
  });

  describe("a pull request that closed as merged", () => {
    it("carries the merged flag", async () => {
      const { event } = expectEvent(
        await normalizeGithubWebhook("pull_request", {
          action: "closed",
          pull_request: { ...pr, merged: true },
          sender: sam,
        }),
      );
      expect(event.pull).toMatchObject({ action: "closed", merged: true });
    });
  });

  describe("a pull request no task owns", () => {
    it("ignores a branch outside the orchestrator prefix", async () => {
      const feature = { ...pr, head: { ...pr.head, ref: "feature/x" } };
      expectIgnored(
        await normalizeGithubWebhook("pull_request", { action: "opened", pull_request: feature }),
      );
    });

    it("ignores a branch under the retired ao prefix", async () => {
      const retired = { ...pr, head: { ...pr.head, ref: "ao/wf_abcdefghij-1-fix" } };
      expect(
        await normalizeGithubWebhook("pull_request", { action: "opened", pull_request: retired }),
      ).toEqual({ ignore: "not an orchestrator branch" });
    });
  });

  describe("an action the workflow does not act on", () => {
    it("ignores a label change", async () => {
      expectIgnored(
        await normalizeGithubWebhook("pull_request", { action: "labeled", pull_request: pr }),
      );
    });
  });

  describe("a pull request from a fork", () => {
    it("ignores it even when the branch name matches", async () => {
      expect(
        await normalizeGithubWebhook("pull_request", { action: "opened", pull_request: forkPr }),
      ).toEqual({
        ignore: "pull request from a fork",
      });
    });

    it("ignores one whose head repository is gone", async () => {
      const deletedFork = { ...pr, head: { ...pr.head, repo: null } };
      expectIgnored(
        await normalizeGithubWebhook("pull_request", {
          action: "opened",
          pull_request: deletedFork,
        }),
      );
    });
  });
});

describe("github checks", () => {
  describe("a check suite that failed", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      const normalized = expectEvent(
        await normalizeGithubWebhook("check_suite", {
          action: "completed",
          check_suite: {
            conclusion: "failure",
            head_branch: branch,
            head_sha: "abc",
            pull_requests: [{ number: 7 }],
            app: { name: "GitHub Actions" },
          },
        }),
      );
      event = normalized.event;
    });

    it("becomes a ci_event", () => {
      expect(event.kind).toBe("ci_event");
    });

    it("binds to the pull request the suite ran on", () => {
      expect(event.bindings[0]).toEqual({ source: "code_pull", repo: "acme/app", number: 7 });
    });

    it("carries the conclusion and the app name", () => {
      expect(event.pull).toEqual({
        action: "completed",
        repo: "acme/app",
        number: 7,
        branch,
        conclusion: "failure",
        check_names: ["GitHub Actions"],
      });
    });
  });

  describe("a check suite without a pull request", () => {
    it("is ignored", async () => {
      expect(
        await normalizeGithubWebhook("check_suite", {
          action: "completed",
          check_suite: {
            conclusion: "failure",
            head_branch: branch,
            head_sha: "abc",
            pull_requests: [],
          },
        }),
      ).toEqual({ ignore: "check without a pull request" });
    });
  });

  describe("a check suite without a branch", () => {
    it("is ignored", async () => {
      expect(
        await normalizeGithubWebhook("check_suite", {
          action: "completed",
          check_suite: {
            conclusion: "failure",
            head_branch: null,
            head_sha: "abc",
            pull_requests: [{ number: 7 }],
          },
        }),
      ).toEqual({ ignore: "not an orchestrator branch" });
    });
  });

  describe("a check run that failed on a pull request", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      const normalized = expectEvent(
        await normalizeGithubWebhook("check_run", {
          action: "completed",
          check_run: {
            name: "unit",
            conclusion: "failure",
            head_sha: "abc",
            check_suite: { head_branch: branch },
            pull_requests: [{ number: 7 }],
          },
        }),
      );
      event = normalized.event;
    });

    it("binds to the pull request the run checked", () => {
      expect(event.bindings[0]).toEqual({ source: "code_pull", repo: "acme/app", number: 7 });
    });

    it("carries the pull request number", () => {
      expect(event.pull).toMatchObject({ number: 7, branch, check_names: ["unit"] });
    });
  });

  describe("a check run that failed without a pull request", () => {
    it("is ignored", async () => {
      expect(
        await normalizeGithubWebhook("check_run", {
          action: "completed",
          check_run: {
            name: "unit",
            conclusion: "failure",
            head_sha: "abc",
            check_suite: { head_branch: branch },
            pull_requests: [],
          },
        }),
      ).toEqual({ ignore: "check without a pull request" });
    });
  });

  describe("a check run that passed", () => {
    it("is ignored", async () => {
      expectIgnored(
        await normalizeGithubWebhook("check_run", {
          action: "completed",
          check_run: {
            name: "unit",
            conclusion: "success",
            head_sha: "abc",
            check_suite: { head_branch: branch },
            pull_requests: [],
          },
        }),
      );
    });
  });
});

describe("github push", () => {
  describe("a push to the default branch", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      const normalized = expectEvent(
        await normalizeGithubWebhook("push", { ref: "refs/heads/main", after: "def" }),
      );
      event = normalized.event;
    });

    it("becomes a pr_event", () => {
      expect(event.kind).toBe("pr_event");
    });

    it("binds to nothing", () => {
      expect(event.bindings).toEqual([]);
    });

    it("reports the base moved, with the branch", () => {
      expect(event.pull).toEqual({ action: "base_moved", repo: "acme/app", base: "main" });
    });
  });

  describe("a push to another branch", () => {
    it("is ignored", async () => {
      expectIgnored(await normalizeGithubWebhook("push", { ref: "refs/heads/feature/x" }));
    });
  });
});

describe("github payloads the mapper cannot use", () => {
  it("ignores an event name it does not handle", async () => {
    expectIgnored(await normalizeGithubWebhook("star", {}));
  });

  it("ignores a payload that names no repository", async () => {
    expectIgnored(
      await githubInbound(
        "push",
        {},
        {
          resolveActor: fakeLoginActor,
          deliveryId: "d2",
          ownLogins: ownGithubLogins(OUR_APP_LOGIN),
        },
      ),
    );
  });
});

describe("ownGithubLogins", () => {
  describe("no login configured", () => {
    it("reports no login when the setting is unset", () => {
      expect(ownGithubLogins(undefined)).toEqual([]);
    });

    it("reports no login when the setting holds only spaces", () => {
      expect(ownGithubLogins("  ")).toEqual([]);
    });
  });

  describe("a login configured", () => {
    it("reads a login written without the bot suffix", () => {
      expect(ownGithubLogins("acme-agent")).toEqual(["acme-agent", "acme-agent[bot]"]);
    });

    it("reads a login written with the bot suffix", () => {
      expect(ownGithubLogins("acme-agent[bot]")).toEqual(["acme-agent", "acme-agent[bot]"]);
    });
  });
});
