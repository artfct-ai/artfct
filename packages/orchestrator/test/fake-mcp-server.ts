type JsonRpcCall = { id?: number | string; method: string; params?: { protocolVersion?: string } };

/** The tool names a `fakeMcpServerAnswer` lists. */
export type FakeMcpServer = { tools: string[] };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function resultOf(call: JsonRpcCall, server: FakeMcpServer): unknown {
  switch (call.method) {
    case "initialize":
      return {
        protocolVersion: call.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      };
    case "tools/list":
      return {
        tools: server.tools.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", properties: {} },
        })),
      };
    default:
      return null;
  }
}

/** Answer one request the way a streamable HTTP MCP server with only tools does. */
export async function fakeMcpServerAnswer(
  request: Request,
  server: FakeMcpServer,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const call: JsonRpcCall = await request.json();
  if (call.id === undefined) return new Response(null, { status: 202 });
  const result = resultOf(call, server);
  if (result) return json({ jsonrpc: "2.0", id: call.id, result });
  return json({
    jsonrpc: "2.0",
    id: call.id,
    error: { code: -32601, message: "Method not found" },
  });
}
