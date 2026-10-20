import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import {
  LINEAR_ACKNOWLEDGEMENT_EMOJI,
  linearHeldComments,
  type LinearDocumentComment,
} from "./held-comments";

const RUNS = 100;

const SELF = "app1";

const anyUser = fc.constantFrom(
  null,
  { id: SELF, name: "artfct" },
  { id: "u1", name: "Ann" },
  { id: "u2", name: "Bob" },
);

const anyReaction = fc.record({
  emoji: fc.constantFrom(LINEAR_ACKNOWLEDGEMENT_EMOJI, "thumbsup"),
  user: fc.constantFrom(null, { id: SELF }, { id: "u1" }),
});

const anyResolvedAt = fc.constantFrom(null, "2026-09-02T00:00:00.000Z");

const anyComments: fc.Arbitrary<LinearDocumentComment[]> = fc
  .array(
    fc.record({
      body: fc.constantFrom("Tighten the intro.", '"Each team owns it": Rollout: no owner.'),
      resolvedAt: anyResolvedAt,
      parent: fc.option(fc.record({ resolvedAt: anyResolvedAt })),
      user: anyUser,
      reactions: fc.array(anyReaction, { maxLength: 3 }),
    }),
    { maxLength: 12 },
  )
  .map((comments) => comments.map((fields, index) => ({ id: `c${index}`, ...fields })));

describe("linearHeldComments on any list of comments", () => {
  it(
    "never holds a comment this user wrote",
    () => {
      fc.assert(
        fc.property(anyComments, (comments) => {
          const ownIds = new Set(
            comments.filter((listed) => listed.user?.id === SELF).map((listed) => listed.id),
          );
          const held = linearHeldComments(comments, SELF).map((comment) => comment.id);
          expect(held.filter((id) => ownIds.has(id))).toEqual([]);
        }),
        propertyRuns("linear held comments", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
