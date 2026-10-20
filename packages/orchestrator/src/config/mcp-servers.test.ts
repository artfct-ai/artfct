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

  it("refuses a server that references a secret of the Worker's own", () => {
    const entry = {
      name: "vendor",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer ${GITHUB_PRIVATE_KEY}" },
    };
    expect(McpServers.safeParse([entry]).error?.issues[0]?.message).toBe(
      "vendor references GITHUB_PRIVATE_KEY, a secret only the Worker may use",
    );
  });

  it("refuses a command server that passes a secret of the Worker's own in its env", () => {
    const entry = { name: "vendor", command: "npx", env: { TOKEN: "${SLACK_BOT_TOKEN}" } };
    expect(McpServers.safeParse([entry]).success).toBe(false);
  });

  it("reads a server that references a secret of its own", () => {
    const entry = { name: "vendor", url: "https://mcp.example.com/${CF_READ_API_TOKEN}" };
    expect(McpServers.safeParse([entry]).success).toBe(true);
  });
});
