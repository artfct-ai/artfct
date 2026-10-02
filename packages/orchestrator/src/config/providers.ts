import { z } from "zod";
import { GatewayProvider } from "./gateway";

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
export const DocsProvider = z.enum(["notion", "linear"]);
export type DocsProvider = z.infer<typeof DocsProvider>;

/** One vendor per adapter capability. Everything else in the config speaks in capabilities. */
export const Providers = z.object({
  code: CodeProvider.default("github"),
  tracker: TrackerProvider.default("linear"),
  chat: ChatProvider.default("slack"),
  docs: DocsProvider.default("linear"),
  /** The gateway every task sandbox routes through, and the orchestrator unless it names its own. */
  gateway: GatewayProvider.default("cloudflare"),
});
export type Providers = z.infer<typeof Providers>;

/** The capabilities that serve an MCP server. Chat has none, so no agent asks for one. */
export type McpCapability = "code" | "tracker" | "docs";
