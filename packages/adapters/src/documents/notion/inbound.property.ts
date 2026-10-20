import { describe, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { recordingUserActor } from "../../../test/fake-actors";
import { FakeDocuments } from "../../../test/fake-documents";
import {
  actorEmailIsLowercase,
  inboundMapperNeverThrows,
  mapperOutcome,
} from "../../../test/inbound-invariants";
import { anyCaseEmail, anyJsonValue, mutatedPayload } from "../../../test/payload-mutations";
import { notionInbound } from "./inbound";
import type { ExternalUser } from "@artfct-ai/contracts/types";
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

const realPayloads: Record<string, unknown> = {
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
