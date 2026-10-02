import { beforeEach, describe, expect, it } from "bun:test";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import {
  expectEvent,
  expectIgnored,
  forkPr,
  normalizeGithubWebhook,
  pr,
  reviewPayload,
  sam,
} from "../../../test/github-inbound-fixtures";

describe("github reviews", () => {
  describe("a review that requests changes", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: reviewPayload("changes_requested", "Add a test."),
          pull_request: pr,
        }),
      ).event;
    });

    it("becomes a review", () => {
      expect(event.kind).toBe("feedback");
    });

    it("carries the review body as the text", () => {
      expect(event.text).toBe("Add a test.");
    });

    it("names the reviewer and the review id", () => {
      expect(event.pull).toMatchObject({ action: "review", reviewer: "sam", review_id: 501 });
    });

    it("says the reviewer is not an App", () => {
      expect(event.pull).toMatchObject({ reviewer_is_app: false });
    });

    it("names the reviewer as the actor", () => {
      expect(event.actor?.person_id).toBe("p_sam");
    });
  });

  describe("a review that requests changes with an empty body", () => {
    it("is kept, since the inline comments carry the content", async () => {
      const { event } = expectEvent(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: reviewPayload("changes_requested", ""),
          pull_request: pr,
        }),
      );
      expect(event.kind).toBe("feedback");
    });
  });

  describe("a review that only comments, the same signal as one that requests changes", () => {
    describe("with the whole content in its top level body", () => {
      let event: InboundEvent;

      beforeEach(async () => {
        const normalized = expectEvent(
          await normalizeGithubWebhook("pull_request_review", {
            action: "submitted",
            review: reviewPayload("commented", "This is a ton of unneeded complexity."),
            pull_request: pr,
          }),
        );
        event = normalized.event;
      });

      it("becomes a review", () => {
        expect(event.kind).toBe("feedback");
      });

      it("carries the review body as the text", () => {
        expect(event.text).toBe("This is a ton of unneeded complexity.");
      });

      it("names the reviewer and the review id", () => {
        expect(event.pull).toMatchObject({ action: "review", reviewer: "sam", review_id: 501 });
      });

      it("names the reviewer as the actor", () => {
        expect(event.actor?.person_id).toBe("p_sam");
      });
    });

    describe("with the whole content in its inline comments", () => {
      let event: InboundEvent;

      beforeEach(async () => {
        const normalized = expectEvent(
          await normalizeGithubWebhook("pull_request_review", {
            action: "submitted",
            review: reviewPayload("commented", ""),
            pull_request: pr,
          }),
        );
        event = normalized.event;
      });

      it("becomes a review", () => {
        expect(event.kind).toBe("feedback");
      });

      it("keeps the review id, which lets the orchestrator read the missing comments", () => {
        expect(event.pull).toMatchObject({ action: "review", reviewer: "sam", review_id: 501 });
      });

      it("names the reviewer as the actor", () => {
        expect(event.actor?.person_id).toBe("p_sam");
      });
    });
  });

  describe("a review that approves", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      const normalized = expectEvent(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: reviewPayload("approved", ""),
          pull_request: pr,
        }),
      );
      event = normalized.event;
    });

    it("is a review too", () => {
      expect(event.kind).toBe("feedback");
    });

    it("binds to the pull request", () => {
      expect(event.bindings[0]).toEqual({ source: "code_pull", repo: "acme/app", number: 7 });
    });
  });
});

describe("github review comments from a person", () => {
  describe("an inline comment from a collaborator", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalizeGithubWebhook("pull_request_review_comment", {
          action: "created",
          comment: {
            id: 77,
            body: "nit",
            path: "a.ts",
            line: 3,
            user: sam,
            pull_request_review_id: 501,
          },
          pull_request: pr,
        }),
      ).event;
    });

    it("resolves the actor", () => {
      expect(event.actor?.person_id).toBe("p_sam");
    });

    it("carries the comment with its file and line", () => {
      expect(event.pull).toMatchObject({
        comments: [{ id: 77, path: "a.ts", line: 3, body: "nit" }],
      });
    });

    it("shares the id of the review that carries it, so the workflow handles them as one", () => {
      expect(event.pull).toMatchObject({ review_id: 501 });
    });
  });
});

describe("github reviews on pull requests the orchestrator does not own", () => {
  const feature = { ...pr, head: { ...pr.head, ref: "feature/x" } };

  describe("a pull request on a branch no task owns", () => {
    it("drops the review with the branch reason", async () => {
      expect(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: reviewPayload("commented", "Nice."),
          pull_request: feature,
        }),
      ).toEqual({ ignore: "not an orchestrator branch" });
    });

    it("drops the inline comment too", async () => {
      expectIgnored(
        await normalizeGithubWebhook("pull_request_review_comment", {
          action: "created",
          comment: { id: 77, body: "nit", user: sam },
          pull_request: feature,
        }),
      );
    });
  });

  describe("a pull request from a fork", () => {
    it("drops the review", async () => {
      expectIgnored(
        await normalizeGithubWebhook("pull_request_review", {
          action: "submitted",
          review: reviewPayload("approved", ""),
          pull_request: forkPr,
        }),
      );
    });
  });
});
