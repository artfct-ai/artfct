/** One MCP server an agent connects to, with the credential already in its headers. */
export type McpServer = {
  name: string;
  type: "http";
  url: string;
  headers: Record<string, string>;
};
