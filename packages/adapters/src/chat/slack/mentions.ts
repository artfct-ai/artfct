/** Slack writes a user mention as `<@U…>`, with a `|label` after the id in older payloads. */
const USER_MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

/** The tag a message opens with: a user or a user group such as `<!subteam^S1|@eng>`. */
const OPENING_TAG = /^\s*(?:<@([A-Z0-9]+)(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>)/;

/** Every tag Slack writes, with the label each form carries captured. */
const ANY_TAG =
  /<@([A-Z0-9]+)(?:\|([^>]*))?>|<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>|<!(here|channel|everyone)>/g;

/** Every user id a message tags, in order, without repeats. */
export function mentionedUserIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(USER_MENTION)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

/** True when the message tags this app anywhere. */
export function tagsThisApp(text: string, ownUserId: string | undefined): boolean {
  return ownUserId !== undefined && mentionedUserIds(text).includes(ownUserId);
}

/** True when the message opens with a tag of somebody else. Only the opening tag counts. */
export function addressesSomeoneElse(text: string, ownUserId: string | undefined): boolean {
  const opening = OPENING_TAG.exec(text);
  if (!opening) return false;
  const openingUserId = opening[1];
  const opensWithAGroup = openingUserId === undefined;
  return opensWithAGroup || openingUserId !== ownUserId;
}

/** The message as a human reads it: this app's own tag dropped, every other tag left as `@name`. */
export function readableMentions(text: string, ownUserId: string | undefined): string {
  const readable = text.replace(ANY_TAG, readableTag(ownUserId));
  return closeTheGapLeftByDroppedTags(readable);
}

/** One tag as a human reads it. This app's own becomes nothing, an unlabeled group `@group`. */
function readableTag(ownUserId: string | undefined) {
  return (
    _whole: string,
    userId?: string,
    userLabel?: string,
    groupLabel?: string,
    broadcast?: string,
  ) => {
    if (broadcast) return `@${broadcast}`;
    if (groupLabel) return groupLabel.startsWith("@") ? groupLabel : `@${groupLabel}`;
    if (userId === undefined) return "@group";
    if (userId === ownUserId) return "";
    return `@${userLabel || userId}`;
  };
}

function closeTheGapLeftByDroppedTags(text: string): string {
  return text.replace(/[^\S\n]{2,}/g, " ").trim();
}
