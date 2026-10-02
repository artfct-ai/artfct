import { loadConfig } from "../../config/config";
import { beforeEach, describe, expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import {
  allowedMcpTools,
  connectOrchestratorMcp,
  type McpConnectOptions,
  type McpHost,
} from "./mcp";
import type { OrchestratorMcp } from "../../clients";

type Connection = { url: string; options: McpConnectOptions };

type HostOptions = {
  failing?: boolean;
  credential?: string | null;
  connectedCredential?: string | null;
};

type FakeHost = { host: McpHost; connections: Connection[]; lines: string[] };

function fakeHost(options: HostOptions = {}): FakeHost {
  const connections: Connection[] = [];
  const lines: string[] = [];
  const host: McpHost = {
    config: () => loadConfig(""),
    mcpCredential: async () => options.credential ?? null,
    connectedMcpCredential: options.connectedCredential ?? null,
    mcp: {
      connect: async (url: string, connectOptions: McpConnectOptions) => {
        if (options.failing) throw new Error(`connect refused for ${url}`);
        connections.push({ url, options: connectOptions });
        return { id: connectOptions.reconnect.id };
      },
    },
    log: (_taskId: string | null, line: string) => {
      lines.push(line);
    },
  };
  return { host, connections, lines };
}

function mcpToolSet(keys: string[]) {
  const read = tool({ description: "read", inputSchema: z.object({}), execute: async () => "" });
  return Object.fromEntries(keys.map((key) => [key, read]));
}

const KEYS = [
  "tool_linear_get_issue",
  "tool_linear_save_issue",
  "tool_linear_list_issues",
  "tool_linear_save_comment",
  "tool_linear_save_project",
  "tool_linear_save_milestone",
  "tool_linear_save_status_update",
  "tool_linear_save_document",
  "tool_linear_delete_comment",
  "tool_linear_save_initiative",
  "tool_mydocs_get_issue",
  "tool_mydocs_delete_comment",
];

describe("allowedMcpTools", () => {
  describe("the tracker server with its allow-list", () => {
    const connected: OrchestratorMcp = {
      server: {
        name: "linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_api_1" },
      },
      tools: ["get_issue", "save_issue", "list_issues", "save_comment"],
    };

    it("keeps the listed tools and every tool of another server", () => {
      expect(Object.keys(allowedMcpTools(connected, mcpToolSet(KEYS)))).toEqual([
        "tool_linear_get_issue",
        "tool_linear_save_issue",
        "tool_linear_list_issues",
        "tool_linear_save_comment",
        "tool_mydocs_get_issue",
        "tool_mydocs_delete_comment",
      ]);
    });
  });

  describe("no connected server", () => {
    it("keeps every tool", () => {
      expect(Object.keys(allowedMcpTools(null, mcpToolSet(KEYS)))).toEqual(KEYS);
    });
  });
});

describe("connectOrchestratorMcp", () => {
  describe("a deployment with a tracker credential", () => {
    let fake: FakeHost;

    beforeEach(async () => {
      fake = fakeHost({ credential: "lin_oauth_a" });
      await connectOrchestratorMcp(fake.host);
    });

    it("connects the tracker server on the deployment credential", () => {
      expect(fake.connections).toEqual([
        {
          url: "https://mcp.linear.app/mcp",
          options: {
            reconnect: { id: "linear" },
            transport: {
              requestInit: { headers: { Authorization: "Bearer lin_oauth_a" } },
              type: "streamable-http",
            },
          },
        },
      ]);
    });

    it("remembers the credential it connected with", () => {
      expect(fake.host.connectedMcpCredential).toBe("lin_oauth_a");
    });

    it("logs the connection", () => {
      expect(fake.lines).toEqual(["mcp connected: linear"]);
    });
  });

  describe("a deployment with no tracker credential", () => {
    let fake: FakeHost;
    let connected: OrchestratorMcp | null;

    beforeEach(async () => {
      fake = fakeHost();
      connected = await connectOrchestratorMcp(fake.host);
    });

    it("connects nothing", () => {
      expect(fake.connections).toEqual([]);
    });

    it("answers with no server", () => {
      expect(connected).toBeNull();
    });

    it("names what it is missing", () => {
      expect(fake.lines).toEqual(["mcp linear skipped: the Linear app is not installed"]);
    });
  });

  describe("a server connected with the credential it still holds", () => {
    let fake: FakeHost;
    let connected: OrchestratorMcp | null;

    beforeEach(async () => {
      fake = fakeHost({ credential: "lin_oauth_a", connectedCredential: "lin_oauth_a" });
      connected = await connectOrchestratorMcp(fake.host);
    });

    it("leaves the connection alone", () => {
      expect(fake.connections).toEqual([]);
    });

    it("answers with the server", () => {
      expect(connected?.server.name).toBe("linear");
    });
  });

  describe("a server connected with a credential that has since rotated", () => {
    let fake: FakeHost;

    beforeEach(async () => {
      fake = fakeHost({ credential: "lin_oauth_b", connectedCredential: "lin_oauth_a" });
      await connectOrchestratorMcp(fake.host);
    });

    it("replaces the connection under the same id on the fresh credential", () => {
      expect(fake.connections.map((connection) => connection.options)).toEqual([
        {
          reconnect: { id: "linear" },
          transport: {
            requestInit: { headers: { Authorization: "Bearer lin_oauth_b" } },
            type: "streamable-http",
          },
        },
      ]);
    });

    it("remembers the credential it connected with", () => {
      expect(fake.host.connectedMcpCredential).toBe("lin_oauth_b");
    });
  });

  describe("a server that refuses the connection", () => {
    let fake: FakeHost;
    let connected: OrchestratorMcp | null;

    beforeEach(async () => {
      fake = fakeHost({ failing: true, credential: "lin_oauth_a" });
      connected = await connectOrchestratorMcp(fake.host);
    });

    it("answers with the server anyway", () => {
      expect(connected?.server.name).toBe("linear");
    });

    it("remembers no credential, so the next turn connects again", () => {
      expect(fake.host.connectedMcpCredential).toBeNull();
    });

    it("logs the failed connection", () => {
      expect(fake.lines[0]).toMatch(/^mcp linear failed: Error: connect refused for/);
    });
  });
});
