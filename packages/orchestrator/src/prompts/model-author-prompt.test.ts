import { describe, expect, it } from "bun:test";
import { OPTIONS_HEADING } from "../artifact/options";
import {
  CLOSING_TEXT_MARKER,
  producePagePrompt,
  replyMarker,
  revisePrompt,
  splitReviseAnswer,
  validateCommentReplies,
} from "./model-author-prompt";
import type { TaskContext } from "./task-prompt";

const context: TaskContext = {
  title: "Add SSO",
  text: "Let people sign in with their company account.",
  links: [],
  repo: { full: "acme/app", notes: "Clone what you need into /workspace." },
  branch: null,
  brief: "Keep the session store.",
  previous_artifacts: [{ stage: "design", kind: "page", url: "https://docs.test/page-1" }],
  input_artifact: null,
  research_payload: "src/auth/session.ts:12 builds the session.",
  preceding_research_payload: "src/auth/login.ts:40 reads the redirect.",
  preceding_selection: null,
  ending: "acceptance",
  page_parent: null,
};

const DIRECTION = "# Direction\nUse OIDC.";

describe("producePagePrompt", () => {
  describe("a job that works from a page", () => {
    const prompt = producePagePrompt({ context, inputPageText: DIRECTION });

    it("asks for the whole document", () => {
      expect(prompt.startsWith("Write the whole document.")).toBe(true);
    });

    it("says the model has no tools and no code", () => {
      expect(prompt).toContain("You have no tools and no access to the code.");
    });

    it("carries the request, the research, and the input page", () => {
      expect(prompt).toContain("Title: Add SSO");
      expect(prompt).toContain("src/auth/session.ts:12 builds the session.");
      expect(prompt).toContain("src/auth/login.ts:40 reads the redirect.");
      expect(prompt).toContain(DIRECTION);
    });

    it("asks for no options on an acceptance ending", () => {
      expect(prompt).not.toContain(OPTIONS_HEADING);
    });
  });

  describe("a job that works from the page of a stage with a choice ending", () => {
    const prompt = producePagePrompt({
      context: { ...context, preceding_selection: "Rotate the token" },
      inputPageText: "# Design\n## Options\n1. Rotate the token\n2. Keep the token",
    });

    it("names the option the person chose on the preceding stage", () => {
      expect(prompt).toContain("## Selection behind the input artifact\n");
      expect(prompt).toContain("A person chose this option from it.");
      expect(prompt).toContain("\nRotate the token\n");
    });
  });

  describe("a job on a stage with a choice ending", () => {
    const prompt = producePagePrompt({
      context: { ...context, ending: "choice" },
      inputPageText: null,
    });

    it("asks for the options as a numbered list under the options heading", () => {
      expect(prompt).toContain(`## ${OPTIONS_HEADING}`);
      expect(prompt).toContain("numbered item");
    });
  });
});

describe("revisePrompt", () => {
  const prompt = revisePrompt({
    context,
    inputPageText: DIRECTION,
    findings: '- Design: Severity: blocking. Claim: "Use SAML."',
    pageText: "## Problem\nSign in.\n\n## Design\nUse SAML.",
  });

  it("opens with the tested instruction", () => {
    expect(
      prompt.startsWith(
        "Revise the document below so that every finding is resolved and every ruling holds.",
      ),
    ).toBe(true);
    expect(prompt).toContain("Reply with the whole revised document");
  });

  it("asks for the closing text after the marker line", () => {
    expect(prompt).toContain(
      `write the line ${CLOSING_TEXT_MARKER} on its own, then your closing text.`,
    );
  });

  it("asks for another review after a review that asked for changes", () => {
    expect(prompt).toContain("When the review asked for changes, ask for another review.");
  });

  it("carries the request, the research payload, and the direction", () => {
    expect(prompt).toContain("Title: Add SSO");
    expect(prompt).toContain("src/auth/session.ts:12 builds the session.");
    expect(prompt).toContain(DIRECTION);
  });

  it("carries the findings and says their host instructions do not apply", () => {
    expect(prompt).toContain("## Findings\n");
    expect(prompt).toContain("Your answer is the page.");
    expect(prompt).toContain('Claim: "Use SAML."');
  });

  it("ends with the whole page as it is now", () => {
    expect(prompt.endsWith("## Problem\nSign in.\n\n## Design\nUse SAML.")).toBe(true);
    expect(prompt.indexOf("## Findings")).toBeLessThan(prompt.indexOf("\n## Document\n"));
  });
});

describe("revisePrompt with comment findings", () => {
  const prompt = revisePrompt({
    context,
    inputPageText: null,
    findings: "- [comment c-1] Ann: Rename the provider.",
    pageText: "## Goal\nUse SAML.",
  });

  it("asks for a reply to each labeled comment after the closing text", () => {
    expect(prompt).toContain(`write the line ${replyMarker("<id>")} on its own`);
  });

  it("asks to leave the lines a finding does not need", () => {
    expect(prompt).toContain("Change only the lines a finding needs.");
  });
});

describe("revisePrompt without comment findings", () => {
  it("asks for no reply", () => {
    const prompt = revisePrompt({
      context,
      inputPageText: null,
      findings: "- Design: Use OIDC.",
      pageText: "## Goal\nUse SAML.",
    });
    expect(prompt).not.toContain("%%% reply");
  });
});

describe("validateCommentReplies", () => {
  const findings = "- [comment c-1] Ann: Rename it.\n- [comment c-2] Bo: Why?";

  it("passes a reply with text to each labeled comment", () => {
    const replies = [
      { comment_id: "c-2", text: "Because of the session store." },
      { comment_id: "c-1", text: "Renamed it." },
    ];
    expect(validateCommentReplies(findings, replies)).toBeNull();
  });

  it("names a labeled comment without a reply", () => {
    expect(validateCommentReplies(findings, [{ comment_id: "c-1", text: "Renamed it." }])).toBe(
      "The model did not reply to comment c-2.",
    );
  });

  it("names a labeled comment whose reply is empty", () => {
    const replies = [
      { comment_id: "c-1", text: "Renamed it." },
      { comment_id: "c-2", text: "" },
    ];
    expect(validateCommentReplies(findings, replies)).toBe(
      "The model did not reply to comment c-2.",
    );
  });

  it("names a reply to a comment the findings do not label", () => {
    const replies = [{ comment_id: "c-9", text: "Done." }];
    expect(validateCommentReplies(findings, replies)).toBe(
      "The model replied to comment c-9, which the findings do not name.",
    );
  });

  it("passes findings without comments and an answer without replies", () => {
    expect(validateCommentReplies("- Design: Use OIDC.", [])).toBeNull();
  });
});

describe("splitReviseAnswer", () => {
  describe("an answer with a closing text", () => {
    const split = splitReviseAnswer(
      `## Goal\nUse OIDC.\n${CLOSING_TEXT_MARKER}\nRenamed the provider. No review is needed.\n`,
    );

    it("keeps the document part as the page text", () => {
      expect(split?.pageText).toBe("## Goal\nUse OIDC.");
    });

    it("keeps the rest as the closing text", () => {
      expect(split?.closingText).toBe("Renamed the provider. No review is needed.");
    });
  });

  it("splits at the last marker", () => {
    const answer = `A ${CLOSING_TEXT_MARKER} B\n${CLOSING_TEXT_MARKER}\nDone.`;
    expect(splitReviseAnswer(answer)).toEqual({
      pageText: `A ${CLOSING_TEXT_MARKER} B`,
      closingText: "Done.",
      replies: [],
    });
  });

  it("keeps each reply after the closing text by its comment id", () => {
    const answer = [
      "## Goal",
      "Use OIDC.",
      CLOSING_TEXT_MARKER,
      "Renamed the provider.",
      replyMarker("c-1"),
      "Renamed it to OIDC.",
      replyMarker("c-2"),
      "The page keeps SAML out.",
      "It was never in scope.",
    ].join("\n");
    expect(splitReviseAnswer(answer)).toEqual({
      pageText: "## Goal\nUse OIDC.",
      closingText: "Renamed the provider.",
      replies: [
        { comment_id: "c-1", text: "Renamed it to OIDC." },
        { comment_id: "c-2", text: "The page keeps SAML out.\nIt was never in scope." },
      ],
    });
  });

  it("is null for an answer with replies and no closing text", () => {
    const answer = `## Goal\n${CLOSING_TEXT_MARKER}\n${replyMarker("c-1")}\nRenamed it.`;
    expect(splitReviseAnswer(answer)).toBeNull();
  });

  it("is null for an answer with no marker", () => {
    expect(splitReviseAnswer("## Goal\nUse OIDC.")).toBeNull();
  });

  it("is null for an answer with nothing after the marker", () => {
    expect(splitReviseAnswer(`## Goal\nUse OIDC.\n${CLOSING_TEXT_MARKER}\n`)).toBeNull();
  });
});
