import type { JsonValue } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { ownGithubLogins } from "./inbound-shared";
import { githubVendorEvent } from "./vendor-event";
import {
  githubEventOfVendorEventName,
  githubVendorEventName,
  isGithubPullRequestEventName,
} from "./vendor-event-name";

const CONTEXT = { deliveryId: "d-1", ownLogins: ownGithubLogins("orchestrator-app") };
const repository = { full_name: "acme/app" };
const sam = { login: "sam", type: "User" };
const pullRequest = {
  number: 12,
  head: { ref: "feature/x", repo: { full_name: "acme/app" } },
  base: { ref: "main" },
};

function vendorEvent(githubEvent: string, payload: JsonValue) {
  return githubVendorEvent(githubEvent, payload, CONTEXT);
}

describe("githubVendorEventName", () => {
  it("joins the event and its action", () => {
    expect(githubVendorEventName("pull_request", { action: "opened" })).toBe(
      "github.pull_request.opened",
    );
  });

  it("keeps the vendor's case", () => {
    expect(githubVendorEventName("workflow_run", { action: "Completed" })).toBe(
      "github.workflow_run.Completed",
    );
  });

  it("names an event without an action by the event alone", () => {
    expect(githubVendorEventName("push", { ref: "refs/heads/main" })).toBe("github.push");
  });
});

describe("githubEventOfVendorEventName", () => {
  it("reads back the event of a name with an action", () => {
    expect(
      githubEventOfVendorEventName(githubVendorEventName("check_run", { action: "completed" })),
    ).toBe("check_run");
  });

  it("reads back the event of a name without an action", () => {
    expect(githubEventOfVendorEventName(githubVendorEventName("push", {}))).toBe("push");
  });

  it("does not read another vendor's name", () => {
    expect(githubEventOfVendorEventName("slack.member_joined_channel")).toBeNull();
  });
});

describe("isGithubPullRequestEventName", () => {
  it("holds for a pull request event", () => {
    expect(isGithubPullRequestEventName("github.pull_request.closed")).toBe(true);
  });

  it("does not hold for a review event", () => {
    expect(isGithubPullRequestEventName("github.pull_request_review.dismissed")).toBe(false);
  });
});

describe("githubVendorEvent", () => {
  it("passes a pull request event through with its pull request", () => {
    const payload = { action: "opened", repository, sender: sam, pull_request: pullRequest };
    expect(vendorEvent("pull_request", payload)).toEqual({
      event: {
        delivery_id: "d-1",
        name: "github.pull_request.opened",
        payload,
        causer: { source: "code", user: { login: "sam", repo: "acme/app", app: false } },
        about_app: false,
        enrichment: { kind: "pull_request", repo: "acme/app", number: 12 },
      },
    });
  });

  it("passes another event through without a pull request", () => {
    const payload = { action: "published", repository, sender: sam, release: { tag_name: "v1" } };
    const mapped = vendorEvent("release", payload);
    expect(mapped).toMatchObject({ event: { name: "github.release.published" } });
    expect("event" in mapped && mapped.event.enrichment).toBeUndefined();
  });

  it("names a review event's pull request only as payload", () => {
    const payload = { action: "dismissed", repository, sender: sam, pull_request: pullRequest };
    const mapped = vendorEvent("pull_request_review", payload);
    expect("event" in mapped && mapped.event.enrichment).toBeUndefined();
  });

  it.each([
    ["issue_comment", "created"],
    ["pull_request_review", "submitted"],
    ["pull_request_review_comment", "created"],
  ])("drops the conversational event %s.%s", (githubEvent, action) => {
    const payload = { action, repository, sender: sam, pull_request: pullRequest };
    expect(vendorEvent(githubEvent, payload)).toEqual({ drop: "conversational" });
  });

  it("drops an event the deployment's own App caused", () => {
    const payload = {
      action: "opened",
      repository,
      sender: { login: "orchestrator-app[bot]", type: "Bot" },
      pull_request: pullRequest,
    };
    expect(vendorEvent("pull_request", payload)).toEqual({ drop: "caused by the app" });
  });

  it("passes an event another App caused", () => {
    const payload = {
      action: "opened",
      repository,
      sender: { login: "renovate[bot]", type: "Bot" },
      pull_request: pullRequest,
    };
    expect(vendorEvent("pull_request", payload)).toMatchObject({
      event: { causer: { user: { login: "renovate[bot]", app: true } } },
    });
  });

  it("drops a pull request from a fork", () => {
    const fork = {
      ...pullRequest,
      head: { ...pullRequest.head, repo: { full_name: "mallory/app" } },
    };
    const payload = { action: "opened", repository, sender: sam, pull_request: fork };
    expect(vendorEvent("pull_request", payload)).toEqual({ drop: "pull request from a fork" });
  });

  it("drops an event without a sender", () => {
    expect(vendorEvent("push", { repository })).toEqual({ drop: "no causer" });
  });

  it("drops an event without a repository", () => {
    expect(vendorEvent("installation", { action: "created", sender: sam })).toEqual({
      drop: "no repository",
    });
  });

  it("drops a payload whose known fields do not parse", () => {
    expect(vendorEvent("push", { repository: { full_name: 7 }, sender: sam })).toEqual({
      drop: "malformed github.push",
    });
  });
});
