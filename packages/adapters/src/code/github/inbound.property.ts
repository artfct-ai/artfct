import { describe, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { fakeLoginActor } from "../../../test/fake-actors";
import { branch, pr, repo, sam } from "../../../test/github-inbound-fixtures";
import { inboundMapperNeverThrows, mapperOutcome } from "../../../test/inbound-invariants";
import { anyJsonValue, mutatedPayload } from "../../../test/payload-mutations";
import { githubInbound } from "./inbound";
import { ownGithubLogins } from "./inbound-shared";

const RUNS = 100;

const pullRequest = { ...pr, user: { login: "artfct[bot]", type: "Bot" }, merged: false };

const realWebhooks: Record<string, Record<string, unknown>> = {
  pull_request: { action: "opened", pull_request: pullRequest, sender: sam },
  pull_request_review: {
    action: "submitted",
    pull_request: pullRequest,
    review: { id: 501, state: "changes_requested", body: "rename it", user: sam },
  },
  pull_request_review_comment: {
    action: "created",
    pull_request: pullRequest,
    comment: {
      id: 77,
      body: "typo",
      path: "src/app.ts",
      line: 12,
      original_line: 12,
      pull_request_review_id: 501,
      user: sam,
    },
  },
  issue_comment: {
    action: "created",
    issue: { number: 7, pull_request: {}, html_url: pr.html_url },
    comment: { id: 78, body: "please also add a test", user: sam },
  },
  check_suite: {
    action: "completed",
    check_suite: {
      conclusion: "failure",
      head_branch: branch,
      pull_requests: [{ number: 7 }],
      app: { name: "CI" },
    },
  },
  check_run: {
    action: "completed",
    check_run: {
      name: "test",
      conclusion: "failure",
      check_suite: { head_branch: branch },
      pull_requests: [{ number: 7 }],
      html_url: "https://github.com/acme/app/runs/1",
      output: { title: "1 failing", summary: "login.test.ts" },
    },
  },
  push: { ref: "refs/heads/main", after: "def" },
};

const anyEventName = fc.oneof(
  fc.constantFrom(...Object.keys(realWebhooks), "ping", "release"),
  fc.string(),
);

async function checkWebhook(eventName: string, payload: unknown): Promise<void> {
  const context = {
    resolveActor: fakeLoginActor,
    deliveryId: "d1",
    ownLogins: ownGithubLogins("artfct"),
  };
  inboundMapperNeverThrows(await mapperOutcome(() => githubInbound(eventName, payload, context)));
}

describe("github inbound mapper invariants", () => {
  for (const [name, payload] of Object.entries(realWebhooks)) {
    it(
      `hold for a ${name} webhook with fields removed or retyped`,
      async () => {
        const eventName = fc.oneof({ weight: 4, arbitrary: fc.constant(name) }, anyEventName);
        await fc.assert(
          fc.asyncProperty(
            eventName,
            mutatedPayload({ repository: repo, ...payload }),
            checkWebhook,
          ),
          propertyRuns(`github ${name}`, RUNS),
        );
      },
      propertyTimeoutMs(5_000, RUNS),
    );
  }

  it(
    "hold for a JSON value of any shape",
    async () => {
      await fc.assert(
        fc.asyncProperty(anyEventName, anyJsonValue, checkWebhook),
        propertyRuns("github any JSON", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
