import { beforeEach, describe, expect, it } from "bun:test";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { CodeUser } from "@artfct-ai/contracts/types";
import { fakeLoginActor } from "../../../test/fake-actors";
import {
  expectEvent,
  expectIgnored,
  normalizeGithubWebhook,
  OUR_APP_LOGIN,
  pr,
  repo,
  reviewPayload,
  sam,
} from "../../../test/github-inbound-fixtures";
import { githubInbound } from "./inbound";
import { ownGithubLogins } from "./inbound-shared";
import type { CodeActorResolver } from "../types";

const OUR_APP = { login: `${OUR_APP_LOGIN}[bot]`, id: 99 };
const REVIEWING_APP = { login: "coderabbitai[bot]", type: "Bot", id: 99 };

describe("github reviews the orchestrator wrote itself", () => {
  describe("a review on a pull request the orchestrator opened", () => {
    it("is ignored, since it is our own review coming back", async () => {
      expectIgnored(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: {
            ...reviewPayload("changes_requested", "BLOCKING: two problems."),
            user: OUR_APP,
          },
          pull_request: { ...pr, user: { login: OUR_APP.login } },
        }),
      );
    });
  });

  describe("our review of a pull request somebody else opened", () => {
    it("is ignored", async () => {
      expectIgnored(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: { ...reviewPayload("approved", "Looks fine."), user: OUR_APP },
          pull_request: { ...pr, user: { login: "sam" } },
        }),
      );
    });
  });

  describe("a review from an App login only the setting knows", () => {
    const payload = {
      repository: repo,
      action: "submitted",
      review: {
        ...reviewPayload("approved", "Looks fine."),
        user: { login: "acme-agent[bot]", id: 99 },
      },
      pull_request: { ...pr, user: { login: "sam" } },
    };

    it("reads as somebody else's approval while the setting names another App", async () => {
      expect("ignore" in (await normalizeGithubWebhook("pull_request_review", payload))).toBe(
        false,
      );
    });

    it("is ignored once the setting names the App as our own", async () => {
      expectIgnored(
        await githubInbound("pull_request_review", payload, {
          resolveActor: fakeLoginActor,
          deliveryId: "d1",
          ownLogins: ownGithubLogins("acme-agent"),
        }),
      );
    });
  });

  describe("our own inline comments", () => {
    it("are ignored, since they are our own review coming back", async () => {
      expectIgnored(
        await normalizeGithubWebhook("pull_request_review_comment", {
          action: "created",
          comment: {
            id: 77,
            body: "BLOCKING: this drops the error",
            path: "src/login.ts",
            line: 42,
            user: { ...OUR_APP, type: "Bot" },
            pull_request_review_id: 501,
          },
          pull_request: { ...pr, user: { login: OUR_APP.login } },
        }),
      );
    });
  });
});

describe("github reviews from another App", () => {
  describe("a review GitHub associates with nobody, as it does for every App", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: {
            ...reviewPayload("changes_requested", "Two problems."),
            user: REVIEWING_APP,
          },
          pull_request: pr,
        }),
      ).event;
    });

    it("becomes a review", () => {
      expect(event.kind).toBe("feedback");
    });

    it("vouches for the App as the actor", () => {
      expect(event.actor?.person_id).toBe("p_coderabbitai[bot]");
    });

    it("names the App as the reviewer", () => {
      expect(event.pull).toMatchObject({ reviewer: "coderabbitai[bot]", review_id: 501 });
    });

    it("says the reviewer is an App", () => {
      expect(event.pull).toMatchObject({ reviewer_is_app: true });
    });
  });

  describe("a review whose payload leaves the user type out", () => {
    it("reads the App by its login", async () => {
      const { event } = expectEvent(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: {
            ...reviewPayload("commented", "One problem."),
            user: { login: "coderabbitai[bot]", id: 99 },
          },
          pull_request: pr,
        }),
      );
      expect(event.actor?.person_id).toBe("p_coderabbitai[bot]");
    });
  });

  describe("an inline comment from a reviewing App", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalizeGithubWebhook("pull_request_review_comment", {
          action: "created",
          comment: {
            id: 77,
            body: "this drops the error",
            path: "src/login.ts",
            line: 42,
            user: REVIEWING_APP,
            pull_request_review_id: 501,
          },
          pull_request: pr,
        }),
      ).event;
    });

    it("vouches for the App as the actor", () => {
      expect(event.actor?.person_id).toBe("p_coderabbitai[bot]");
    });

    it("carries the comment with its file and line", () => {
      expect(event.pull).toMatchObject({
        comments: [{ id: 77, path: "src/login.ts", line: 42, body: "this drops the error" }],
      });
    });

    it("carries the id of the review that holds the comment", () => {
      expect(event.pull).toMatchObject({ review_id: 501 });
    });
  });
});

const authorizeNobody = async () => null;

describe("github feedback from a person who is not authorized", () => {
  describe("a review", () => {
    it("is ignored", async () => {
      expect(
        await normalizeGithubWebhook(
          "pull_request_review",
          { action: "submitted", review: reviewPayload("approved", ""), pull_request: pr },
          authorizeNobody,
        ),
      ).toEqual({ ignore: "author is not authorized" });
    });
  });

  describe("an inline comment", () => {
    it("is ignored", async () => {
      expect(
        await normalizeGithubWebhook(
          "pull_request_review_comment",
          { action: "created", comment: { id: 77, body: "nit", user: sam }, pull_request: pr },
          authorizeNobody,
        ),
      ).toEqual({ ignore: "author is not authorized" });
    });
  });

  describe("a comment on the pull request conversation", () => {
    it("is ignored", async () => {
      expect(
        await normalizeGithubWebhook(
          "issue_comment",
          {
            action: "created",
            issue: { number: 7, pull_request: {}, html_url: pr.html_url },
            comment: { id: 88, body: "/approve", user: sam },
          },
          authorizeNobody,
        ),
      ).toEqual({ ignore: "author is not authorized" });
    });
  });
});

describe("who the github mapper asks about", () => {
  let asked: CodeUser[];

  const recordAsked: CodeActorResolver = (user) => {
    asked.push(user);
    return fakeLoginActor(user);
  };

  beforeEach(() => {
    asked = [];
  });

  describe("a review from a person", () => {
    it("names the person on the repository of the webhook", async () => {
      await normalizeGithubWebhook(
        "pull_request_review",
        { action: "submitted", review: reviewPayload("approved", ""), pull_request: pr },
        recordAsked,
      );
      expect(asked).toEqual([{ login: "sam", repo: "acme/app", app: false }]);
    });
  });

  describe("a review from an App", () => {
    it("names the author as an App", async () => {
      await normalizeGithubWebhook(
        "pull_request_review",
        {
          action: "submitted",
          review: { ...reviewPayload("commented", "One problem."), user: REVIEWING_APP },
          pull_request: pr,
        },
        recordAsked,
      );
      expect(asked).toEqual([{ login: "coderabbitai[bot]", repo: "acme/app", app: true }]);
    });
  });

  describe("a conversation comment from a person", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalizeGithubWebhook(
          "issue_comment",
          {
            action: "created",
            issue: { number: 7, pull_request: {}, html_url: pr.html_url },
            comment: { id: 88, body: "/approve", user: sam },
          },
          recordAsked,
        ),
      ).event;
    });

    it("names the person on the repository of the webhook", () => {
      expect(asked).toEqual([{ login: "sam", repo: "acme/app", app: false }]);
    });

    it("carries the comment id", () => {
      expect(event.pull).toMatchObject({ comment_id: 88 });
    });

    it("binds to the pull request", () => {
      expect(event.bindings).toEqual([{ source: "code_pull", repo: "acme/app", number: 7 }]);
    });
  });
});
