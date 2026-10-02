import { GITHUB_CODE_REVIEW } from "@artfct-ai/adapters/code/github/review";
import { githubPullFromUrl, githubPullUrl } from "@artfct-ai/adapters/code/github/url";
import type { PullRequestReview, PullRequestReviewComment } from "@artfct-ai/adapters/code/types";
import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import type { InboundEvent, PullDetail } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { pullArtifact, RELAYED_TEXT, type PullClients } from "./pull";
import type { Artifact, ArtifactTarget, FeedbackHandle } from "./types";

const REPO = "acme/app";
const PR_URL = githubPullUrl({ repo: REPO, number: 7 });
const TARGET: ArtifactTarget = { url: PR_URL, ref: { kind: "pull", repo: REPO, number: 7 } };
const ACTOR = { person_id: "p1", email: null, display_name: "sam" };

type Built = { artifact: Artifact; host: FakeCodeHost | null; lines: string[] };

function build(host: FakeCodeHost | null): Built {
  const lines: string[] = [];
  const clients: PullClients = {
    host: () => host,
    repo: () => REPO,
    readUrl: (url) => {
      const found = githubPullFromUrl(url);
      return found ? { ...found, url: githubPullUrl(found) } : null;
    },
    writeUrl: (ref) => githubPullUrl(ref),
    review: GITHUB_CODE_REVIEW,
    mcp: () => null,
    instructions: {
      create: "Open a pull request.",
      read: "Read it with the host cli.",
      change: "Push to the branch.",
    },
    notes: "Clone what you need.",
    inspectNote: "Read the run with the host cli.",
    log: (line) => lines.push(line),
  };
  return { artifact: pullArtifact(clients), host, lines };
}

function event(patch: Partial<InboundEvent> = {}): InboundEvent {
  return {
    id: "evt-1",
    kind: "pr_event",
    actor: null,
    bindings: [],
    links: [],
    text: "",
    ...patch,
  };
}

function checksOfPull(patch: Parameters<typeof pullRequest>[0]) {
  const host = new FakeCodeHost({
    pulls: [pullRequest(patch)],
    commitChecks: { abc123: { state: "running" } },
  });
  return build(host).artifact.checks?.read(TARGET.ref, "abc123");
}

function changeOf(built: Built, patch: Partial<InboundEvent>, target: ArtifactTarget | null) {
  return built.artifact.change({ event: event(patch), target, claim: () => true });
}

function pullDetail(patch: Partial<PullDetail> = {}): PullDetail {
  return { action: "opened", repo: REPO, number: 7, ...patch };
}

function submittedReview(patch: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    id: 501,
    user: { login: "acme-review[bot]" },
    state: "COMMENTED",
    body: "Looks fine.",
    submitted_at: "2026-01-01T00:01:00.000Z",
    commit_id: "abc123",
    ...patch,
  };
}

function inlineComment(patch: Partial<PullRequestReviewComment> = {}): PullRequestReviewComment {
  return {
    id: 901,
    path: "src/login.ts",
    line: 12,
    original_line: 12,
    body: "Drops the error.",
    ...patch,
  };
}

function reviewHost(reviews: PullRequestReview[]): FakeCodeHost {
  return new FakeCodeHost({
    pulls: [pullRequest()],
    reviews: { 7: reviews },
    reviewComments: { 501: [inlineComment()] },
  });
}

describe("detect", () => {
  it("finds the pull request the author printed", async () => {
    const { artifact } = build(null);
    expect(await artifact.detect(`Opened ${PR_URL}/files`)).toEqual(TARGET);
  });

  it("ignores a pull request of another repository", async () => {
    const { artifact } = build(null);
    const text = `Opened ${githubPullUrl({ repo: "other/app", number: 7 })}`;
    expect(await artifact.detect(text)).toBeNull();
  });

  it("finds nothing in text without a link, and does not ask the host", async () => {
    const built = build(new FakeCodeHost({ pulls: [pullRequest()] }));
    expect(await built.artifact.detect("Pushed it.")).toBeNull();
    expect(built.host?.calls).toEqual([]);
  });
});

describe("openOnBranch", () => {
  it("asks the host for the pull request on the branch", async () => {
    const pull = pullRequest({ head: { ref: "artfct/wf_x-1-fix", sha: "abc123" } });
    const { artifact } = build(new FakeCodeHost({ pulls: [pull] }));
    expect(await artifact.openOnBranch?.("artfct/wf_x-1-fix")).toEqual(TARGET);
  });

  it("finds nothing when the branch has no pull request", async () => {
    const { artifact } = build(new FakeCodeHost());
    expect(await artifact.openOnBranch?.("artfct/wf_x-1-fix")).toBeNull();
  });

  it("says out loud when the host cannot be asked", async () => {
    const built = build(new FakeCodeHost({ failing: true }));
    expect(await built.artifact.openOnBranch?.("artfct/wf_x-1-fix")).toBeNull();
    expect(built.lines.some((line) => line.startsWith("pull request lookup failed"))).toBe(true);
  });
});

describe("binding", () => {
  it("binds the pull request so its webhooks route back to the workflow", () => {
    const { artifact } = build(null);
    expect(artifact.binding(TARGET.ref)).toEqual({ source: "code_pull", repo: REPO, number: 7 });
  });
});

describe("readyMessage", () => {
  it("hands the pull request over on one line", async () => {
    const { artifact } = build(null);
    expect(await artifact.readyMessage(TARGET.url)).toBe(
      `The pull request is ready for you: ${TARGET.url}`,
    );
  });
});

describe("how a review is reported", () => {
  const { report } = build(new FakeCodeHost()).artifact.instructions;

  it("asks for the pending review, its comments, and one submit, in that order", () => {
    const steps = report
      .split("\n")
      .filter((line) => /^\d+\. `/.test(line))
      .map((line) => line.replace(/^\d+\. `([a-z_]+)`.*$/, "$1"));
    expect(steps).toEqual([
      "pull_request_review_write",
      "add_comment_to_pending_review",
      "pull_request_review_write",
    ]);
  });

  it("opens the pending review with no event", () => {
    expect(report).toContain(
      '1. `pull_request_review_write` with `method: "create"` and no `event`',
    );
  });

  it("says an event on the opening call submits the review on the spot", () => {
    expect(report).toContain("An `event` here submits at once and leaves nothing to write on.");
  });

  it("anchors every finding to a line", () => {
    expect(report).toContain('`subjectType: "LINE"`');
  });

  it("says the body carries only the summary and the review", () => {
    expect(report).toContain(
      "The body carries only the summary. The `event` says whether the review blocks.",
    );
  });

  it("submits the pending review at the end", () => {
    expect(report).toContain('`pull_request_review_write` with `method: "submit_pending"`');
  });

  it("names the marker the review is read from", () => {
    expect(report).toContain('start the body with "BLOCKING:"');
  });

  it("says only the first line of the body carries the marker", () => {
    expect(report).toContain("as the first line. Code reads\n  only the first line for it.");
  });

  it("forbids an approval and every other way of posting a review", () => {
    expect(report).toContain("Never submit APPROVE.");
    expect(report).toContain("no `gh pr review`");
  });

  it("asks for a credential that reads the code and writes the review", () => {
    const { artifact } = build(new FakeCodeHost());
    expect(artifact.review!.reviewerCredential).toEqual({
      contents: "read",
      pull_requests: "write",
      metadata: "read",
    });
  });
});

describe("revision", () => {
  it("is the head commit of the pull request", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest()] }));
    expect(await artifact.review!.revision(TARGET.ref)).toBe("abc123");
  });

  it("is null without a code host, so no review counts as stale", async () => {
    const { artifact } = build(null);
    expect(await artifact.review!.revision(TARGET.ref)).toBeNull();
  });
  it("is null when the host cannot be asked, and says so", async () => {
    const built = build(new FakeCodeHost({ failing: true }));
    expect(await built.artifact.review!.revision(TARGET.ref)).toBeNull();
    expect(built.lines.some((line) => line.startsWith("revision lookup failed"))).toBe(true);
  });
});

describe("review", () => {
  const SINCE = "2026-01-01T00:00:00.000Z";
  const REVIEW_INPUT = { since: SINCE, turnText: "" };

  it("reads the summary, the review, and every finding of its own review", async () => {
    const { artifact } = build(reviewHost([submittedReview({ state: "CHANGES_REQUESTED" })]));
    expect(await artifact.review!.postedReview(TARGET.ref, REVIEW_INPUT)).toEqual({
      kind: "review",
      revision: "abc123",
      blocking: true,
      summary: "Looks fine.",
      findings: [{ location: "src/login.ts:12", body: "Drops the error." }],
    });
  });

  it("reads the blocking marker when the host refused a blocking state", async () => {
    const review = submittedReview({ body: "BLOCKING: fix the redirect." });
    const { artifact } = build(reviewHost([review]));
    expect(await artifact.review!.postedReview(TARGET.ref, REVIEW_INPUT)).toMatchObject({
      blocking: true,
    });
  });

  it("is not blocking for a review that only commented", async () => {
    const { artifact } = build(reviewHost([submittedReview()]));
    expect(await artifact.review!.postedReview(TARGET.ref, REVIEW_INPUT)).toMatchObject({
      blocking: false,
    });
  });

  it("takes the newest of its own reviews", async () => {
    const older = submittedReview({ id: 500, body: "First pass." });
    const { artifact } = build(reviewHost([submittedReview({ body: "Second pass." }), older]));
    expect(await artifact.review!.postedReview(TARGET.ref, REVIEW_INPUT)).toMatchObject({
      summary: "Second pass.",
    });
  });

  it("ignores a review a human filed, since that reaches the workflow as feedback", async () => {
    const { artifact } = build(reviewHost([submittedReview({ user: { login: "sam" } })]));
    expect(await artifact.review!.postedReview(TARGET.ref, REVIEW_INPUT)).toBeNull();
  });

  it("ignores a review filed before the reviewer started", async () => {
    const { artifact } = build(reviewHost([submittedReview()]));
    expect(
      await artifact.review!.postedReview(TARGET.ref, {
        since: "2026-01-01T00:02:00.000Z",
        turnText: "",
      }),
    ).toBeNull();
  });

  it("says out loud when the host cannot be asked", async () => {
    const built = build(new FakeCodeHost({ failing: true }));
    expect(await built.artifact.review!.postedReview(TARGET.ref, REVIEW_INPUT)).toBeNull();
    expect(built.lines.some((line) => line.startsWith("review lookup failed"))).toBe(true);
  });
});

describe("change", () => {
  describe("a pull request the author opened", () => {
    it("records it when the task holds none yet", async () => {
      const built = build(null);
      expect(await changeOf(built, { pull: pullDetail() }, null)).toEqual({
        change: "opened",
        target: TARGET,
      });
    });

    it("records nothing when the task already holds one", async () => {
      const built = build(null);
      expect(await changeOf(built, { pull: pullDetail() }, TARGET)).toBeNull();
    });
  });

  describe("an event about another pull request", () => {
    it("changes nothing on the artifact the task holds", async () => {
      const built = build(null);
      const detail = pullDetail({ number: 9, action: "closed", merged: true });
      expect(await changeOf(built, { pull: detail }, TARGET)).toBeNull();
    });
  });

  describe("a pull request marked ready for review", () => {
    it("hands the artifact to the humans", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "ready_for_review" });
      expect(await changeOf(built, { pull: detail }, TARGET)).toEqual({ change: "ready" });
    });
  });

  describe("a pull request that closed", () => {
    it("counts a merge as accepted", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "closed", merged: true });
      expect(await changeOf(built, { pull: detail }, TARGET)).toEqual({ change: "accepted" });
    });

    it("counts a close without a merge as closed", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "closed" });
      expect(await changeOf(built, { pull: detail }, TARGET)).toEqual({ change: "closed" });
    });
  });

  describe("a check that reported", () => {
    it("has the workflow read the checks, whatever the event says", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "completed", conclusion: "success" });
      expect(await changeOf(built, { kind: "ci_event", pull: detail }, TARGET)).toEqual({
        change: "checks",
      });
    });

    it("records nothing before the artifact is known", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "completed", conclusion: "failure" });
      expect(await changeOf(built, { kind: "ci_event", pull: detail }, null)).toBeNull();
    });
  });

  describe("a push to the base branch", () => {
    const moved = { action: "base_moved", repo: REPO, base: "main" } as const;

    it("has the workflow read the merge", async () => {
      const built = build(new FakeCodeHost({ pulls: [pullRequest()] }));
      expect(await changeOf(built, { pull: moved }, TARGET)).toEqual({ change: "checks" });
    });

    it("records nothing before the artifact is known", async () => {
      const built = build(new FakeCodeHost({ pulls: [pullRequest()] }));
      expect(await changeOf(built, { pull: moved }, null)).toBeNull();
    });
  });

  describe("what the host says about a revision", () => {
    it("is the checks of the commit while the pull request merges", async () => {
      expect(await checksOfPull({})).toEqual({ state: "running" });
    });

    it("is the conflict with the base branch once it does not", async () => {
      expect(await checksOfPull({ mergeable: false })).toEqual({
        state: "conflicted",
        base: "main",
      });
    });

    it("is an unknown merge while the host works it out", async () => {
      expect(await checksOfPull({ mergeable: null })).toEqual({ state: "merge_unknown" });
    });

    it("is the checks of the commit on a pull request the host closed", async () => {
      expect(await checksOfPull({ state: "closed", mergeable: false })).toEqual({
        state: "running",
      });
    });
  });

  describe("a review a person submitted", () => {
    const comment = { id: 901, path: "src/login.ts", line: 12, body: "Drops the error." };

    it("carries the summary and every inline comment to the author", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "review", comments: [comment] });
      const patch = { kind: "feedback" as const, actor: ACTOR, pull: detail, text: "Two things." };
      expect(await changeOf(built, patch, TARGET)).toEqual({
        change: "feedback",
        feedback: {
          from: ACTOR,
          unchecked: false,
          body: "Two things.",
          findings: [{ location: "src/login.ts:12", body: "Drops the error." }],
          handles: [{ kind: "pull", comment: { kind: "review", id: 901 } }],
        },
      });
    });

    it("marks the review of an App unchecked", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "review", reviewer_is_app: true, comments: [comment] });
      const patch = { kind: "feedback" as const, actor: ACTOR, pull: detail };
      expect(await changeOf(built, patch, TARGET)).toMatchObject({
        feedback: { unchecked: true },
      });
    });

    it("acknowledges a conversation comment on the comment itself", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "comment", comment_id: 42 });
      const patch = { kind: "feedback" as const, actor: ACTOR, pull: detail, text: "One thing." };
      expect(await changeOf(built, patch, TARGET)).toMatchObject({
        feedback: { handles: [{ kind: "pull", comment: { kind: "issue", id: 42 } }] },
      });
    });

    it("records nothing for a review with no summary and no comment", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "review" });
      const patch = { kind: "feedback" as const, actor: ACTOR, pull: detail };
      expect(await changeOf(built, patch, TARGET)).toBeNull();
    });

    it("records nothing when no person is behind the review", async () => {
      const built = build(null);
      const detail = pullDetail({ action: "review", comments: [comment] });
      expect(await changeOf(built, { kind: "feedback", pull: detail }, TARGET)).toBeNull();
    });

    it("reads the whole review off the host, not just the webhook in hand", async () => {
      const built = build(
        new FakeCodeHost({
          reviews: { 7: [submittedReview({ body: "Two things." })] },
          reviewComments: { 501: [inlineComment(), inlineComment({ id: 902, line: 20 })] },
        }),
      );
      const detail = pullDetail({ action: "review", review_id: 501, comments: [comment] });
      const patch = { kind: "feedback" as const, actor: ACTOR, pull: detail };
      expect(await changeOf(built, patch, TARGET)).toMatchObject({
        feedback: {
          body: "Two things.",
          handles: [
            { kind: "pull", comment: { kind: "review", id: 901 } },
            { kind: "pull", comment: { kind: "review", id: 902 } },
          ],
        },
      });
    });

    it("drops a sibling webhook of a review another one already carried", async () => {
      const built = build(
        new FakeCodeHost({
          reviews: { 7: [submittedReview({ body: "Two things." })] },
          reviewComments: { 501: [inlineComment()] },
        }),
      );
      const detail = pullDetail({ action: "review", review_id: 501, comments: [comment] });
      const change = await built.artifact.change({
        event: event({ kind: "feedback", actor: ACTOR, pull: detail }),
        target: TARGET,
        claim: () => false,
      });
      expect(change).toBeNull();
      expect(built.lines.some((line) => line.includes("was handled already"))).toBe(true);
    });

    it("keeps the webhook in hand when the host answers with less than it carries", async () => {
      const built = build(new FakeCodeHost({ reviews: { 7: [] } }));
      const detail = pullDetail({ action: "review", review_id: 501, comments: [comment] });
      const patch = { kind: "feedback" as const, actor: ACTOR, pull: detail };
      expect(await changeOf(built, patch, TARGET)).toMatchObject({
        feedback: { findings: [{ location: "src/login.ts:12", body: "Drops the error." }] },
      });
    });
  });

  it("records nothing for an event of another kind", async () => {
    const built = build(null);
    expect(await changeOf(built, { kind: "prompt", text: "hello" }, TARGET)).toBeNull();
  });
});

describe("acknowledge", () => {
  it("reacts on every comment the feedback names", async () => {
    const built = build(new FakeCodeHost());
    const handles: FeedbackHandle[] = [
      { kind: "pull", comment: { kind: "review", id: 901 } },
      { kind: "pull", comment: { kind: "issue", id: 42 } },
    ];
    await built.artifact.acknowledge(handles, TARGET.ref);
    expect(built.host!.argsOf("reactToComment")).toEqual([
      [REPO, { kind: "review", id: 901 }, "eyes"],
      [REPO, { kind: "issue", id: 42 }, "eyes"],
    ]);
  });

  it("replies on the pull request when there is no comment to react to", async () => {
    const built = build(new FakeCodeHost());
    await built.artifact.acknowledge([], TARGET.ref);
    expect(built.host!.argsOf("commentOnPull")).toEqual([[REPO, 7, RELAYED_TEXT]]);
  });

  it("says out loud when the host refuses", async () => {
    const built = build(new FakeCodeHost({ failing: true }));
    await built.artifact.acknowledge([], TARGET.ref);
    const failed = built.lines.some((line) =>
      line.startsWith("pull request acknowledgement failed"),
    );
    expect(failed).toBe(true);
  });
});

describe("branch", () => {
  it("is the head branch of an open pull request", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest()] }));
    expect(await artifact.branch?.(TARGET.ref)).toBe("artfct/wf-1-fix");
  });

  it("is null for a pull request from a fork", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest({ from_fork: true })] }));
    expect(await artifact.branch?.(TARGET.ref)).toBeNull();
  });

  it("is null once the host closed the pull request", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest({ state: "closed" })] }));
    expect(await artifact.branch?.(TARGET.ref)).toBeNull();
  });
});

describe("accepted", () => {
  it("is true once the host says the pull request merged", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest({ merged: true })] }));
    expect(await artifact.accepted!(TARGET.ref)).toBe(true);
  });

  it("is false while the pull request is open", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest()] }));
    expect(await artifact.accepted!(TARGET.ref)).toBe(false);
  });

  it("is false, with the reason said, when the host cannot be asked", async () => {
    const built = build(new FakeCodeHost({ failing: true }));
    expect(await built.artifact.accepted!(TARGET.ref)).toBe(false);
    expect(built.lines.some((line) => line.startsWith("merge check failed"))).toBe(true);
  });
});

describe("removed", () => {
  it("is true once the host says the pull request closed with no merge", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest({ state: "closed" })] }));
    expect(await artifact.removed!(TARGET)).toBe(true);
  });

  it("is false for a merged pull request", async () => {
    const closedByMerge = pullRequest({ state: "closed", merged: true });
    const { artifact } = build(new FakeCodeHost({ pulls: [closedByMerge] }));
    expect(await artifact.removed!(TARGET)).toBe(false);
  });

  it("is false while the pull request is open", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest()] }));
    expect(await artifact.removed!(TARGET)).toBe(false);
  });

  it("is false, with the reason said, when the host cannot be asked", async () => {
    const built = build(new FakeCodeHost({ failing: true }));
    expect(await built.artifact.removed!(TARGET)).toBe(false);
    expect(built.lines.some((line) => line.startsWith("removal check failed"))).toBe(true);
  });
});

describe("describe", () => {
  it("hands over the url when no code host is configured", async () => {
    const { artifact } = build(null);
    expect(await artifact.describe(TARGET)).toBe(
      `The code host is not configured. The pull request is ${PR_URL}.`,
    );
  });

  it("reports the title, the branches, and every check", async () => {
    const { artifact } = build(
      new FakeCodeHost({
        pulls: [pullRequest()],
        checks: { abc123: [{ name: "unit", conclusion: "success", html_url: "" }] },
      }),
    );
    expect((await artifact.describe(TARGET)).split("\n")).toEqual([
      "Fix login redirect (open)",
      "Head artfct/wf-1-fix -> main. Mergeable: true.",
      "Checks:",
      "- unit: success",
    ]);
  });

  it("says when no check reported", async () => {
    const { artifact } = build(new FakeCodeHost({ pulls: [pullRequest()] }));
    expect(await artifact.describe(TARGET)).toContain("No checks reported.");
  });

  it("reports the failure instead of throwing", async () => {
    const { artifact } = build(new FakeCodeHost({ failing: true }));
    expect(await artifact.describe(TARGET)).toMatch(/^The code host lookup failed/);
  });
});
