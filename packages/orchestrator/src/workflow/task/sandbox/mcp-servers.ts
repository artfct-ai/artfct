import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpServer as ProviderMcpServer } from "@artfct-ai/adapters/mcp";
import type { McpServerEntry } from "../../../config/mcp-servers";

const SECRET_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The MCP servers a harness session connects to: the provider's, then the customer's with each
 * `${NAME}` replaced by that secret. A customer server that references an unset secret is skipped
 * with one line on `log`.
 */
export function harnessMcpServers(options: {
  provider: ProviderMcpServer | null;
  configured: McpServerEntry[];
  secret: (name: string) => string | undefined;
  log: (line: string) => void;
}): McpServer[] {
  const { provider, configured, secret, log } = options;
  const customer = configured.flatMap((entry) => {
    const missing = new Set<string>();
    const fill = (text: string) =>
      text.replace(SECRET_REFERENCE, (_reference, name: string) => {
        const value = secret(name);
        if (value) return value;
        missing.add(name);
        return "";
      });
    const server = acpMcpServer(entry, fill);
    if (missing.size === 0) return [server];
    log(`mcp ${entry.name} skipped: ${[...missing].join(", ")} unset`);
    return [];
  });
  if (!provider) return customer;
  const providerServer: McpServer = {
    type: provider.type,
    name: provider.name,
    url: provider.url,
    headers: Object.entries(provider.headers).map(([name, value]) => ({ name, value })),
  };
  return [providerServer, ...customer];
}

function acpMcpServer(entry: McpServerEntry, fill: (text: string) => string): McpServer {
  if ("command" in entry) {
    return {
      name: entry.name,
      command: fill(entry.command),
      args: entry.args.map(fill),
      env: nameValues(entry.env, fill),
    };
  }
  return {
    type: entry.type,
    name: entry.name,
    url: fill(entry.url),
    headers: nameValues(entry.headers, fill),
  };
}

function nameValues(values: Record<string, string>, fill: (text: string) => string) {
  return Object.entries(values).map(([name, value]) => ({ name, value: fill(value) }));
}
