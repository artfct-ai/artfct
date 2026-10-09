import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "bun:test";
import {
  CLOSING_TEXT_MARKER,
  producePagePrompt,
  revisePrompt,
} from "../src/prompts/model-author-prompt";
import { BLOCKING_REVIEW_OPENING } from "../src/prompts/review-prompt";
import type { TaskContext } from "../src/prompts/task-prompt";
import {
  ACK_TEXT,
  SCRIPTED_AUTHOR_OPTIONS,
  SCRIPTED_NO_REVIEW,
  SCRIPTED_REVIEW_REQUEST,
  scriptedDecision,
  stagesFromSystemPrompt,
} from "./scripted-model";

const SYSTEM = [
  "You are the orchestrator.",
  "",
  "## Stages (in order)",
  "- design: produces page. Harness mock, model mock-model.",
  "- implement: produces pull, needs a repository. Harness mock, model mock-model.",
  "",
  "## How to act",
  "- Rules.",
].join("\n");

function userPrompt(text: string, system = SYSTEM): LanguageModelV4Prompt {
  return [
    { role: "system", content: system },
    { role: "user", content: [{ type: "text", text }] },
  ];
}

function toolResult(toolName: string, value: string): LanguageModelV4Prompt[number] {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "1", toolName, output: { type: "text", value } }],
  };
}

function afterTool(toolName: string, value: string): LanguageModelV4Prompt {
  return [{ role: "system", content: SYSTEM }, toolResult(toolName, value)];
}

function afterAck(text: string, system = SYSTEM): LanguageModelV4Prompt {
  return [...userPrompt(text, system), toolResult("acknowledge", "Acknowledged.")];
}

const REQUEST =
  "[event kind=request job=none task=none artifact=none review=none pull_action=none]\nRepo: https://github.com/acme/app";

describe("stagesFromSystemPrompt", () => {
  describe("a prompt with a stage list", () => {
    it("reads the stage names in order", () => {
      expect(stagesFromSystemPrompt(SYSTEM)).toEqual(["design", "implement"]);
    });
  });

  describe("a prompt with no stage list", () => {
    it("falls back to one implement stage", () => {
      expect(stagesFromSystemPrompt("orchestrator")).toEqual(["implement"]);
    });
  });

  describe("a prompt whose stage list is empty", () => {
    it("falls back to one implement stage", () => {
      expect(stagesFromSystemPrompt("## Stages (in order)\n\n## How to act")).toEqual([
        "implement",
      ]);
    });
  });
});

describe("ScriptedModel contract", () => {
  describe("a request before anything else", () => {
    it("sends one line back", () => {
      expect(scriptedDecision(userPrompt(REQUEST))).toEqual({
        tool: "acknowledge",
        input: { text: ACK_TEXT },
      });
    });
  });

  describe("a request with a repository, once the line is posted", () => {
    it("plans every configured stage in that repository", () => {
      expect(scriptedDecision(afterAck(REQUEST))).toEqual({
        tool: "set_plan",
        input: {
          name: "Mock workflow",
          stages: ["design", "implement"],
          repo: "acme/app",
          page_parent: null,
          reason: "default: every configured stage in order",
        },
      });
    });

    describe("with a request that names a page parent", () => {
      it("plans under it", () => {
        expect(scriptedDecision(afterAck(`${REQUEST}\nPage parent: page-1`))).toMatchObject({
          tool: "set_plan",
          input: { page_parent: "page-1" },
        });
      });
    });

    describe("with a request that carries a title", () => {
      it("names the workflow after it", () => {
        expect(
          scriptedDecision(afterAck(`${REQUEST}\nTitle: Fix the login redirect`)),
        ).toMatchObject({
          tool: "set_plan",
          input: { name: "Fix the login redirect" },
        });
      });
    });

    describe("with a request that links a doc", () => {
      const withPage = `${REQUEST}\nheres a design doc https://docs.test/design-7 for a new service`;

      it("plans the stages after the first", () => {
        expect(scriptedDecision(afterAck(withPage))).toMatchObject({
          tool: "set_plan",
          input: { stages: ["implement"] },
        });
      });

      it("starts the first planned stage from the page", () => {
        const planned =
          "Plan set: implement, up to 3 jobs at once. Call start_job with stage implement and a brief for it.";
        expect(
          scriptedDecision([...userPrompt(withPage), toolResult("set_plan", planned)]),
        ).toEqual({
          tool: "start_job",
          input: {
            stage: "implement",
            brief: "Work the implement stage of the request.",
            artifact: "https://docs.test/design-7",
          },
        });
      });
    });

    describe("with a request that names a stage and links its issue", () => {
      const onIssue = `${REQUEST}\nStage: implement\nLinks: https://linear.app/acme/issue/ENG-43`;

      it("plans only that stage", () => {
        expect(scriptedDecision(afterAck(onIssue))).toMatchObject({
          tool: "set_plan",
          input: { stages: ["implement"], reason: "the request names the stage" },
        });
      });

      it("starts it on the issue", () => {
        const planned =
          "Plan set: implement, up to 3 jobs at once. Call start_job with stage implement and a brief for it.";
        expect(scriptedDecision([...userPrompt(onIssue), toolResult("set_plan", planned)])).toEqual(
          {
            tool: "start_job",
            input: {
              stage: "implement",
              brief: "Work the implement stage of the request.",
              issue: "ENG-43",
            },
          },
        );
      });
    });

    describe("with a request that links an issue and names no stage", () => {
      it("starts the first stage without the issue", () => {
        const withIssue = `${REQUEST}\nLinks: https://linear.app/acme/issue/ENG-43`;
        const planned =
          "Plan set: design -> implement, up to 3 jobs at once. Call start_job with stage design and a brief for it.";
        expect(
          scriptedDecision([...userPrompt(withIssue), toolResult("set_plan", planned)]),
        ).toEqual({
          tool: "start_job",
          input: { stage: "design", brief: "Work the design stage of the request." },
        });
      });
    });

    describe("with a system prompt that lists no stage", () => {
      it("plans one implement stage", () => {
        expect(scriptedDecision(afterAck(REQUEST, "orchestrator"))).toMatchObject({
          tool: "set_plan",
          input: { stages: ["implement"] },
        });
      });
    });
  });

  describe("a request with no repository linked, once the line is posted", () => {
    const text =
      "[event kind=request job=none task=none artifact=none review=none pull_action=none]\nfix it";

    it("asks for one", () => {
      expect(scriptedDecision(afterAck(text))).toMatchObject({ tool: "ask" });
    });
  });

  describe("the result of set_plan", () => {
    it("starts the stage the result names", () => {
      const planned =
        "Plan set: design -> implement, up to 3 jobs at once. Call start_job with stage design and a brief for it.";
      expect(scriptedDecision(afterTool("set_plan", planned))).toEqual({
        tool: "start_job",
        input: { stage: "design", brief: "Work the design stage of the request." },
      });
    });

    it("starts the implement stage when the result names none", () => {
      expect(scriptedDecision(afterTool("set_plan", "ok"))).toEqual({
        tool: "start_job",
        input: { stage: "implement", brief: "Work the implement stage of the request." },
      });
    });
  });

  describe("the result of complete_job", () => {
    it("starts the next stage the result names", () => {
      const next =
        "Job j1 done. Next stage: implement. Call start_job with stage implement and a brief for it.";
      expect(scriptedDecision(afterTool("complete_job", next))).toEqual({
        tool: "start_job",
        input: { stage: "implement", brief: "Work the implement stage of the request." },
      });
    });

    it("finishes the workflow after the last planned stage", () => {
      const last =
        "Job j2 done. That was the last planned stage. Call finish_workflow when the work is complete, or start_job for more.";
      expect(scriptedDecision(afterTool("complete_job", last))).toEqual({
        tool: "finish_workflow",
        input: { result: "Every planned stage is done." },
      });
    });

    it("says nothing while the stage stays open", () => {
      const open = "Job j1 done. Stage implement stays open with 1 running and 2 free slots.";
      expect(scriptedDecision(afterTool("complete_job", open))).toEqual({ text: "" });
    });
  });

  describe("a reply about a document under review", () => {
    it("judges a plain yes as acceptance of the document", () => {
      const yes =
        "[event kind=prompt job=j1 task=t1 artifact=page review=in_review pull_action=none]\nFrom: Dev via tracker\n\nlooks good, go ahead";
      expect(scriptedDecision(userPrompt(yes))).toEqual({
        tool: "complete_job",
        input: { job_id: "j1", result: "Approved." },
      });
    });

    it("judges an approving reaction the same way", () => {
      const reaction =
        "[event kind=prompt job=j1 task=t1 artifact=page review=in_review pull_action=none]\nFrom: Dev via chat\n\nreacted with :white_check_mark:";
      expect(scriptedDecision(userPrompt(reaction))).toEqual({
        tool: "complete_job",
        input: { job_id: "j1", result: "Approved." },
      });
    });

    it("completes the job on the option a reply selects", () => {
      const selection =
        "[event kind=prompt job=j1 task=t1 artifact=page review=in_review pull_action=none]\nFrom: Dev via chat\n\ngo with Feature flag";
      expect(scriptedDecision(userPrompt(selection))).toEqual({
        tool: "complete_job",
        input: { job_id: "j1", result: "Selected Feature flag.", option: "Feature flag" },
      });
    });

    it("sends a request for a change to the task", () => {
      const change =
        "[event kind=prompt job=j1 task=t1 artifact=page review=in_review pull_action=none]\nFrom: Dev via tracker\n\ntighten the intro";
      expect(scriptedDecision(userPrompt(change))).toEqual({
        tool: "prompt_task",
        input: { task_id: "t1", text: change },
      });
    });
  });

  describe("the result of status", () => {
    it("answers with the tool text", () => {
      expect(scriptedDecision(afterTool("status", "Cost so far: $0"))).toEqual({
        text: "Cost so far: $0",
      });
    });
  });

  describe("a CI event", () => {
    it("stays silent, since the system routes it", () => {
      const ci =
        "[event kind=ci_event job=j1 task=t1 artifact=pull status=drafted pull_action=completed]";
      expect(scriptedDecision(userPrompt(ci))).toEqual({ text: "" });
    });
  });

  describe("what a person said on a pull request", () => {
    it("sends it to the task, since the system sends it to nobody", () => {
      const said =
        "[event kind=feedback job=j1 task=t1 artifact=pull status=drafted pull_action=comment]\nFrom: Dev\n\nadd a test";
      expect(scriptedDecision(userPrompt(said))).toEqual({
        tool: "prompt_task",
        input: { task_id: "t1", text: said },
      });
    });

    it("stays silent when no task is named", () => {
      const said =
        "[event kind=feedback job=none task=none artifact=none status=none pull_action=comment]";
      expect(scriptedDecision(userPrompt(said))).toEqual({ text: "" });
    });
  });

  describe("a merged pull request", () => {
    it("completes the job", () => {
      const merged =
        "[event kind=pr_event job=j1 task=t1 artifact=pull status=ready pull_action=merged]";
      expect(scriptedDecision(userPrompt(merged))).toEqual({
        tool: "complete_job",
        input: { job_id: "j1", result: "Pull request merged." },
      });
    });
  });

  describe("a note", () => {
    it("says nothing", () => {
      expect(scriptedDecision(userPrompt("[note]\nturn ended"))).toEqual({ text: "" });
    });
  });

  describe("a reviewed artifact handed back to route", () => {
    const note = [
      "[note]",
      "The agent review of https://www.notion.so/acme/design-1 in job wf_a-1 is with you. Its author wf_a.1 is idle after a reviewer run.",
      "Read what it said with read_task, and the artifact itself when that is not enough.",
    ].join("\n");

    it("asks for another review", () => {
      expect(scriptedDecision(userPrompt(note))).toEqual({
        tool: "request_review",
        input: { job_id: "wf_a-1" },
      });
    });

    it("says nothing after the review started", () => {
      expect(
        scriptedDecision(afterTool("request_review", "A review started on job wf_a-1.")),
      ).toEqual({
        text: "",
      });
    });
  });
});

const AUTHOR_CONTEXT: TaskContext = {
  title: "Fix the redirect",
  text: "The login redirect loses the session.",
  links: [],
  repo: null,
  branch: null,
  brief: "",
  previous_artifacts: [],
  research_payload: '{"findings":["src/auth/redirect.ts:42"]}',
  input_artifact: null,
  preceding_research_payload: null,
  preceding_selection: null,
  ending: "choice",
  page_parent: null,
};

function documentText(decision: ReturnType<typeof scriptedDecision>): string {
  if (!("text" in decision)) throw new Error("the scripted author answered with a tool call");
  return decision.text;
}

describe("the scripted model-call author", () => {
  describe("a first document from an input page", () => {
    const text = documentText(
      scriptedDecision(
        userPrompt(
          producePagePrompt({ context: AUTHOR_CONTEXT, inputPageText: "## Design\nUse SAML." }),
          "Plan it.",
        ),
      ),
    );

    it("carries the text of the input page", () => {
      expect(text).toContain("## Direction\n## Design\nUse SAML.");
    });
  });

  describe("a first document on a choice ending", () => {
    const text = documentText(
      scriptedDecision(
        userPrompt(producePagePrompt({ context: AUTHOR_CONTEXT, inputPageText: null }), "Plan it."),
      ),
    );

    it("carries the research payload it was given", () => {
      expect(text).toContain('{"findings":["src/auth/redirect.ts:42"]}');
    });

    it("has no direction section without an input page", () => {
      expect(text).not.toContain("## Direction");
    });

    it("lists the scripted options as proposed options", () => {
      expect(text).toContain("## Proposed Options\n1. Feature flag\n2. Direct fix");
      expect(SCRIPTED_AUTHOR_OPTIONS).toEqual(["Feature flag", "Direct fix"]);
    });

    it("carries no revision", () => {
      expect(text).not.toContain("## Revision");
    });
  });

  describe("a revision", () => {
    const text = documentText(
      scriptedDecision(
        userPrompt(
          revisePrompt({
            context: { ...AUTHOR_CONTEXT, ending: "acceptance" },
            inputPageText: null,
            findings: "Add a rollback step.",
            pageText: "## Plan\nThe first draft.",
          }),
          "Revise it.",
        ),
      ),
    );

    it("keeps the page it was given", () => {
      expect(text).toContain("## Plan\nThe first draft.");
    });

    it("names the change it was asked for", () => {
      expect(text).toContain("Revised for: Add a rollback step.");
    });

    it("lists no options on an acceptance ending", () => {
      expect(text).not.toContain("## Proposed Options");
    });

    it("ends with a closing text that needs no review", () => {
      expect(text.endsWith(`${CLOSING_TEXT_MARKER}\n${SCRIPTED_NO_REVIEW}`)).toBe(true);
    });
  });

  describe("a revision after a review that asked for changes", () => {
    const text = documentText(
      scriptedDecision(
        userPrompt(
          revisePrompt({
            context: { ...AUTHOR_CONTEXT, ending: "acceptance" },
            inputPageText: null,
            findings: `${BLOCKING_REVIEW_OPENING}\nAdd a rollback step.`,
            pageText: "## Plan\nThe first draft.",
          }),
          "Revise it.",
        ),
      ),
    );

    it("asks for another review in its closing text", () => {
      expect(text.endsWith(`${CLOSING_TEXT_MARKER}\n${SCRIPTED_REVIEW_REQUEST}`)).toBe(true);
    });
  });
});
