import { z } from "zod";
import { GatewayAdapter } from "./gateway";

/** The code host every pull request lives on. */
export const CodeProvider = z.enum(["github"]);
export type CodeProvider = z.infer<typeof CodeProvider>;

/** The tracker every issue lives on. */
export const TrackerProvider = z.enum(["linear"]);
export type TrackerProvider = z.infer<typeof TrackerProvider>;

/** The chat the humans talk in. */
export const ChatProvider = z.enum(["slack"]);
export type ChatProvider = z.infer<typeof ChatProvider>;

/** The document host every page lives on. */
export const DocumentsProvider = z.enum(["notion", "linear"]);
export type DocumentsProvider = z.infer<typeof DocumentsProvider>;

/** One vendor per adapter capability, with that capability's settings. */
export const Adapters = z.strictObject({
  code: z.strictObject({ provider: CodeProvider.default("github") }).prefault({}),
  tracker: z.strictObject({ provider: TrackerProvider.default("linear") }).prefault({}),
  chat: z.strictObject({ provider: ChatProvider.default("slack") }).prefault({}),
  documents: z.strictObject({ provider: DocumentsProvider.default("linear") }).prefault({}),
  gateway: GatewayAdapter.prefault({}),
});
export type Adapters = z.infer<typeof Adapters>;

/** The capabilities that serve an MCP server. Chat has none, so no agent asks for one. */
export type McpCapability = "code" | "tracker" | "documents";
