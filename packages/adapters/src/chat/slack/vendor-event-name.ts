/** The vendor event name of a Slack event callback, from its inner event's type: `slack.<type>`. */
export function slackVendorEventName(innerType: string): string {
  return `slack.${innerType}`;
}
