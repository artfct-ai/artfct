import { describe, expect, it } from "bun:test";
import { parseTurnTextReview, parseReview, reviewInstructions } from "./review-text";

function reviewComment(word: string): string {
  return [
    `Review: ${word}`,
    "The plan answers the request and names the risks.",
    "",
    "- Scope: the request asks for retries and the document adds a queue.",
    "- The rollout plan names no owner.",
  ].join("\n");
}

describe("a comment written the way the instructions say", () => {
  it("round trips a findings review", () => {
    expect(parseReview(reviewComment("findings"))).toEqual({
      blocking: false,
      summary: "The plan answers the request and names the risks.",
      findings: [
        {
          location: "Scope",
          body: "the request asks for retries and the document adds a queue.",
        },
        { body: "The rollout plan names no owner." },
      ],
    });
  });

  it("round trips a blocking review", () => {
    const parsed = parseReview(reviewComment("blocking"));
    expect(parsed?.blocking).toBe(true);
    expect(parsed?.findings).toHaveLength(2);
  });

  it("round trips an approval with no findings", () => {
    expect(parseReview("Review: approved\nThe design is ready.")).toEqual({
      blocking: false,
      summary: "The design is ready.",
      findings: [],
    });
  });

  it("drops findings written under an approval", () => {
    expect(parseReview(reviewComment("approved"))?.findings).toEqual([]);
  });
});

describe("the instructions", () => {
  it("show a comment the parser accepts", () => {
    const shown =
      reviewInstructions("Post one comment on the page in this shape:").split("```")[1] ?? "";
    expect(parseReview(shown.trim())).toEqual({
      blocking: false,
      summary: "One short paragraph on the document as a whole.",
      findings: [
        { location: "Scope", body: "the request asks for X and the document answers Y." },
        { body: "The rollout plan names no owner." },
      ],
    });
  });

  it("names every review word", () => {
    const text = reviewInstructions("Post one comment on the page in this shape:");
    for (const word of ["approved", "findings", "blocking"]) {
      expect(text).toContain(`Review: ${word}`);
    }
  });
});

describe("a comment that is not a review", () => {
  it("is null when the first line says something else", () => {
    expect(parseReview("Nice work on this.\n- One nit.")).toBeNull();
  });

  it("is null when the review line is not first", () => {
    expect(parseReview("Some preamble.\nReview: blocking")).toBeNull();
  });

  it("is null for an empty comment", () => {
    expect(parseReview("   \n\n")).toBeNull();
  });

  it("is null for an unknown review word", () => {
    expect(parseReview("Review: unsure\nMaybe.")).toBeNull();
  });
});

describe("markdown noise around the review line", () => {
  it("reads a heading", () => {
    expect(parseReview("## Review: blocking\nFix it.")?.blocking).toBe(true);
  });

  it("reads a bold line", () => {
    expect(parseReview("**Review: findings**\nSome notes.")?.blocking).toBe(false);
  });

  it("reads a bullet", () => {
    expect(parseReview("- Review: approved")?.findings).toEqual([]);
  });

  it("reads a quoted line after blank lines", () => {
    expect(parseReview("\n\n> Review: blocking\nFix it.")?.blocking).toBe(true);
  });

  it("reads the word in any case", () => {
    expect(parseReview("REVIEW: BLOCKING\nFix it.")?.blocking).toBe(true);
  });
});

describe("a review with nothing but findings", () => {
  it("has a blank summary", () => {
    const parsed = parseReview("Review: findings\n\n- The API section is missing.");
    expect(parsed?.summary).toBe("");
    expect(parsed?.findings).toEqual([{ body: "The API section is missing." }]);
  });
});

describe("a finding without a location", () => {
  it("keeps a sentence that contains a colon whole", () => {
    const parsed = parseReview(
      "Review: findings\n\n- The plan skips a step. Retries: it never says how many.",
    );
    expect(parsed?.findings).toEqual([
      { body: "The plan skips a step. Retries: it never says how many." },
    ]);
  });

  it("keeps a long prefix out of the location", () => {
    const long = "a".repeat(61);
    const parsed = parseReview(`Review: findings\n\n- ${long}: and then some.`);
    expect(parsed?.findings).toEqual([{ body: `${long}: and then some.` }]);
  });

  it("takes a star bullet too", () => {
    expect(parseReview("Review: findings\n\n* No owner.")?.findings).toEqual([
      { body: "No owner." },
    ]);
  });
});

describe("the instructions for a turn text", () => {
  it("says where the block goes", () => {
    expect(reviewInstructions("End the text of your turn with this block:")).toContain(
      "End the text of your turn with this block:",
    );
  });
});

describe("a turn text that ends with a review", () => {
  it("reads the block after the reviewer's own prose", () => {
    const turnText = [
      "I read the project and every issue in it.",
      "",
      "Review: findings",
      "Two issues carry more than one pull request.",
      "",
      "- ENG-42: it bundles the migration and the endpoint.",
    ].join("\n");
    expect(parseTurnTextReview(turnText)).toEqual({
      blocking: false,
      summary: "Two issues carry more than one pull request.",
      findings: [{ location: "ENG-42", body: "it bundles the migration and the endpoint." }],
    });
  });

  it("reads the last review line when the message names more than one", () => {
    const turnText = ["Review: blocking was my first read.", "", "Review: approved"].join("\n");
    expect(parseTurnTextReview(turnText)).toEqual({
      blocking: false,
      summary: "",
      findings: [],
    });
  });

  it("is null when the message carries no review line", () => {
    expect(parseTurnTextReview("I read the issues and left them alone.")).toBeNull();
  });

  it("is null for an empty message", () => {
    expect(parseTurnTextReview("")).toBeNull();
  });
});
