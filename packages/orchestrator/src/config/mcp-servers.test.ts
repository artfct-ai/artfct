import { describe, expect, it } from "bun:test";
import { McpServers } from "./mcp-servers";

describe("McpServers", () => {
  it("reads a remote server over http by default with no headers", () => {
    expect(McpServers.parse([{ name: "vendor", url: "https://mcp.example.com" }])).toEqual([
      { name: "vendor", url: "https://mcp.example.com", type: "http", headers: {} },
    ]);
  });

  it("reads a command server with no args and no env", () => {
    expect(McpServers.parse([{ name: "vendor", command: "npx" }])).toEqual([
      { name: "vendor", command: "npx", args: [], env: {} },
    ]);
  });

  it("refuses a server with both a url and a command", () => {
    const entry = { name: "vendor", url: "https://mcp.example.com", command: "npx" };
    expect(McpServers.safeParse([entry]).success).toBe(false);
  });

  it("refuses two servers with one name", () => {
    const entry = { name: "vendor", url: "https://mcp.example.com" };
    expect(McpServers.safeParse([entry, entry]).success).toBe(false);
  });

  it("refuses the name of a provider's server", () => {
    expect(McpServers.safeParse([{ name: "linear", command: "npx" }]).success).toBe(false);
  });
});
