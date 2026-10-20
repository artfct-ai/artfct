import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  NOTION_TEST_BOT as BOT,
  notionTestComment as comment,
  notionTestHeldIds as heldIds,
} from "../../../test/notion-comments";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { NOTION_ACKNOWLEDGEMENT } from "./held-comments";

const RUNS = 100;

describe("notionHeldComments on any thread of comments", () => {
  const anyComment = fc.record({
    commentThread: fc.constantFrom("d1", "d2", "d3"),
    author: fc.constantFrom(BOT, "ann", "bob"),
    text: fc.constantFrom(
      NOTION_ACKNOWLEDGEMENT,
      "Tighten the intro.",
      "Review: findings\n\n- Rollout: no owner.",
      '"Each team owns its rollout": Rollout: no owner.',
    ),
  });
  const anyThread = fc
    .array(anyComment, { maxLength: 12 })
    .map((comments) => comments.map((options, index) => comment({ id: `c${index}`, ...options })));

  it(
    "never holds a comment the bot wrote",
    () => {
      fc.assert(
        fc.property(anyThread, (comments) => {
          const botIds = new Set(
            comments.filter((listed) => listed.created_by.id === BOT).map((listed) => listed.id),
          );
          expect(heldIds(comments).filter((id) => botIds.has(id))).toEqual([]);
        }),
        propertyRuns("notion held comments", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
