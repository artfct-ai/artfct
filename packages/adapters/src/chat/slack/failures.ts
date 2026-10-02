import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";

/** What each Slack error code means for a reader, and who can fix it. */
const FAILURES: Record<string, string> = {
  not_in_channel:
    "the bot is not a member of that channel. A human has to invite it there before it can read.",
  channel_not_found: "Slack has no such channel, or the bot cannot see it.",
  is_archived: "the channel is archived, so its history is closed.",
  missing_scope:
    "the Slack app may not read history. An admin has to add the history scopes and reinstall it.",
  not_allowed_token_type: "this Slack token may not read history.",
  invalid_auth: "the Slack token is not valid.",
  account_inactive: "the Slack token belongs to a deactivated account.",
  thread_not_found: "Slack has no thread at that timestamp.",
  invalid_ts_latest: "that timestamp is not a Slack message timestamp.",
  invalid_ts_oldest: "that timestamp is not a Slack message timestamp.",
  invalid_cursor: "that cursor is not one Slack gave out. Read the page again without it.",
};

/**
 * One sentence a reader can act on for a failed Slack call. A rate limit says how long to
 * wait. A Slack error code says who can fix it. Anything else falls back to the error text.
 */
export function describeSlackFailure(error: unknown): string {
  if (error instanceof WebAPIRateLimitedError) {
    return `Slack rate limited this call. Try again in ${error.retryAfter} seconds.`;
  }
  if (error instanceof WebAPIPlatformError) {
    return FAILURES[error.data.error] ?? `Slack refused the call: ${error.data.error}.`;
  }
  if (error instanceof WebAPIHTTPError) {
    return `Slack answered HTTP ${error.statusCode} instead of a result.`;
  }
  if (error instanceof WebAPIRequestError) {
    return `Slack could not be reached: ${error.original.message.slice(0, 200)}`;
  }
  return `Slack failed: ${String(error).slice(0, 200)}`;
}
