import { describe, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { recordingUserActor } from "../../../test/fake-actors";
import { FakeDocuments } from "../../../test/fake-documents";
import {
  aConversationalEventNeverFires,
  actorEmailIsLowercase,
  anIgnoredVendorEventNeverFires,
  inboundMapperNeverThrows,
  mapperOutcome,
  type IgnoredVendorEventCause,
} from "../../../test/inbound-invariants";
import { anyCaseEmail, anyJsonValue, mutatedPayload } from "../../../test/payload-mutations";
import { notionConversationalEvents } from "./conversational-events";
import { notionInbound } from "./inbound";
import { notionVendorEvent } from "./vendor-event";
import type { ExternalUser, JsonValue } from "@artfct-ai/contracts/types";
import type { DocumentsInboundContext } from "../types";

const RUNS = 100;

const PAGE_ID = "1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5a6b";

const comment = {
  id: "evt1",
  timestamp: "2026-09-03T10:00:00.000Z",
  workspace_id: "ws1",
  subscription_id: "sub1",
  integration_id: "int1",
  attempt_number: 1,
  authors: [{ id: "n1", type: "person" }],
  entity: { id: "cmt1", type: "comment" },
  type: "comment.created",
};

const realPayloads: Record<string, Record<string, unknown>> = {
  "comment on a page": {
    ...comment,
    data: { page_id: PAGE_ID, parent: { id: PAGE_ID, type: "page" } },
  },
  "comment on a block": {
    ...comment,
    data: { page_id: PAGE_ID, parent: { id: "blk1", type: "block" } },
  },
  "page update": {
    ...comment,
    type: "page.content_updated",
    entity: { id: PAGE_ID, type: "page" },
    data: {},
  },
};

/** Where the host reports the author's email: on the comment, from a user fetch, or nowhere. */
const reportedEmail = fc.record({
  onComment: fc.option(anyCaseEmail),
  fetched: fc.option(anyCaseEmail),
});

async function checkPayload(
  payload: unknown,
  email: { onComment: string | null; fetched: string | null },
): Promise<void> {
  const asked: ExternalUser[] = [];
  const context: DocumentsInboundContext = {
    resolveActor: recordingUserActor(asked),
    documents: new FakeDocuments({
      comments: {
        cmt1: { text: "lgtm", author: { id: "n1", email: email.onComment }, mentions: [] },
      },
      emails: email.fetched ? { n1: email.fetched } : {},
    }),
  };
  inboundMapperNeverThrows(await mapperOutcome(() => notionInbound(payload, context)));
  actorEmailIsLowercase(asked);
  notionVendorEvent(payload as JsonValue);
}

const onPage = realPayloads["comment on a page"]!;

/** A payload of each shape Notion sends, under listed and unlisted names alike. */
const PAYLOADS_BY_SHAPE: Record<string, unknown>[] = [
  onPage,
  { ...onPage, type: "comment.updated" },
  { ...onPage, type: "comment.deleted" },
  realPayloads["page update"]!,
  { ...realPayloads["page update"], type: "page.created" },
  { ...realPayloads["page update"], type: "page.properties_updated" },
  { ...comment, type: "database.created", entity: { id: "db1", type: "database" }, data: {} },
];

/** Every way the pass-through must drop an event, and the event it must pass. */
const AUTHOR_SCENARIOS: Record<
  string,
  { ignoredBecause: IgnoredVendorEventCause | null; authors?: unknown }
> = {
  "a person": { ignoredBecause: null },
  "two people": {
    ignoredBecause: null,
    authors: [
      { id: "n1", type: "person" },
      { id: "n2", type: "person" },
    ],
  },
  "the app's own integration": {
    ignoredBecause: "caused_by_the_app",
    authors: [{ id: "bot1", type: "bot" }],
  },
  "a person and a bot": {
    ignoredBecause: "caused_by_the_app",
    authors: [
      { id: "n1", type: "person" },
      { id: "bot1", type: "bot" },
    ],
  },
  "a Notion agent": {
    ignoredBecause: "caused_by_the_app",
    authors: [{ id: "ag1", type: "agent" }],
  },
  "nobody named": { ignoredBecause: "no_causer", authors: [] },
  "a webhook without authors": { ignoredBecause: "no_causer", authors: undefined },
};

function nameOf(payload: Record<string, unknown>): string {
  return `notion.${String(payload.type)}`;
}

async function checkConversational(payload: Record<string, unknown>): Promise<void> {
  const name = nameOf(payload);
  const mapped = await notionInbound(payload, {
    resolveActor: recordingUserActor([]),
    documents: new FakeDocuments({
      comments: {
        cmt1: { text: "lgtm", author: { id: "n1", email: "dev@acme.test" }, mentions: [] },
      },
    }),
  });
  const passed = notionVendorEvent(payload as JsonValue);
  const conversational = (notionConversationalEvents as readonly string[]).includes(name);
  aConversationalEventNeverFires({ step: "mapper", name, conversational, value: mapped });
  aConversationalEventNeverFires({ step: "pass_through", name, conversational, value: passed });
}

function checkIgnored(base: Record<string, unknown>, scenarioName: string): void {
  const scenario = AUTHOR_SCENARIOS[scenarioName]!;
  const payload = { ...base, authors: "authors" in scenario ? scenario.authors : base.authors };
  const passed = notionVendorEvent(payload as JsonValue);
  if (scenario.ignoredBecause) anIgnoredVendorEventNeverFires(scenario.ignoredBecause, passed);
}

describe("notion inbound mapper invariants", () => {
  for (const [name, payload] of Object.entries(realPayloads)) {
    it(
      `hold for a ${name} webhook with fields removed or retyped`,
      async () => {
        await fc.assert(
          fc.asyncProperty(mutatedPayload(payload), reportedEmail, checkPayload),
          propertyRuns(`notion ${name}`, RUNS),
        );
      },
      propertyTimeoutMs(5_000, RUNS),
    );
  }

  it(
    "hold for a JSON value of any shape",
    async () => {
      await fc.assert(
        fc.asyncProperty(anyJsonValue, reportedEmail, checkPayload),
        propertyRuns("notion any JSON", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});

describe("notion vendor event invariants", () => {
  const listedAndUnlisted = fc.constantFrom(...PAYLOADS_BY_SHAPE);
  const unlisted = fc.constantFrom(
    ...PAYLOADS_BY_SHAPE.filter(
      (payload) => !(notionConversationalEvents as readonly string[]).includes(nameOf(payload)),
    ),
  );
  const scenario = fc.constantFrom(...Object.keys(AUTHOR_SCENARIOS));

  it(
    "hold aConversationalEventNeverFires for every listed and unlisted name",
    async () => {
      await fc.assert(
        fc.asyncProperty(listedAndUnlisted, checkConversational),
        propertyRuns("notion conversational events", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it("hold anIgnoredVendorEventNeverFires for bots and events without an author", () => {
    fc.assert(
      fc.property(unlisted, scenario, checkIgnored),
      propertyRuns("notion ignored vendor events", RUNS),
    );
  });
});
