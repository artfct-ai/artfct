import { describe, expect, it } from "bun:test";
import { OPTIONS_HEADING } from "../artifact/options";
import { resumePrompt, taskPrompt, type TaskContext } from "./task-prompt";

const INSTRUCTIONS = "Run the `implement` skill with the Skill tool.";

const OUTPUT = [
  "When the work is ready, open a pull request with `gh pr create`.",
  "End with a one-line summary.",
].join("\n");

const ARTIFACT = {
  create: OUTPUT,
  read: "Read it on the host.",
  change: "Change it on the host.",
  report: "File it on the host.",
};

function task(overrides: Partial<Parameters<typeof taskPrompt>[0]> = {}): string {
  return taskPrompt({
    instructions: INSTRUCTIONS,
    context,
    artifact: ARTIFACT,
    ...overrides,
  });
}

const context: TaskContext = {
  title: "Fix login",
  text: "The redirect is wrong.",
  links: ["https://linear.app/acme/issue/ENG-42"],
  repo: { full: "acme/app", notes: "Clone what you need into /workspace." },
  branch: "artfct/wf_x-1-fix-login",
  brief: "",
  previous_artifacts: [{ stage: "design", kind: "page", url: "https://notion.so/abc" }],
  research_payload: null,
  input_artifact: null,
  preceding_research_payload: null,
  preceding_selection: null,
  ending: "acceptance",
};

describe("taskPrompt", () => {
  describe("a task with a repository, links, and an approved artifact", () => {
    const prompt = task();

    it("states the request", () => {
      expect(prompt).toContain("Title: Fix login");
    });

    it("lists the links", () => {
      expect(prompt).toContain("- https://linear.app/acme/issue/ENG-42");
    });

    it("lists the approved artifacts with their stage", () => {
      expect(prompt).toContain("design (page)");
    });

    it("names the repository and where it is cloned", () => {
      expect(prompt).toContain("## Repository\nRepo: acme/app, cloned at the current directory.");
    });

    it("names the branch the task works on", () => {
      expect(prompt).toContain("You are on branch `artfct/wf_x-1-fix-login`.");
    });

    it("gives the branch rules", () => {
      expect(prompt).toContain("Never push to the default branch");
    });

    it("says how the artifact is created, read, and changed, in that order", () => {
      expect(
        prompt.endsWith(
          [
            `## Output\n${OUTPUT}`,
            "## How to read the artifact\nRead it on the host.",
            "## How to change the artifact\nChange it on the host.",
          ].join("\n\n"),
        ),
      ).toBe(true);
    });

    it("leaves out how a review is filed", () => {
      expect(prompt).not.toContain("File it on the host.");
    });
  });

  describe("a task whose job ran no researcher", () => {
    it("leaves out the research payload", () => {
      expect(task()).not.toContain("## Research payload");
    });
  });

  describe("a task whose job's researcher stored a research payload", () => {
    const payload = '{"findings":[{"file":"src/login.ts","line":12}]}';
    const prompt = task({ context: { ...context, research_payload: payload } });

    it("carries the payload whole in its own section", () => {
      expect(prompt).toContain("## Research payload");
      expect(prompt).toContain(payload);
    });

    it("puts the payload after the request and before the repository", () => {
      const payloadAt = prompt.indexOf(payload);
      expect(payloadAt).toBeGreaterThan(prompt.indexOf("## Request"));
      expect(payloadAt).toBeLessThan(prompt.indexOf("## Repository"));
    });
  });

  describe("a task on a stage that ends on acceptance", () => {
    it("asks for no options", () => {
      expect(task()).not.toContain(OPTIONS_HEADING);
    });
  });

  describe("a task on a stage with a choice ending", () => {
    const prompt = task({ context: { ...context, ending: "choice" } });

    it("asks for the options as a numbered list under the options heading", () => {
      expect(prompt).toContain("## Options\nThis stage ends on a choice.");
      expect(prompt).toContain(`## ${OPTIONS_HEADING}`);
    });
  });

  describe("a task whose input artifact came from a job with no research payload", () => {
    it("leaves out the research behind the input artifact", () => {
      expect(task()).not.toContain("## Research behind the input artifact");
    });
  });

  describe("a task whose input artifact came from a job with a research payload", () => {
    const ownPayload = '{"findings":[{"file":"src/login.ts","line":12}]}';
    const precedingPayload = '{"findings":[{"file":"src/session.ts","line":40}]}';
    const prompt = task({
      context: {
        ...context,
        research_payload: ownPayload,
        preceding_research_payload: precedingPayload,
      },
    });

    it("carries the preceding payload whole in its own section", () => {
      expect(prompt).toContain("## Research behind the input artifact\n");
      expect(prompt).toContain(precedingPayload);
    });

    it("keeps the job's own payload in its own section after the preceding one", () => {
      const ownAt = prompt.indexOf(ownPayload);
      expect(ownAt).toBeGreaterThan(prompt.indexOf("## Research payload"));
      expect(ownAt).toBeGreaterThan(prompt.indexOf(precedingPayload));
    });

    it("puts the preceding payload after the artifacts of earlier stages", () => {
      expect(prompt.indexOf(precedingPayload)).toBeGreaterThan(
        prompt.indexOf("## Artifacts from earlier stages"),
      );
    });
  });

  describe("a task whose input is an artifact no job of the workflow produced", () => {
    const prompt = task({
      context: {
        ...context,
        input_artifact: { kind: "page", url: "https://docs.test/design", continued: false },
      },
    });

    it("links the artifact in its own section, after the artifacts of earlier stages", () => {
      expect(prompt).toContain("## Input artifact\n");
      expect(prompt).toContain("- page: https://docs.test/design");
      expect(prompt.indexOf("## Input artifact")).toBeGreaterThan(
        prompt.indexOf("## Artifacts from earlier stages"),
      );
    });
  });

  describe("a task that continues its input artifact", () => {
    const prompt = task({
      context: {
        ...context,
        input_artifact: {
          kind: "pull",
          url: "https://github.com/acme/app/pull/1",
          continued: true,
        },
      },
    });

    it("tells the author to change it in place on its branch", () => {
      expect(prompt).toContain("## Artifact to continue\n");
      expect(prompt).toContain(
        "Do not open another one:\n- pull: https://github.com/acme/app/pull/1",
      );
    });

    it("leaves out the input artifact section", () => {
      expect(prompt).not.toContain("## Input artifact");
    });
  });

  describe("a task whose input is not an artifact from outside", () => {
    it("leaves out the input artifact section", () => {
      expect(task()).not.toContain("## Input artifact");
    });
  });

  describe("a task whose input artifact came from a job with a selection", () => {
    const prompt = task({ context: { ...context, preceding_selection: "Rotate the token" } });

    it("names the option the person chose in its own section", () => {
      expect(prompt).toContain("## Selection behind the input artifact\n");
      expect(prompt).toContain("A person chose this option from it.");
      expect(prompt).toContain("\nRotate the token");
    });
  });

  describe("a task whose input artifact came from a job with no selection", () => {
    it("leaves out the selection behind the input artifact", () => {
      expect(task()).not.toContain("## Selection behind the input artifact");
    });
  });

  describe("a task with a brief from the orchestrator", () => {
    const prompt = task({ context: { ...context, brief: "  Add a retry.  " } });
    const briefAt = prompt.indexOf("## Brief from the orchestrator\nAdd a retry.");

    it("trims the brief into its own section", () => {
      expect(briefAt).toBeGreaterThan(0);
    });

    it("puts the brief above the request", () => {
      expect(briefAt).toBeLessThan(prompt.indexOf("## Request"));
    });
  });

  describe("a stage with no branch, no brief, no links, and no approved artifacts", () => {
    const prompt = task({
      context: { ...context, brief: "", links: [], previous_artifacts: [], branch: null },
    });

    it("leaves out the brief", () => {
      expect(prompt).not.toContain("## Brief");
    });

    it("leaves out the links", () => {
      expect(prompt).not.toContain("## Links");
    });

    it("leaves out the approved artifacts", () => {
      expect(prompt).not.toContain("## Approved artifacts");
    });

    it("still names the repository, because it is checked out", () => {
      expect(prompt).toContain("## Repository");
    });

    it("leaves out the branch line", () => {
      expect(prompt).not.toContain("You are on branch");
    });

    it("opens with the skill instruction and the request", () => {
      expect(prompt.startsWith(`${INSTRUCTIONS}\n\n## Request\nTitle: Fix login`)).toBe(true);
    });
  });

  describe("a stage with no repository", () => {
    const prompt = task({ context: { ...context, repo: null, branch: null } });

    it("leaves out the repository", () => {
      expect(prompt).not.toContain("## Repository");
    });
  });

  describe("a task with a branch and one without", () => {
    const prompts = [task(), task({ context: { ...context, branch: null } })];

    it("asks for a todo list", () => {
      for (const prompt of prompts) {
        expect(prompt).toContain("Keep a todo list for this task and keep it current.");
      }
    });

    it("asks for it even when the task looks short", () => {
      for (const prompt of prompts) {
        expect(prompt).toContain("even when the task looks short");
      }
    });

    it("puts the progress section above the output contract", () => {
      for (const prompt of prompts) {
        expect(prompt.indexOf("## Progress")).toBeGreaterThan(0);
        expect(prompt.indexOf("## Progress")).toBeLessThan(prompt.indexOf("## Output"));
      }
    });
  });
});

describe("resumePrompt", () => {
  describe("a task with no artifact and no turn text yet", () => {
    const prompt = resumePrompt({
      instructions: INSTRUCTIONS,
      context,
      artifact: ARTIFACT,
      artifactUrl: null,
      lastTurnTail: null,
      wake: "Resume where you left off.",
    });

    it("opens with the fresh workspace, the missing artifact, and the wake reason", () => {
      expect(prompt.split("\n").slice(0, 4)).toEqual([
        "You are resuming a task in a fresh workspace. Previous local state is gone.",
        "No artifact has been recorded yet.",
        "## What woke you",
        "Resume where you left off.",
      ]);
    });

    it("says nothing about an earlier turn", () => {
      expect(prompt).not.toContain("The end of your last turn text");
    });

    it("carries the todo list request", () => {
      expect(prompt).toContain("Keep a todo list for this task and keep it current.");
    });
  });

  describe("a task with an artifact and a turn text", () => {
    const prompt = resumePrompt({
      instructions: INSTRUCTIONS,
      context,
      artifact: ARTIFACT,
      artifactUrl: "https://github.com/acme/app/pull/7",
      lastTurnTail: "Opened the pull request.",
      wake: "CI failed.",
    });
    const lines = prompt.split("\n");

    it("names the artifact under review", () => {
      expect(lines[1]).toBe("The artifact under review: https://github.com/acme/app/pull/7");
    });

    it("carries the end of the last turn text", () => {
      expect(lines[2]).toBe("The end of your last turn text:");
      expect(lines[3]).toBe("Opened the pull request.");
    });

    it("lists the approved artifacts of the other stages", () => {
      expect(prompt).toContain("- design (page): https://notion.so/abc");
    });

    it("puts the wake reason above the task prompt", () => {
      expect(prompt.indexOf("CI failed.")).toBeLessThan(prompt.indexOf("Title: Fix login"));
    });

    it("carries the artifact into the task prompt", () => {
      expect(prompt).toContain("pull/7");
    });
  });
});
