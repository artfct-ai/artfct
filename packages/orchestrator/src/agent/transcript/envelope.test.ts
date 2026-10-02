import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { eventBody, eventMessage, noteMessage, parseHeader } from "./envelope";

const base: InboundEvent = {
  id: "evt-1",
  kind: "ci_event",
  actor: null,
  bindings: [],
  links: [],
  text: "",
  pull: { repo: "acme/app", number: 1, action: "completed", conclusion: "failure" },
};

describe("eventMessage", () => {
  describe("a failed CI run on a drafted artifact", () => {
    const text = eventMessage(base, {
      first: false,
      job: { job_id: "wf_1-1", task_id: "wf_1.1" },
      artifact: { kind: "pull", status: "drafted" },
      notes: ["CI failed."],
    });

    it("names the system as the sender, since no person is behind it", () => {
      expect(text).toContain("From: the system, not a person");
    });

    it("writes a parseable header", () => {
      expect(parseHeader(text)).toEqual({
        kind: "ci_event",
        job: "wf_1-1",
        task: "wf_1.1",
        artifact: "pull",
        status: "drafted",
        pull_action: "completed",
      });
    });

    it("lists what the system already did", () => {
      expect(text).toContain("What the system already did:\n- CI failed.");
    });
  });

  describe("a pull request whose base branch moved", () => {
    const moved: InboundEvent = {
      ...base,
      kind: "pr_event",
      pull: { repo: "acme/app", action: "base_moved", base: "main" },
    };
    const text = eventMessage(moved, {
      first: false,
      job: { job_id: "wf_1-1", task_id: "wf_1.1" },
      artifact: null,
      notes: ["Still mergeable."],
    });

    it("lists what the system already did", () => {
      expect(text).toContain("- Still mergeable.");
    });

    it("says the workflow has no artifact", () => {
      expect(parseHeader(text)?.artifact).toBe("none");
    });
  });

  describe("a merged pull request as the first message", () => {
    const merged: InboundEvent = {
      ...base,
      kind: "pr_event",
      pull: { repo: "acme/app", number: 1, action: "closed", merged: true },
    };
    const first = eventMessage(merged, { first: true, job: null, artifact: null, notes: [] });

    it("marks the message as the request", () => {
      expect(parseHeader(first)?.kind).toBe("request");
    });

    it("names the merge as the action", () => {
      expect(parseHeader(first)?.pull_action).toBe("merged");
    });
  });
});

describe("eventBody", () => {
  const prompt: InboundEvent = {
    ...base,
    kind: "prompt",
    pull: undefined,
    actor: { person_id: "person-1", display_name: "Alex", email: null },
    title: "Passes",
    text: "lets move to a plan\n\nand keep it short",
    links: ["https://example.test/doc"],
  };
  const context = { first: false, job: null, artifact: null, notes: ["Recorded the link."] };

  describe("a person's message with links and system notes", () => {
    it("is the words the person wrote, paragraphs kept", () => {
      expect(eventBody(eventMessage(prompt, context))).toBe(
        "lets move to a plan\n\nand keep it short",
      );
    });
  });

  describe("a note", () => {
    it("has no body", () => {
      expect(eventBody(noteMessage("turn ended"))).toBe("");
    });
  });
});

describe("noteMessage", () => {
  describe("a note to the agent", () => {
    it("has no header", () => {
      expect(parseHeader(noteMessage("turn ended"))).toBeNull();
    });
  });
});
