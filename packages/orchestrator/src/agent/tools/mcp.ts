import type { ToolSet } from "ai";
import type { Config } from "../../config/config";
import { orchestratorMcp, type OrchestratorMcp } from "../../clients";
import type { McpCapability } from "../../config/providers";

/** What one connection passes to the Agents SDK MCP client. */
export type McpConnectOptions = {
  /** The id the SDK holds the connection under. A connection already under it is replaced. */
  reconnect: { id: string };
  transport: { requestInit: { headers: Record<string, string> }; type: "streamable-http" };
};

/** The subset of the Workflow DO that an MCP connection needs. The DO satisfies it. Tests fake it. */
export type McpHost = {
  config(): Config;
  mcpCredential(capability: McpCapability): Promise<string | null>;
  /** The credential the connected server holds. The DO keeps it for as long as it lives. */
  connectedMcpCredential: string | null;
  log(taskId: string | null, line: string): void;
  mcp: { connect(url: string, options: McpConnectOptions): Promise<unknown> };
};

/**
 * Connect the orchestrator agent's MCP server through the Agents SDK client and return it.
 * A server already connected with the current credential is left as it is. The connection lives
 * in memory only. The SDK's `addMcpServer` would write the credential into the Durable Object.
 */
export async function connectOrchestratorMcp(host: McpHost): Promise<OrchestratorMcp | null> {
  const credential = await host.mcpCredential("tracker");
  const connected = orchestratorMcp({
    providers: host.config().providers,
    credential,
    log: (line) => host.log(null, line),
  });
  if (!connected) return null;
  const { server } = connected;
  if (host.connectedMcpCredential === credential) return connected;
  try {
    await host.mcp.connect(server.url, {
      reconnect: { id: server.name },
      transport: { requestInit: { headers: server.headers }, type: "streamable-http" },
    });
    host.connectedMcpCredential = credential;
    host.log(null, `mcp connected: ${server.name}`);
  } catch (error) {
    host.log(null, `mcp ${server.name} failed: ${String(error).slice(0, 300)}`);
  }
  return connected;
}

/** The MCP tools the agent may call: those its server allows, keyed as the SDK keys them. */
export function allowedMcpTools(connected: OrchestratorMcp | null, tools: ToolSet): ToolSet {
  if (!connected) return tools;
  const prefix = `tool_${connected.server.name.replace(/-/g, "")}_`;
  const kept = Object.entries(tools).filter(([key]) => {
    if (!key.startsWith(prefix)) return true;
    return connected.tools.includes(key.slice(prefix.length));
  });
  return Object.fromEntries(kept);
}
