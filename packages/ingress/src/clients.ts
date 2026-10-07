import { SlackChat } from "@artfct-ai/adapters/chat/slack/chat";
import type { Chat } from "@artfct-ai/adapters/chat/types";
import { NotionDocuments } from "@artfct-ai/adapters/documents/notion/documents";
import type { Documents } from "@artfct-ai/adapters/documents/types";
import type { Env } from "./env";

/** The channel capabilities the routes call back into. A channel without credentials is null. */
export type ChannelClients = {
  chat: Chat | null;
  documents: Documents | null;
};

/** Clients built from the Worker secrets. */
export function clientsFromEnv(env: Env): ChannelClients {
  return {
    chat: env.SLACK_BOT_TOKEN ? new SlackChat(env.SLACK_BOT_TOKEN) : null,
    documents: env.NOTION_TOKEN ? new NotionDocuments(env.NOTION_TOKEN) : null,
  };
}
