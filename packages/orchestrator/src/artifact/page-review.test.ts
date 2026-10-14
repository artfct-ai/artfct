import type { PassageComment } from "@artfct-ai/adapters/documents/types";
import { describe, expect, it } from "bun:test";
import { pageReviewOutcome, postPageReview, type PageReviewHost } from "./page-review";
import type { ParsedReview } from "./review-text";

const SIGNATURE = "Reviewer: facts · run 1 · task t9";
const ON_ROLLOUT = {
  passage: "Each team owns its rollout",
  location: "Rollout",
  body: "No owner.",
};
const ON_METRIC = { passage: "Latency drops", body: "Which percentile?" };
const ON_PAGE = { body: "The page names no metric." };
const REVIEW: ParsedReview = {
  blocking: false,
  summary: "Close.",
  findings: [ON_ROLLOUT, ON_PAGE, ON_METRIC],
};

type Sent = { inline: PassageComment[]; page: string[]; lines: string[] };

function host(
  inline: (comments: PassageComment[]) => Promise<PassageComment[]>,
  page: "takes" | "down" = "takes",
): { host: PageReviewHost; sent: Sent } {
  const sent: Sent = { inline: [], page: [], lines: [] };
  return {
    sent,
    host: {
      commentOnPassages: async (_pageId, comments) => {
        const unposted = await inline(comments);
        sent.inline.push(...comments.filter((comment) => !unposted.includes(comment)));
        return unposted;
      },
      comment: async (_pageId, text) => {
        if (page === "down") throw new Error("docs host down");
        sent.page.push(text);
      },
      log: (line) => sent.lines.push(line),
    },
  };
}

const post = (pageHost: PageReviewHost, review: ParsedReview = REVIEW) =>
  postPageReview(pageHost, { pageId: "p1", review, signature: SIGNATURE });

describe("postPageReview", () => {
  it("posts each quoted finding on its passage, signed", async () => {
    const { host: pageHost, sent } = host(async () => []);
    await post(pageHost);
    expect(sent.inline).toEqual([
      {
        passage: "Each team owns its rollout",
        text: `"Each team owns its rollout": Rollout: No owner.\n\n${SIGNATURE}`,
      },
      { passage: "Latency drops", text: `"Latency drops": Which percentile?\n\n${SIGNATURE}` },
    ]);
  });

  it("puts the outcome and the finding without a passage in one page comment", async () => {
    const { host: pageHost, sent } = host(async () => []);
    await post(pageHost);
    expect(sent.page).toEqual([
      [
        "Review: findings\nClose.",
        "2 findings are on the blocks they quote.",
        "- The page names no metric.",
        SIGNATURE,
      ].join("\n\n"),
    ]);
  });

  it("moves a finding the host could not anchor into the page comment", async () => {
    const { host: pageHost, sent } = host(async (comments) => comments.slice(1));
    await post(pageHost);
    expect(sent.page[0]).toContain("1 finding is on the block it quotes.");
    expect(sent.page[0]).toContain(
      '- The page names no metric.\n- "Latency drops": Which percentile?',
    );
  });

  it("puts every finding in the page comment when the inline comments fail", async () => {
    const { host: pageHost, sent } = host(async () => {
      throw new Error("docs host down");
    });
    await post(pageHost);
    expect(sent.page[0]).not.toContain("on the block");
    expect(sent.page[0]).toContain('- "Each team owns its rollout": Rollout: No owner.');
    expect(sent.lines.join(" ")).toContain("docs host down");
  });

  it("does not ask for inline comments when no finding quotes a passage", async () => {
    let asked = false;
    const { host: pageHost } = host(async () => {
      asked = true;
      return [];
    });
    await post(pageHost, { ...REVIEW, findings: [ON_PAGE] });
    expect(asked).toBe(false);
  });

  it("logs a page comment the host did not take and does not throw", async () => {
    const { host: pageHost, sent } = host(async () => [], "down");
    await expect(post(pageHost)).resolves.toBeUndefined();
    expect(sent.lines.join(" ")).toContain("page review comment failed");
  });
});

describe("pageReviewOutcome", () => {
  it("opens an approval with its review line and signs it", () => {
    expect(
      pageReviewOutcome({
        review: { blocking: false, summary: "", findings: [] },
        inlineCount: 0,
        pageFindings: [],
        signature: SIGNATURE,
      }),
    ).toBe(`Review: approved\n\n${SIGNATURE}`);
  });

  it("names a blocking review", () => {
    const outcome = pageReviewOutcome({
      review: { ...REVIEW, blocking: true },
      inlineCount: 3,
      pageFindings: [],
      signature: SIGNATURE,
    });
    expect(outcome.startsWith("Review: blocking\nClose.\n\n3 findings")).toBe(true);
  });
});
