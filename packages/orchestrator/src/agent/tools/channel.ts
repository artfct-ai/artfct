import { tool } from "ai";
import { z } from "zod";
import { turnRecipients } from "../../notify/recipients";
import { changeWorkflowStatus } from "../../workflow/lifecycle";
import type { ChatMessageRef } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";

/** The tool that ends a turn with nothing for the humans. The turn loop stops on it. */
export const STAY_SILENT = "stay_silent";
/** The tool that asks the humans a question. */
export const ASK = "ask";
/** The tool that tells the humans something when nobody wrote. The turn loop stops on it. */
export const TELL = "tell";
/**
 * The tool that sends the first reply to the person who wrote: a thumbs-up on their chat message,
 * or one line. It works once per turn.
 */
export const ACKNOWLEDGE = "acknowledge";
/** The tools a first reply may call. A person's turn does not offer other tools until one of them works. */
export const FIRST_REPLY_TOOLS = [ACKNOWLEDGE, ASK];
/** The reaction a clear instruction gets in place of words. */
export const THUMBS_UP = "thumbsup";

const reactionReply = z.object({ kind: z.literal("reaction") });
const textReply = z.object({ kind: z.literal("text"), text: z.string().min(1) });
const firstReplyInput = z.object({
  reply: z.discriminatedUnion("kind", [reactionReply, textReply]),
});
const textOnlyInput = z.object({ reply: textReply });

/** The input of an `acknowledge` call: a reaction on the chat messages, or one line. */
type FirstReplyInput = z.infer<typeof firstReplyInput>;

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
* **Reply first.** Your first step replies to the person who wrote, before any lookup, dispatch, or other tool call. The system does not offer other tools until you reply. Choose the reply that fits the message:
  * **Clear instruction**: when your only words would be "on it", call \`acknowledge\` with a reaction. It puts a thumbs-up on their message. Do not write anything else. The reaction is offered only for a message written in chat. Without it, send a short line.
  * **Request that is not clear-cut**: call \`acknowledge\` with one line that says what you are about to do, with the context the person needs, such as "I'll have the author check whether lighthouse fails on main too, and skip it if so."
  * **Question**: answer it in your closing text, in a few concise sentences. When the answer needs a lookup, first call \`acknowledge\` with one line that says what you check, such as "Checking the review chain now."
* **Call** \`acknowledge\` at most once per turn. It never holds the answer or the status. Do not repeat the answer in another message of the turn.
* **Filter** chat messages by recipient context. When the message is for someone else, end the turn without text.
* **Call** \`ask\` as your first reply if the message recipient or intent is ambiguous.

### Task Dispatch & Board Management
* **Dispatch** work requests via \`start_job\` (or \`prompt_task\` if active) after your first reply.
* **Stay quiet** after the first reply on a work request. Do not narrate. The board shows progress. Leave the closing text empty unless a dispatch failed. Then say what failed.
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

/**
 * Tools that talk to the humans in every channel bound to the workflow, or decide not to.
 * `chatMessages` are the chat messages people wrote for this turn. The first reply may react to them.
 */
export function channelTools(workflow: WorkflowRuntime, chatMessages: ChatMessageRef[] = []) {
  let acknowledged = false;
  const reactable = chatMessages.length > 0;
  const inputSchema: z.ZodType<FirstReplyInput> = reactable ? firstReplyInput : textOnlyInput;
  return {
    [ACKNOWLEDGE]: tool({
      description: reactable
        ? 'Your first reply to the person who wrote, before any other tool. A reaction puts a thumbs-up on their chat message, for a clear instruction where your only words would be "on it". A text is one short line that says what you are about to do, never the answer. It works once per turn.'
        : "Your first reply to the person who wrote, before any other tool: one short line that says what you are about to do, never the answer. It works once per turn.",
      inputSchema,
      execute: async ({ reply }) => {
        if (acknowledged) {
          throw new Error(
            "Already acknowledged this turn. An answer goes in your closing text. A question goes through ask.",
          );
        }
        switch (reply.kind) {
          case "reaction":
            await reactWithThumbsUp(workflow, chatMessages);
            acknowledged = true;
            return "Reacted with a thumbs-up.";
          case "text":
            acknowledged = true;
            await workflow.post({ type: "info", text: reply.text }, turnRecipients(workflow.state));
            return "Acknowledged.";
          default: {
            const unreachable: never = reply;
            throw new Error(`unhandled first reply ${JSON.stringify(unreachable)}`);
          }
        }
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

/** Put the thumbs-up on every chat message. Throws when the chat refuses one. */
async function reactWithThumbsUp(
  workflow: WorkflowRuntime,
  chatMessages: ChatMessageRef[],
): Promise<void> {
  const chat = workflow.chat();
  if (!chat) throw new Error("The chat cannot take a reaction now. Send a line instead.");
  for (const { channel, message } of chatMessages) {
    await chat.addReaction(channel, message, THUMBS_UP);
  }
}
