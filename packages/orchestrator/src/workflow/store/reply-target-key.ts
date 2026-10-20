import type { ReplyTarget } from "@artfct-ai/contracts/inbound";

/**
 * The key of a reply target: the fields that name the place. A tracker session is its session id,
 * whatever issue and team fields came with it.
 */
export function replyTargetKey(target: ReplyTarget): string {
  switch (target.source) {
    case "tracker":
      return `tracker:${target.session_id}`;
    case "chat":
      return `chat:${target.channel}:${target.thread}`;
    case "code":
      return `code:${target.repo}#${target.pull}`;
    case "documents":
      return `documents:${target.page_id}`;
    default: {
      const unhandled: never = target;
      throw new Error(`unknown reply target ${String(unhandled)}`);
    }
  }
}
