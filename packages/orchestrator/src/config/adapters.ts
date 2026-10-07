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
export const DocsProvider = z.enum(["notion", "linear"]);
export type DocsProvider = z.infer<typeof DocsProvider>;

/** The document host and where it puts pages when a request names no place. */
export const DocumentsAdapter = z
  .strictObject({
    provider: DocsProvider.default("linear"),
    /** The default page parent, a link to a page or a database, on a host that nests pages. */
    page_parent: z.string().trim().min(1).optional(),
  })
  .refine((documents) => documents.page_parent === undefined || documents.provider !== "linear", {
    message:
      "page_parent is for a document host that nests pages. Linear puts the documents of a workflow in the project of its issue, or the agent asks.",
    path: ["page_parent"],
  });

/** One vendor per adapter capability, with that capability's settings. */
export const Adapters = z.strictObject({
  code: z.strictObject({ provider: CodeProvider.default("github") }).prefault({}),
  tracker: z.strictObject({ provider: TrackerProvider.default("linear") }).prefault({}),
  chat: z.strictObject({ provider: ChatProvider.default("slack") }).prefault({}),
  documents: DocumentsAdapter.prefault({}),
  gateway: GatewayAdapter.prefault({}),
});
export type Adapters = z.infer<typeof Adapters>;

/** The capabilities that serve an MCP server. Chat has none, so no agent asks for one. */
export type McpCapability = "code" | "tracker" | "docs";
