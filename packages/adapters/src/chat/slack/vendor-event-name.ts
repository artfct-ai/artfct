/** The vendor event of a member joining a channel, the app included. */
const MEMBER_JOINED_CHANNEL = "slack.member_joined_channel";

/** The vendor event name of a Slack event callback, from its inner event's type: `slack.<type>`. */
export function slackVendorEventName(innerType: string): string {
  return `slack.${innerType}`;
}

/** True for a member joining a channel, whose vendor event names the channel a firing reports in. */
export function isSlackJoinedChannelEventName(name: string): boolean {
  return name === MEMBER_JOINED_CHANNEL;
}
