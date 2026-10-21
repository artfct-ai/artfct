import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import { githubPost, harness } from "../../test/app-harness";
import { githubPullRequest } from "../../test/webhook-fixtures";

const RUNS = 100;

const pullRequestCase = fc.record({
  action: fc.constantFrom("closed", "reopened", "synchronize", "ready_for_review", "opened"),
  merged: fc.boolean(),
  deliverTicks: fc.integer({ min: 0, max: 8 }),
});

function vendorEventWaitsForTheDelivery(
  timeline: ReadonlyArray<"deliver returned" | "deliverVendorEvent">,
  action: string,
): void {
  const handedOver = timeline.indexOf("deliverVendorEvent");
  const returned = timeline.indexOf("deliver returned");
  if (handedOver === -1 || returned === -1 || returned < handedOver) return;
  throw new Error(
    `routerBindings::aClosedPullRequestEndsItsWatchers: the ${action} event went to the firings before its delivery returned: [${timeline.join(", ")}]`,
  );
}

describe("GitHub route", () => {
  it(
    "hands a pull request event to the firings only after its delivery returned",
    async () => {
      let both = 0;
      await fc.assert(
        fc.asyncProperty(pullRequestCase, async ({ action, merged, deliverTicks }) => {
          const app = harness({ deliverTicks });
          const body = JSON.stringify(githubPullRequest(action, { merged }));
          const response = await app.request(
            await githubPost(body, {
              "x-github-event": "pull_request",
              "x-github-delivery": "delivery-1",
            }),
          );
          expect(response.status).toBe(200);
          if (app.rpc.timeline.length === 2) both++;
          vendorEventWaitsForTheDelivery(app.rpc.timeline, action);
        }),
        propertyRuns("github route order", RUNS),
      );
      expect(both).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
