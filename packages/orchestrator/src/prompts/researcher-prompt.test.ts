import { describe, expect, it } from "bun:test";
import { RESEARCH_PAYLOAD_PATH } from "../workflow/task/sandbox/research-payload";
import { researcherTaskPrompt } from "./researcher-prompt";
import type { TaskContext } from "./task-prompt";

const INSTRUCTIONS = "Run the `research` skill with the Skill tool.";

const context: TaskContext = {
  title: "Fix login",
  text: "The redirect is wrong.",
  links: ["https://linear.app/acme/issue/ENG-42"],
  repo: { full: "acme/app", notes: "Clone what you need into /workspace." },
  branch: "artfct/wf_x-1-fix-login",
  brief: "Find where the redirect is built.",
  previous_artifacts: [{ stage: "design", kind: "page", url: "https://notion.so/abc" }],
  research_payload: null,
  input_artifact: null,
  preceding_research_payload: null,
  preceding_selection: null,
  ending: "acceptance",
};

describe("researcherTaskPrompt", () => {
  const prompt = researcherTaskPrompt({ instructions: INSTRUCTIONS, context });

  it("opens with the research skill instruction", () => {
    expect(prompt.startsWith(INSTRUCTIONS)).toBe(true);
  });

  it("carries the brief, the request, and the artifacts of earlier stages", () => {
    expect(prompt).toContain("## Brief from the orchestrator\nFind where the redirect is built.");
    expect(prompt).toContain("Title: Fix login");
    expect(prompt).toContain("- design (page): https://notion.so/abc");
  });

  it("names the repository and leaves out the branch", () => {
    expect(prompt).toContain("Repo: acme/app, cloned at the current directory.");
    expect(prompt).not.toContain("You are on branch");
  });

  it("asks for a todo list", () => {
    expect(prompt).toContain("Keep a todo list for this task and keep it current.");
  });

  it("says where the research payload goes", () => {
    expect(prompt).toContain(`Write the research payload to \`${RESEARCH_PAYLOAD_PATH}\``);
  });

  it("gives no artifact instructions", () => {
    expect(prompt).not.toContain("## Output");
    expect(prompt).not.toContain("## How to read the artifact");
    expect(prompt).not.toContain("## How to change the artifact");
  });

  it("leaves out the research behind the input artifact when there is none", () => {
    expect(prompt).not.toContain("## Research behind the input artifact");
  });

  it("carries the research behind the input artifact", () => {
    const precedingPayload = '{"findings":[{"file":"src/session.ts","line":40}]}';
    const withPreceding = researcherTaskPrompt({
      instructions: INSTRUCTIONS,
      context: { ...context, preceding_research_payload: precedingPayload },
    });
    expect(withPreceding).toContain("## Research behind the input artifact\n");
    expect(withPreceding).toContain(precedingPayload);
  });

  it("leaves out the selection behind the input artifact when there is none", () => {
    expect(prompt).not.toContain("## Selection behind the input artifact");
  });

  it("carries the selection behind the input artifact", () => {
    const withSelection = researcherTaskPrompt({
      instructions: INSTRUCTIONS,
      context: { ...context, preceding_selection: "Rotate the token" },
    });
    expect(withSelection).toContain("## Selection behind the input artifact\n");
    expect(withSelection).toContain("Rotate the token");
  });

  it("leaves out the repository when the workflow has none", () => {
    const withoutRepo = researcherTaskPrompt({
      instructions: INSTRUCTIONS,
      context: { ...context, repo: null },
    });
    expect(withoutRepo).not.toContain("## Repository");
  });
});
