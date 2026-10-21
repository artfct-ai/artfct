/** The vendor event name of a Notion webhook, from its type: `notion.<type>`. */
export function notionVendorEventName(type: string): string {
  return `notion.${type}`;
}
