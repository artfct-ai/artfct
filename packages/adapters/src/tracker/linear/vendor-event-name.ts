/** The vendor event name of a Linear webhook, from its type and action: `linear.<type>.<action>`. */
export function linearVendorEventName(type: string, action: string): string {
  return `linear.${type}.${action}`;
}
