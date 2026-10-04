import type { Control } from "@artfct-ai/contracts/inbound";

export type ParsedControl = { control: Control; rest: string };

/** A leading bot mention: a Slack `<@U123>` or a plain `@name`. */
const MENTION = /^\s*(?:<@[A-Z0-9]+>|@[\w.-]+)?\s*/i;
/** The whole message is one verb, with optional trailing punctuation. */
const BARE_VERB = /^(cancel|stop|pause|resume|continue|retry)\s*[.!?]*$/i;
/** `instruct` carries the text for the harness after it. */
const INSTRUCT = /^instruct\b[:\s]*/i;

/**
 * Read a control word from a human message. A control verb counts only when it is the whole
 * message after a bot mention, so "Stop using mocks" is guidance, not a cancel. `instruct`
 * takes the rest of the message as its text.
 */
export function parseControl(text: string): ParsedControl | null {
  const body = text.replace(MENTION, "");
  const verb = BARE_VERB.exec(body.trimEnd());
  if (verb?.[1]) return { control: controlFor(verb[1].toLowerCase()), rest: "" };
  const instruct = INSTRUCT.exec(body);
  if (instruct) return { control: "instruct", rest: body.slice(instruct[0].length).trim() };
  return null;
}

function controlFor(word: string): Control {
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
