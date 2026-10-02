/** One summarization job: the name its usage is recorded under, and its system text. */
export type SummarizationPrompt = { name: string; system: string };

/** Shortens the turn text of a harness turn for a digest. The caller sets the length. */
export const DIGEST_TURN_TEXT_PROMPT: SummarizationPrompt = {
  name: "summarize",
  system:
    "You summarize text for an agent or human that reads your summary instead of the original. Say what happened, what it produced, and anything it left open or blocked on. Keep every file path, URL, and identifier a later step needs. Write plain prose without markdown or preamble.",
};

/** Writes the recap that compaction puts in place of the older transcript rows. */
export const COMPACT_PROMPT: SummarizationPrompt = {
  name: "compact",
  system:
    "Summarize this orchestration transcript for your future self. Keep decisions, open questions, artifact links, and what the humans asked for. Drop your own narration, repeated status lines, and tool output that the live state in your system prompt already holds. Write plain text without markdown or preamble.",
};

/** Writes a condensed result in place of a tool result that passed the size limit. */
export const CONDENSE_PROMPT: SummarizationPrompt = {
  name: "condense",
  system:
    "Condense this tool result for the agent that called the tool. It reads your text instead of the result. Keep every identifier, URL, file path, name, date, and count. Keep the structure of a list, and say how many items it had. End with one line that names the kinds of content you left out, so the agent knows what a more precise query can reach. Write plain text without markdown or preamble.",
};
