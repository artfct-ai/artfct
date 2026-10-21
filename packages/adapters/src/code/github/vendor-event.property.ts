import type { JsonValue } from "@artfct-ai/contracts/types";
import { describe, it } from "bun:test";
import fc from "fast-check";
import { fakeLoginActor } from "../../../test/fake-actors";
import { pr, repo } from "../../../test/github-inbound-fixtures";
import {
  aConversationalEventNeverFires,
  anIgnoredVendorEventNeverFires,
  type IgnoredVendorEventCause,
} from "../../../test/inbound-invariants";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { isGithubConversationalEvent } from "./conversational-events";
import { githubInbound } from "./inbound";
import { ownGithubLogins } from "./inbound-shared";
import { githubVendorEvent } from "./vendor-event";
import { githubVendorEventName } from "./vendor-event-name";

const RUNS = 200;
const OWN_LOGINS = ownGithubLogins("artfct");

const ACTIONS_BY_EVENT: Record<string, string[]> = {
  pull_request: ["opened", "closed", "synchronize", "ready_for_review", "labeled"],
  pull_request_review: ["submitted", "edited", "dismissed"],
  pull_request_review_comment: ["created", "edited", "deleted"],
  issue_comment: ["created", "edited", "deleted"],
  check_run: ["completed", "created"],
  workflow_run: ["completed", "requested"],
  release: ["published"],
};

const person = { login: "sam", type: "User" };

const SENDERS = {
  person,
  anotherApp: { login: "ci-helper[bot]", type: "Bot" },
  theApp: { login: OWN_LOGINS[0]!, type: "Bot" },
} as const;

type Delivery = {
  header: string;
  action: string | null;
  sender: keyof typeof SENDERS | null;
  pull: "same_repository" | "fork" | null;
};

const anyHeaderAndAction: fc.Arbitrary<Pick<Delivery, "header" | "action">> = fc.oneof(
  fc.constantFrom(...Object.entries(ACTIONS_BY_EVENT)).chain(([header, actions]) =>
    fc.record({
      header: fc.constant(header),
      action: fc.oneof(fc.constantFrom(...actions), fc.string({ maxLength: 12 })),
    }),
  ),
  fc.record({ header: fc.constant("push"), action: fc.constant(null) }),
  fc.record({
    header: fc.string({ maxLength: 20 }),
    action: fc.option(fc.string({ maxLength: 12 })),
  }),
);

const anyDelivery: fc.Arbitrary<Delivery> = fc
  .tuple(
    anyHeaderAndAction,
    fc.option(fc.constantFrom(...(Object.keys(SENDERS) as Array<keyof typeof SENDERS>)), {
      freq: 5,
    }),
    fc.option(fc.constantFrom("same_repository" as const, "fork" as const), { freq: 3 }),
  )
  .map(([headerAndAction, sender, pull]) => ({ ...headerAndAction, sender, pull }));

function payloadOf(delivery: Delivery): JsonValue {
  const headRepo = delivery.pull === "fork" ? "mallory/app" : repo.full_name;
  return {
    ...(delivery.action === null ? {} : { action: delivery.action }),
    repository: repo,
    ...(delivery.sender === null ? {} : { sender: SENDERS[delivery.sender] }),
    ...(delivery.pull === null
      ? {}
      : { pull_request: { ...pr, head: { ...pr.head, repo: { full_name: headRepo } } } }),
    issue: { number: pr.number, pull_request: {}, html_url: pr.html_url },
    review: { id: 501, state: "commented", body: "rename it", user: person },
    comment: { id: 78, body: "please also add a test", path: "src/app.ts", line: 3, user: person },
  };
}

function ignoredCauseOf(delivery: Delivery): IgnoredVendorEventCause | null {
  if (delivery.sender === null) return "no_causer";
  if (delivery.sender === "theApp") return "caused_by_the_app";
  if (delivery.pull === "fork") return "fork";
  return null;
}

async function checkDelivery(delivery: Delivery): Promise<void> {
  const payload = payloadOf(delivery);
  const name = githubVendorEventName(delivery.header, payload);
  const conversational = isGithubConversationalEvent(name);
  const passed = githubVendorEvent(delivery.header, payload, {
    deliveryId: "d1",
    ownLogins: OWN_LOGINS,
  });
  aConversationalEventNeverFires({ step: "pass_through", name, conversational, value: passed });
  const cause = ignoredCauseOf(delivery);
  if (cause) anIgnoredVendorEventNeverFires(cause, passed);
  const mapped = await githubInbound(delivery.header, payload, {
    resolveActor: fakeLoginActor,
    deliveryId: "d1",
    ownLogins: OWN_LOGINS,
  });
  aConversationalEventNeverFires({ step: "mapper", name, conversational, value: mapped });
}

describe("github vendor event invariants", () => {
  it(
    "hold for any delivery by a person, another App, the app or nobody, from the repository or a fork",
    async () => {
      await fc.assert(
        fc.asyncProperty(anyDelivery, checkDelivery),
        propertyRuns("github vendor events", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
