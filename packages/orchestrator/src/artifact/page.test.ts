import type {
  PageCommentRef,
  DocumentComment,
  FetchedComment,
} from "@artfct-ai/adapters/documents/types";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { pageArtifact, withoutMention, type PageClients } from "./page";
import type { Artifact, ArtifactTarget } from "./types";

const PAGE_URL = "https://www.notion.so/acme/Design-0123456789abcdef0123456789abcdef";
const PAGE_ID = "0123456789abcdef0123456789abcdef";
const SELF_ID = "bot-1";
const SINCE = "2026-09-01T00:00:00.000Z";
const REVIEW_INPUT = { since: SINCE, turnText: "" };
const ACTOR = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

const REVIEW_TEXT = [
  "Review: findings",
  "The scope is wider than the request.",
  "",
  "- No owner.",
].join("\n");

function fetched(
  text: string,
  options: { mentions?: string[]; authorId?: string } = {},
): FetchedComment {
  return {
    text,
    author: { id: options.authorId ?? "n1", email: null },
    mentions: options.mentions ?? [],
  };
}

async function mentioningSelf(): Promise<FetchedComment> {
  return fetched("@artfct please revise", { mentions: [SELF_ID] });
}

async function namingSelfInText(): Promise<FetchedComment> {
  return fetched("@artfct please revise");
}

async function writtenBySelf(): Promise<FetchedComment> {
  return fetched("Review: findings", { authorId: SELF_ID });
}

async function hostDown(): Promise<FetchedComment | null> {
  throw new Error("docs host down");
}

function comment(options: {
  id: string;
  created_at: string;
  text: string;
  authorId: string | null;
}): DocumentComment {
  return {
    id: options.id,
    created_at: options.created_at,
    text: options.text,
    author: options.authorId ? { id: options.authorId, email: null } : null,
  };
}

type Overrides = Partial<
  Pick<
    PageClients,
    | "page"
    | "removed"
    | "comments"
    | "fetchComment"
    | "heldComments"
    | "self"
    | "comment"
    | "acknowledgeComment"
    | "log"
  >
>;

function build(overrides: Overrides = {}): Artifact {
  const clients: PageClients = {
    readUrl: async (url) =>
      url.startsWith("https://www.notion.so/") ? { page_id: PAGE_ID } : null,
    page: async () => ({ id: PAGE_ID, contentId: null, url: PAGE_URL, revision: "rev-2" }),
    removed: async () => false,
    comments: async () => [],
    fetchComment: async () => fetched("Tighten the intro."),
    heldComments: async () => [],
    self: async () => ({ id: SELF_ID, name: "artfct" }),
    comment: async () => {},
    acknowledgeComment: async () => {},
    instructions: {
      create: "Write the design.",
      read: "Read it with the page tool.",
      change: "Change it with the page tool.",
      report: "Post it with the page tool.",
    },
    pageParentHint: "the parent page.",
    mcp: () => null,
    notes: "Clone what you need.",
    log: () => {},
    ...overrides,
  };
  return pageArtifact(clients);
}

describe("detect", () => {
  it("finds the page the author printed", async () => {
    expect(await build().detect(`Wrote ${PAGE_URL}`)).toEqual({
      url: PAGE_URL,
      ref: { kind: "page", page_id: PAGE_ID },
    });
  });

  it("ignores a link of another host", async () => {
    expect(await build().detect("Wrote https://example.com/x")).toBeNull();
  });
});

describe("binding", () => {
  it("binds the page, so a comment on it routes back to the workflow", () => {
    expect(build().binding({ kind: "page", page_id: PAGE_ID })).toEqual({
      source: "documents_page",
      external_id: PAGE_ID,
    });
  });

  it("binds nothing for a ref of another kind", () => {
    expect(build().binding({ kind: "issues" })).toBeNull();
  });
});

describe("agent review", () => {
  it("reports what the page says it is now", async () => {
    expect(await build().review!.revision({ kind: "page", page_id: PAGE_ID })).toBe("rev-2");
  });

  it("reports an unknown revision when the host has no such page", async () => {
    const artifact = build({ page: async () => null });
    expect(await artifact.review!.revision({ kind: "page", page_id: PAGE_ID })).toBeNull();
  });

  it("narrows no credential, since a document credential cannot be scoped", () => {
    expect(build().review!.reviewerCredential).toBeNull();
  });

  it("tells the reviewer the format and where to file it", () => {
    const { report } = build().instructions;
    expect(report).toContain("Review: findings");
    expect(report).toContain("Post it with the page tool.");
  });

  it("has no acceptance the host can report", () => {
    expect("accepted" in build()).toBe(false);
  });

  it("closes with nothing to add", () => {
    expect(build().readyInstructions()).toBe("");
  });
});

describe("readyMessage", () => {
  it("hands the page over and says a mention of the document user sends the comments", async () => {
    expect(await build().readyMessage(PAGE_URL)).toBe(
      [
        `The document is ready for you: ${PAGE_URL}`,
        "Comment on the page. Your comments wait until a comment mentions @artfct. Then the author gets them all and revises. You can also ask for that in this thread.",
      ].join("\n"),
    );
  });

  it("says to ask in the thread when the host does not name the document user", async () => {
    const message = await build({ self: async () => ({ id: SELF_ID, name: null }) }).readyMessage(
      PAGE_URL,
    );
    expect(message).toContain("Your comments wait until you ask in this thread.");
    expect(message).not.toContain("@");
  });

  it("says to ask in the thread when the host cannot be reached", async () => {
    const artifact = build({
      self: async () => {
        throw new Error("docs host down");
      },
    });
    expect(await artifact.readyMessage(PAGE_URL)).toContain("ask in this thread");
  });
});

describe("review", () => {
  const ref = { kind: "page" as const, page_id: PAGE_ID };

  it("takes the newest review this reviewer wrote", async () => {
    const artifact = build({
      comments: async () => [
        comment({
          id: "c1",
          created_at: "2026-09-01T01:00:00.000Z",
          text: "Review: blocking\nOld.",
          authorId: SELF_ID,
        }),
        comment({
          id: "c2",
          created_at: "2026-09-01T02:00:00.000Z",
          text: REVIEW_TEXT,
          authorId: SELF_ID,
        }),
      ],
    });
    expect(await artifact.review!.postedReview(ref, REVIEW_INPUT)).toEqual({
      kind: "review",
      revision: "rev-2",
      blocking: false,
      summary: "The scope is wider than the request.",
      findings: [{ body: "No owner." }],
    });
  });

  it("asks for the comments of the page since the reviewer started", async () => {
    const asked: Array<[string, string]> = [];
    const artifact = build({
      comments: async (pageId, since) => {
        asked.push([pageId, since]);
        return [];
      },
    });
    await artifact.review!.postedReview(ref, REVIEW_INPUT);
    expect(asked).toEqual([[PAGE_ID, SINCE]]);
  });

  it("ignores a human's comment", async () => {
    const artifact = build({
      comments: async () => [
        comment({
          id: "c1",
          created_at: "2026-09-01T03:00:00.000Z",
          text: REVIEW_TEXT,
          authorId: "human-1",
        }),
      ],
    });
    expect(await artifact.review!.postedReview(ref, REVIEW_INPUT)).toBeNull();
  });

  it("ignores a comment of its own that is not a review", async () => {
    const artifact = build({
      comments: async () => [
        comment({
          id: "c1",
          created_at: "2026-09-01T03:00:00.000Z",
          text: "Reading the page now.",
          authorId: SELF_ID,
        }),
      ],
    });
    expect(await artifact.review!.postedReview(ref, REVIEW_INPUT)).toBeNull();
  });

  it("takes the newest review past a later comment that is not one", async () => {
    const artifact = build({
      comments: async () => [
        comment({
          id: "c1",
          created_at: "2026-09-01T01:00:00.000Z",
          text: REVIEW_TEXT,
          authorId: SELF_ID,
        }),
        comment({
          id: "c2",
          created_at: "2026-09-01T02:00:00.000Z",
          text: "One more thought.",
          authorId: SELF_ID,
        }),
      ],
    });
    expect((await artifact.review!.postedReview(ref, REVIEW_INPUT))?.summary).toBe(
      "The scope is wider than the request.",
    );
  });

  it("is null when the host will not say which user is ours", async () => {
    const artifact = build({
      self: async () => null,
      comments: async () => [
        comment({
          id: "c1",
          created_at: "2026-09-01T03:00:00.000Z",
          text: REVIEW_TEXT,
          authorId: SELF_ID,
        }),
      ],
    });
    expect(await artifact.review!.postedReview(ref, REVIEW_INPUT)).toBeNull();
  });

  it("is null when the host cannot be reached", async () => {
    const lines: string[] = [];
    const artifact = pageArtifact({
      readUrl: async () => null,
      page: async () => null,
      removed: async () => false,
      comments: async () => {
        throw new Error("docs host down");
      },
      fetchComment: async () => null,
      heldComments: async () => [],
      self: async () => ({ id: SELF_ID, name: "artfct" }),
      comment: async () => {},
      acknowledgeComment: async () => {},
      instructions: { create: "", read: "", change: "", report: "" },
      pageParentHint: "",
      mcp: () => null,
      notes: "",
      log: (line) => lines.push(line),
    });
    expect(await artifact.review!.postedReview(ref, REVIEW_INPUT)).toBeNull();
    expect(lines.join(" ")).toContain("docs host down");
  });

  it("is null for a ref of another kind", async () => {
    expect(await build().review!.postedReview({ kind: "issues" }, REVIEW_INPUT)).toBeNull();
  });
});

describe("a judge entry", () => {
  const ref = { kind: "page" as const, page_id: PAGE_ID };

  it("reads the page the way every other role does", () => {
    expect(build().instructions.read).toBe("Read it with the page tool.");
  });

  it("posts a rejection as a comment on the page", async () => {
    const comments: [string, string][] = [];
    const review = build({
      comment: async (pageId, text) => void comments.push([pageId, text]),
    }).review!;
    await review.postRejection!(ref, "Use the scheduler.");
    expect(comments).toEqual([[PAGE_ID, "Use the scheduler."]]);
  });

  it("logs a comment the host refused and does not throw", async () => {
    const review = build({
      comment: async () => {
        throw new Error("docs host down");
      },
    }).review!;
    await expect(review.postRejection!(ref, "Use the scheduler.")).resolves.toBeUndefined();
  });
});

describe("change", () => {
  const target = { url: PAGE_URL, ref: { kind: "page" as const, page_id: PAGE_ID } };
  const commented = { page_id: PAGE_ID, comment_id: "cmt-1" };

  function feedbackEvent(patch: Partial<InboundEvent> = {}): InboundEvent {
    return {
      id: "notion:evt-1",
      kind: "feedback",
      actor: ACTOR,
      bindings: [{ source: "documents_page", external_id: PAGE_ID }],
      links: [],
      text: "Tighten the intro.",
      page: commented,
      ...patch,
    };
  }

  async function changeOf(
    event: InboundEvent,
    on: ArtifactTarget | null = target,
    overrides: Overrides = {},
  ) {
    return build(overrides).change({ event, target: on, claim: () => true });
  }

  it("holds a person's comment that does not mention the document user", async () => {
    expect(await changeOf(feedbackEvent())).toEqual({ change: "comment_held" });
  });

  it("sends the held comments on a comment that mentions the document user", async () => {
    const event = feedbackEvent({ text: "@artfct please revise" });
    expect(await changeOf(event, target, { fetchComment: mentioningSelf })).toEqual({
      change: "mentioned",
      from: ACTOR,
      page_id: PAGE_ID,
      comment_id: "cmt-1",
      body: "please revise",
    });
  });

  it("holds a comment that names the document user in plain text only", async () => {
    const event = feedbackEvent({ text: "@artfct please revise" });
    const change = await changeOf(event, target, { fetchComment: namingSelfInText });
    expect(change?.change).toBe("comment_held");
  });

  it("records nothing for a comment the document user wrote", async () => {
    expect(await changeOf(feedbackEvent(), target, { fetchComment: writtenBySelf })).toBeNull();
  });

  it("records nothing for a comment the host no longer holds", async () => {
    expect(await changeOf(feedbackEvent(), target, { fetchComment: async () => null })).toBeNull();
  });

  it("holds the comment when the host cannot be reached", async () => {
    const lines: string[] = [];
    const change = await changeOf(feedbackEvent(), target, {
      fetchComment: hostDown,
      log: (line) => lines.push(line),
    });
    expect(change?.change).toBe("comment_held");
    expect(lines.join(" ")).toContain("docs host down");
  });

  it("holds the comment when the host does not say which user is ours", async () => {
    const change = await changeOf(feedbackEvent(), target, { self: async () => null });
    expect(change?.change).toBe("comment_held");
  });

  it("records nothing when no person is behind the comment", async () => {
    expect(await changeOf(feedbackEvent({ actor: null }))).toBeNull();
  });

  it("records nothing for an empty comment", async () => {
    expect(await changeOf(feedbackEvent({ text: "  " }))).toBeNull();
  });

  it("records nothing for a comment on another page", async () => {
    const elsewhere = feedbackEvent({ page: { ...commented, page_id: "f".repeat(32) } });
    expect(await changeOf(elsewhere)).toBeNull();
  });

  it("records nothing before the page is recorded as the artifact", async () => {
    expect(await changeOf(feedbackEvent(), null)).toBeNull();
  });

  it("makes nothing of an event about no page", async () => {
    expect(await changeOf(feedbackEvent({ kind: "prompt", page: undefined }))).toBeNull();
  });
});

describe("acknowledge", () => {
  const ref = { kind: "page" as const, page_id: PAGE_ID };
  const handles = [{ kind: "page" as const, comment_id: "cmt-1" }];

  it("acknowledges each comment the feedback came in", async () => {
    const acknowledged: PageCommentRef[] = [];
    const artifact = build({
      acknowledgeComment: async (commentRef) => void acknowledged.push(commentRef),
    });
    await artifact.acknowledge([...handles, { kind: "page", comment_id: "cmt-2" }], ref);
    expect(acknowledged).toEqual([
      { pageId: PAGE_ID, commentId: "cmt-1" },
      { pageId: PAGE_ID, commentId: "cmt-2" },
    ]);
  });

  it("logs an acknowledgement the host refused and does not throw", async () => {
    const lines: string[] = [];
    const artifact = build({
      acknowledgeComment: async () => {
        throw new Error("docs host down");
      },
      log: (line) => lines.push(line),
    });
    await expect(artifact.acknowledge(handles, ref)).resolves.toBeUndefined();
    expect(lines.join(" ")).toContain("docs host down");
  });
});

describe("heldComments", () => {
  it("reads the held comments of the page from the host", async () => {
    const held = [{ id: "cmt-1", author_name: "Ann", text: "Tighten the intro." }];
    const asked: string[] = [];
    const artifact = build({
      heldComments: async (pageId) => {
        asked.push(pageId);
        return held;
      },
    });
    expect(await artifact.heldComments?.read(PAGE_ID)).toEqual(held);
    expect(asked).toEqual([PAGE_ID]);
  });
});

describe("withoutMention", () => {
  it("drops every mention of the name", () => {
    expect(withoutMention("@artfct please revise, @artfct", "artfct")).toBe("please revise,");
  });

  it("keeps the text when the name is unknown", () => {
    expect(withoutMention("@artfct please revise", null)).toBe("@artfct please revise");
  });
});

describe("removed", () => {
  const target = { url: PAGE_URL, ref: { kind: "page" as const, page_id: PAGE_ID } };

  it("asks the host about the link of the page", async () => {
    const asked: string[] = [];
    const artifact = build({
      removed: async (url) => {
        asked.push(url);
        return true;
      },
    });
    expect(await artifact.removed!(target)).toBe(true);
    expect(asked).toEqual([PAGE_URL]);
  });

  it("is false when the host cannot be asked", async () => {
    const artifact = build({
      removed: async () => {
        throw new Error("docs host down");
      },
    });
    expect(await artifact.removed!(target)).toBe(false);
  });
});

describe("describe", () => {
  it("names the page and where to read it", async () => {
    const target = { url: PAGE_URL, ref: { kind: "page" as const, page_id: PAGE_ID } };
    expect(await build().describe(target)).toBe(
      `Page ${PAGE_ID} at ${PAGE_URL}. Open it to read what it says.`,
    );
  });

  it("says the task produced none when the ref is of another kind", async () => {
    const target = { url: PAGE_URL, ref: { kind: "issues" as const } };
    expect(await build().describe(target)).toBe("That task produced no page.");
  });
});
