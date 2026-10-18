import type { VerbalCommand } from "@artfct-ai/contracts/inbound";

/** A verbal command read from a person's message, with the text an `instruct` carries. */
export type ParsedVerbalCommand = { control: VerbalCommand; rest: string };

/** A leading bot mention: a Slack `<@U123>` or a plain `@name`. */
const MENTION = /^\s*(?:<@[A-Z0-9]+>|@[\w.-]+)?\s*/i;
/** The whole message is one verb, with optional trailing punctuation. */
const BARE_VERB = /^(cancel|stop|pause|resume|continue|retry)\s*[.!?]*$/i;
/** `instruct` carries the text for the harness after it. */
const INSTRUCT = /^instruct\b[:\s]*/i;

/**
 * Read a verbal command from a person's message. A command verb counts only when it is the whole
 * message after a bot mention, so "Stop using mocks" is guidance, not a cancel. `instruct`
 * takes the rest of the message as its text.
 */
export function parseVerbalCommand(text: string): ParsedVerbalCommand | null {
  const body = text.replace(MENTION, "");
  const verb = BARE_VERB.exec(body.trimEnd());
  if (verb?.[1]) return { control: verbalCommandFor(verb[1].toLowerCase()), rest: "" };
  const instruct = INSTRUCT.exec(body);
  if (instruct) return { control: "instruct", rest: body.slice(instruct[0].length).trim() };
  return null;
}

function verbalCommandFor(word: string): VerbalCommand {
  switch (word) {
    case "cancel":
    case "stop":
      return "cancel";
    case "pause":
      return "pause";
    default:
      return "resume";
  }
}
