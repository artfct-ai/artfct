import { z } from "zod";
import { CodeProvider, DocsProvider, TrackerProvider } from "./providers";

/** An MCP server reached over the network. Any value may reference a secret as `${NAME}`. */
const RemoteMcpServerEntry = z.strictObject({
  name: z.string().min(1),
  url: z.string().min(1),
  type: z.enum(["http", "sse"]).default("http"),
  headers: z.record(z.string(), z.string()).default({}),
});

/** An MCP server the harness starts as a process in the sandbox. */
const CommandMcpServerEntry = z.strictObject({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

/** One MCP server of the customer's, as `artfct.yaml` lists it. */
export const McpServerEntry = z.union([RemoteMcpServerEntry, CommandMcpServerEntry]);
export type McpServerEntry = z.infer<typeof McpServerEntry>;

/** Each provider's MCP server takes the provider's name, so no MCP server of the customer's may. */
const PROVIDER_NAMES: ReadonlySet<string> = new Set([
  ...CodeProvider.options,
  ...TrackerProvider.options,
  ...DocsProvider.options,
]);

/** The customer's MCP servers, added to every harness session. Names are unique. */
export const McpServers = z.array(McpServerEntry).superRefine((entries, context) => {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (PROVIDER_NAMES.has(entry.name)) {
      context.addIssue({
        code: "custom",
        path: [index, "name"],
        message: `${entry.name} is the name of a provider's MCP server`,
      });
    }
    if (seen.has(entry.name)) {
      context.addIssue({
        code: "custom",
        path: [index, "name"],
        message: `${entry.name} names two MCP servers`,
      });
    }
    seen.add(entry.name);
  }
});
