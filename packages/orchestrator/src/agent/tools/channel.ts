import { tool } from "ai";
import { z } from "zod";
import { turnRecipients } from "../../notify/recipients";
import { changeWorkflowStatus } from "../../workflow/lifecycle";
import type { WorkflowRuntime } from "../../workflow/types";

/** The tool that ends a turn with nothing for the humans. The turn loop stops on it. */
export const STAY_SILENT = "stay_silent";
/** The tool that asks the humans a question. */
export const ASK = "ask";
/** The tool that tells the humans something when nobody wrote. The turn loop stops on it. */
export const TELL = "tell";
/** The tool that sends the one line back to the person who wrote. It works once per turn. */
export const ACKNOWLEDGE = "acknowledge";

/** How the agent speaks in every turn. Kept next to the tools that speak, so the two cannot drift apart. */
export const CHANNEL_RULES = `## Communication & Response Protocol

### Artifact & External Comments
* **Isolate** artifact feedback replies exclusively to the artifact interface.
* **Inspect** issue/document threads before commenting; abort submission if the response is already present.
* **Link** every issue, pull request, and page you name. Write it as a Markdown link to its URL, such as \`[ENG-42](<issue url>)\`.

### Invariants & Exclusions
* **Prohibit Narrative Status**: DO NOT state that a task is running, narrate execution progress, or manually post artifact links in chat UNLESS you are woken to do this specifically.
* **Prohibit Non-Action Reports**: DO NOT state what the turn did not do. If you are asked a question, just answer the question and no more. Do not state that you did not take a workflow action.
* **Prohibit Chat Relays**: Never mirror or reference artifact-level review feedback in general chat channels.
* **Prohibit Duplicate Posting**: Never post identical responses to issues or documents.
* **Prohibit Comment Retractions**: Never edit previously posted comments to label them duplicates, placeholders, or request they be ignored.`;

/** How the agent answers in a turn where a person wrote. */
export const PERSON_WROTE_RULES = `### Inbound Message Handling
* **Answer** in your closing text. A question or a status check gets the direct answer in a few concise sentences. No other message of the turn repeats it.
* **Call** \`acknowledge("<next_action>")\` at most once per turn, and only before a lookup or a dispatch the person must wait on. It is one short line that says what you do next, such as "Checking the review chain now." It never holds the answer or the status.
* **Skip** \`acknowledge\` when you can answer without a lookup. Your closing text is then the only message of the turn.
* **Filter** chat messages by recipient context; ignore messages directed to others.
* **Call** \`ask\` immediately if message recipient or intent is ambiguous.

### Task Dispatch & Board Management
* **Dispatch** work requests via \`start_job\` (or \`prompt_task\` if active).
* **Terminate** work request turns with zero response text; the auto-generated board represents the sole turn reply.
* **Query** task status directly and output current harness reports if a user reports a missing or empty board.`;

/** How the agent ends a turn where nobody wrote. */
export const NOBODY_WROTE_RULES = `### Autonomous (Unprompted) Turn Routing
When execution occurs without an inbound user message, standard closing text is suppressed. Terminate via one of the following tools:

* **DECISION_REQUIRED**: Call \`ask\` when human input is blocked.
* **SYSTEM_ALERT**: Call \`tell\` to report harness errors or workflow failures.
* **IDLE_COMPLETE**: Call \`stay_silent\` when no user intervention or alert is needed.

### Automated Failure Handling
* **Call** \`stay_silent\` on CI failures and merge conflict notifications; prompts are pre-dispatched by the system.

### Artifact Review Turns
* **Call** \`stay_silent\` on artifact review turns unless an escalation via \`ask\` is required.`;

/** Tools that talk to the humans in every channel bound to the workflow, or decide not to. */
export function channelTools(workflow: WorkflowRuntime) {
  let acknowledged = false;
  return {
    [ACKNOWLEDGE]: tool({
      description:
        "One short line to the person who wrote to you, before a lookup or a dispatch they must wait on: what you do next, never the answer. Skip it when you can answer at once. It works once per turn.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        if (acknowledged) {
          throw new Error(
            "Already acknowledged this turn. An answer goes in your closing text. A question goes through ask.",
          );
        }
        acknowledged = true;
        await workflow.post({ type: "info", text }, turnRecipients(workflow.state));
        return "Acknowledged.";
      },
    }),
    [ASK]: tool({
      description:
        "Ask the humans a question and wait for the answer. The question is the last message of this turn. A running workflow shows as waiting for input until a job runs.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        const running = workflow.state.status === "running";
        if (running && !workflow.store.activeAuthorAndResearcherTasks().length)
          await changeWorkflowStatus(workflow, "waiting_input");
        await workflow.post({ type: "question", text }, turnRecipients(workflow.state));
        return "Asked. The answer arrives as a new message.";
      },
    }),
    [TELL]: tool({
      description:
        "Tell the humans something they need to know when nobody wrote to you: a problem a harness raised, or work that went wrong. Not for progress, and not for an artifact that is ready. It is the last message of this turn.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        await workflow.post({ type: "info", text }, turnRecipients(workflow.state));
        return "Told.";
      },
    }),
    [STAY_SILENT]: tool({
      description:
        "End your turn without posting anything. Call it when nobody wrote to you and nothing needs saying. The turn ends right away.",
      inputSchema: z.object({}),
      execute: async () => "Silent.",
    }),
  };
}
