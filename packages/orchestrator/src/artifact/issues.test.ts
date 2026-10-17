import { describe, expect, it } from "bun:test";
import { issuesArtifact, type IssuesClients } from "./issues";
import type { Artifact } from "./types";

const ISSUE_URL = "https://linear.app/acme/issue/ENG-1/title";
const PROJECT_URL = "https://linear.app/acme/project/checkout-0a1b2c3d4e5f";

function build(): Artifact {
  const clients: IssuesClients = {
    readUrl: async (url) => {
      if (url === ISSUE_URL) return { kind: "issue", issue_id: "i1", issue_key: "ENG-1" };
      if (url === PROJECT_URL) return { kind: "project", project_id: "p1" };
      return null;
    },
    mcp: () => null,
    instructions: {
      create: "File the issues.",
      read: "Read every issue.",
      change: "Change the issues in place.",
    },
    notes: "Clone what you need.",
  };
  return issuesArtifact(clients);
}

describe("detect", () => {
  it("points at the issue the author ended with", async () => {
    expect(await build().detect(`Filed ${ISSUE_URL}`)).toEqual({
      url: ISSUE_URL,
      ref: { kind: "issue", issue_id: "i1", issue_key: "ENG-1" },
    });
  });

  it("points at the project the author ended with", async () => {
    expect(await build().detect(`Filed the issues in ${PROJECT_URL}`)).toEqual({
      url: PROJECT_URL,
      ref: { kind: "project", project_id: "p1" },
    });
  });

  it("ignores a link of another host", async () => {
    expect(await build().detect("Filed https://example.com/x")).toBeNull();
  });
});

describe("binding", () => {
  it("binds nothing, since each issue is already bound on its own", () => {
    expect(build().binding({ kind: "project", project_id: "p1" })).toBeNull();
  });
});

describe("agent review", () => {
  const review = build().review!;

  it("has no place to post a rejection", () => {
    expect(review.postRejection).toBeNull();
  });

  it("reads the review out of the reviewer's turn text", async () => {
    const turnText = ["Read them all.", "", "Review: findings", "- ENG-1: no outcome."].join("\n");
    expect(
      await review.postedReview(
        { kind: "project", project_id: "p1" },
        { since: "", turnText, signature: "" },
      ),
    ).toEqual({
      revision: null,
      blocking: false,
      summary: "",
      findings: [{ location: "ENG-1", body: "no outcome." }],
    });
  });

  it("files nothing when the turn text carries no review", async () => {
    expect(
      await review.postedReview(
        { kind: "project", project_id: "p1" },
        { since: "", turnText: "Read them all.", signature: "" },
      ),
    ).toBeNull();
  });

  it("has no revision to go stale against", async () => {
    expect(await review.revision({ kind: "project", project_id: "p1" })).toBeNull();
  });

  it("tells the reviewer to close its turn with the review", () => {
    expect(build().instructions.report).toContain("End the text of your turn with this block:");
  });

  it("passes on how the tracker reads and changes the issues", () => {
    expect(build().instructions.read).toBe("Read every issue.");
    expect(build().instructions.change).toBe("Change the issues in place.");
  });

  it("narrows no credential for the reviewer", () => {
    expect(review.reviewerCredential).toBeNull();
  });

  it("answers a finding in the turn text too", () => {
    expect(review.replyInstructions).toBe("Say so in the text of your turn.");
  });

  it("has no acceptance the host can report", () => {
    expect("accepted" in build()).toBe(false);
  });
});

describe("readyMessage", () => {
  it("hands the issues over on one line", async () => {
    expect(await build().readyMessage(PROJECT_URL)).toBe(
      `The issues are ready for you at ${PROJECT_URL}`,
    );
  });
});

describe("describe", () => {
  it("says where the issues are", async () => {
    const target = { url: PROJECT_URL, ref: { kind: "project" as const, project_id: "p1" } };
    expect(await build().describe(target)).toBe(`The issues are on the tracker at ${PROJECT_URL}.`);
  });
});
