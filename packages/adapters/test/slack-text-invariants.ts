/** The opening of a Slack tag that notifies: a user, a user group, or a broadcast. */
const NOTIFYING_TAG_OPENING = /<[!@]/;

/** A surrogate half without its partner. A surrogate pair matches as one code point. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Every character the chat shows as space, which a chunk may drop at its ends. */
const WHITESPACE = /\s/g;

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/** The mrkdwn posted to chat holds no tag that notifies a person or a channel, for any input. */
export function slackTextNeverNotifies(mrkdwn: string): void {
  const opening = NOTIFYING_TAG_OPENING.exec(mrkdwn);
  if (!opening) return;
  violated(
    "slackTextNeverNotifies",
    `the mrkdwn holds a live tag at ${opening.index}: ${JSON.stringify(mrkdwn.slice(opening.index, opening.index + 40))}`,
  );
}

/**
 * Each chunk holds at most the limit and does not end inside a surrogate pair. The chunks hold
 * the non-whitespace characters of the text in order.
 */
export function slackChunksKeepTheText(text: string, chunks: string[], limit: number): void {
  const name = "slackChunksKeepTheText";
  const long = chunks.findIndex((chunk) => chunk.length > limit);
  if (long !== -1) violated(name, `chunk ${long} holds ${chunks[long]?.length} of ${limit}`);
  const broken = chunks.findIndex((chunk) => LONE_SURROGATE.test(chunk));
  if (!LONE_SURROGATE.test(text) && broken !== -1) {
    violated(name, `chunk ${broken} splits a surrogate pair: ${JSON.stringify(chunks[broken])}`);
  }
  const kept = chunks.join("").replace(WHITESPACE, "");
  if (kept !== text.replace(WHITESPACE, "")) {
    violated(name, `the chunks hold ${JSON.stringify(kept)}`);
  }
}

/** Converting the mrkdwn a second time returns it unchanged. */
export function slackMrkdwnIsStable(once: string, twice: string): void {
  if (twice === once) return;
  violated("slackMrkdwnIsStable", `${JSON.stringify(once)} became ${JSON.stringify(twice)}`);
}
