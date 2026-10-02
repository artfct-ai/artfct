import { describe, expect, it } from "bun:test";
import type { Feedback, Review } from "../artifact/types";
import {
  conclusionOf,
  feedbackText,
  rejectionPrompt,
  reviewPrompt,
  reviewForAuthorPrompt,
} from "./review-prompt";

const URL = "https://github.com/acme/app/pull/7";
const REPORT = "## How to report\nFile it on the host.";
const ARTIFACT = {
  create: "Create it on the host.",
  read: "Read it on the host.",
  change: "Change it on the host.",
  report: "File it on the host.",
};
const REPLY_NOTE = "Reply on the review comment.";

const SIGNATURE = "Reviewer: alignment · run 2 · task wf_x.9";

function reviewerPrompted(overrides: Partial<Parameters<typeof reviewPrompt>[0]> = {}): string {
  return reviewPrompt({
    url: URL,
    title: "Fix login",
    request: "The redirect is wrong.",
    brief: "Ship a test with it.",
    entryInstructions: "Be adversarial.",
    artifact: ARTIFACT,
    earlierArtifacts: [],
    researchPayload: null,
    signatureLine: SIGNATURE,
    ...overrides,
  });
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("reviewPrompt", () => {
  describe("a reviewer of an artifact", () => {
    const prompt = reviewerPrompted();

    it("says the reviewer did not write the change", () => {
      expect(prompt).toContain("You are reviewing a change you did not write");
    });

    it("carries the stage instructions", () => {
      expect(prompt).toContain("Be adversarial.");
    });

    it("gives the line the reviewer signs its review with, ahead of the report steps", () => {
      expect(prompt.indexOf(SIGNATURE)).toBeGreaterThan(0);
      expect(prompt.indexOf(SIGNATURE)).toBeLessThan(prompt.indexOf(REPORT));
    });

    it("carries the artifact url", () => {
      expect(prompt).toContain(URL);
    });

    it("carries the title", () => {
      expect(prompt).toContain("Title: Fix login");
    });

    it("carries the request", () => {
      expect(prompt).toContain("The redirect is wrong.");
    });

    it("carries the brief", () => {
      expect(prompt).toContain("Ship a test with it.");
    });

    it("puts the kind's report steps last, so nothing argues with them", () => {
      expect(prompt.endsWith(REPORT)).toBe(true);
    });

    it("says how the artifact is read, ahead of how the review is filed", () => {
      const read = prompt.indexOf("## How to read the artifact\nRead it on the host.");
      expect(read).toBeGreaterThan(-1);
      expect(read).toBeLessThan(prompt.indexOf(REPORT));
    });

    it("forbids a change in the role text and leaves out how one is made", () => {
      expect(prompt).toContain("Do not fix anything, change the artifact, commit, or push.");
      expect(prompt).not.toContain("Change it on the host.");
      expect(prompt).not.toContain("Create it on the host.");
    });
  });

  describe("an author who was given no brief", () => {
    const prompt = reviewerPrompted({ brief: "" });

    it("leaves the acceptance criteria out", () => {
      expect(prompt).not.toContain("Acceptance criteria");
    });

    it("still carries the request", () => {
      expect(prompt).toContain("The redirect is wrong.");
    });
  });

  describe("a job that ran a researcher and works from an earlier page", () => {
    const prompt = reviewerPrompted({
      earlierArtifacts: [{ stage: "directions", kind: "page", url: "https://docs.test/page-1" }],
      researchPayload: "src/auth/session.ts:12 builds the session.",
    });

    it("links the earlier page", () => {
      expect(prompt).toContain(
        "## Artifacts from earlier stages\n- directions (page): https://docs.test/page-1",
      );
    });

    it("carries the research payload", () => {
      expect(prompt).toContain("## Research payload");
      expect(prompt).toContain("src/auth/session.ts:12 builds the session.");
    });
  });

  describe("a job with no researcher and no earlier artifact", () => {
    const prompt = reviewerPrompted();

    it("has no research payload section", () => {
      expect(prompt).not.toContain("## Research payload");
    });

    it("has no earlier artifacts section", () => {
      expect(prompt).not.toContain("## Artifacts from earlier stages");
    });
  });
});

describe("reviewForAuthorPrompt", () => {
  const review: Review = {
    kind: "review",
    revision: "abc123",
    blocking: true,
    summary: "Two things.",
    findings: [{ location: "src/login.ts:12", body: "This drops the error." }],
  };

  function prompted(overrides: Partial<Parameters<typeof reviewForAuthorPrompt>[0]> = {}): string {
    return reviewForAuthorPrompt({
      url: URL,
      review,
      replyInstructions: REPLY_NOTE,
      ...overrides,
    });
  }

  describe("a review that blocks", () => {
    const prompt = prompted();

    it("says the review asked for changes", () => {
      expect(prompt).toContain("The review of your artifact asked for changes.");
    });

    it("carries the summary and the findings", () => {
      expect(prompt).toContain("Two things.");
      expect(prompt).toContain("- src/login.ts:12 This drops the error.");
    });

    it("sends the author to its skill for how a finding is weighed", () => {
      expect(countOf(prompt, "Weigh each finding the way your skill says")).toBe(1);
    });

    it("says where an answer goes and what follows it", () => {
      expect(prompt).toContain(
        `- Answer a finding you do not act on where the reviewer will read it: ${REPLY_NOTE}`,
      );
      expect(prompt).toContain("- Then update the artifact.");
    });

    it("says the turn end decides where the artifact goes", () => {
      expect(prompt).toContain("the orchestrator decides where the artifact goes");
    });
  });

  describe("a review that blocks nothing", () => {
    const prompt = prompted({ review: { ...review, blocking: false } });

    it("says the review left comments", () => {
      expect(prompt).toContain("found nothing blocking and left comments");
    });

    it("sends the author to its skill the same way", () => {
      expect(countOf(prompt, "Weigh each finding the way your skill says")).toBe(1);
    });
  });

  describe("a kind with no place to answer a finding", () => {
    const prompt = prompted({ replyInstructions: "" });

    it("leaves the answer line out", () => {
      expect(prompt).not.toContain("- Answer a finding you do not act on");
    });

    it("still asks for the artifact to be updated", () => {
      expect(prompt).toContain("- Then update the artifact.");
    });
  });

  describe("a review with no summary and no findings", () => {
    const prompt = prompted({ review: { ...review, summary: "", findings: [] } });

    it("writes no empty comment list", () => {
      expect(prompt).not.toContain("Comments:");
    });

    it("still carries the url", () => {
      expect(prompt).toContain(URL);
    });
  });
});

describe("feedbackText", () => {
  const feedback: Feedback = {
    from: { person_id: "p1", email: null, display_name: "alice" },
    unchecked: false,
    body: "Two things.",
    findings: [{ location: "src/login.ts:12", body: "This drops the error." }],
    handles: [],
  };

  describe("what a person said about an artifact", () => {
    const text = feedbackText("alice", feedback);

    it("names who said it", () => {
      expect(text.startsWith("alice said:")).toBe(true);
    });

    it("carries the body and every finding with its location", () => {
      expect(text).toContain("Two things.");
      expect(text).toContain("- src/login.ts:12 This drops the error.");
    });
  });

  describe("a comment with no findings", () => {
    const text = feedbackText("alice", { ...feedback, findings: [] });

    it("writes no empty comment list", () => {
      expect(text).not.toContain("Comments:");
    });
  });

  describe("findings with no summary", () => {
    const text = feedbackText("alice", { ...feedback, body: "" });

    it("still carries the findings", () => {
      expect(text).toContain("- src/login.ts:12 This drops the error.");
    });
  });
});

describe("conclusionOf", () => {
  it("reads what follows the last conclusion heading", () => {
    const turn =
      "Reading.\n## Conclusion\ndraft\nMore reading.\n## Conclusion\nThe approach holds.\n";
    expect(conclusionOf(turn)).toBe("The approach holds.");
  });

  it("reads the whole text when the reviewer left the heading out", () => {
    expect(conclusionOf(" The approach holds. ")).toBe("The approach holds.");
  });

  it("is empty for a reviewer that said nothing", () => {
    expect(conclusionOf("")).toBe("");
  });
});

describe("rejectionPrompt", () => {
  const prompt = rejectionPrompt({
    url: URL,
    entry: "alignment",
    reason: "Use the SDK scheduler.",
  });

  it("names the entry, the artifact, and the reason", () => {
    expect(prompt).toContain("The alignment judge rejected your artifact.");
    expect(prompt).toContain(URL);
    expect(prompt).toContain("Use the SDK scheduler.");
  });

  it("says the next review reads the artifact", () => {
    expect(prompt).toContain("The next review reads it when this turn ends.");
  });
});
