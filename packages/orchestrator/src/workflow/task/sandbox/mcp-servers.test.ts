import { describe, expect, it } from "bun:test";
import { McpServers } from "../../../config/mcp-servers";
import { harnessMcpServers } from "./mcp-servers";

const PROVIDER = {
  name: "linear",
  type: "http" as const,
  url: "https://mcp.linear.app/mcp",
  headers: { Authorization: "Bearer lin" },
};

const CONFIGURED = McpServers.parse([
  {
    name: "datadog",
    url: "https://mcp.datadoghq.com/mcp",
    headers: { "DD-API-KEY": "${DATADOG_API_KEY}" },
  },
  {
    name: "sentry",
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    env: { SENTRY_ACCESS_TOKEN: "${SENTRY_TOKEN}", SENTRY_HOST: "sentry.example.com" },
  },
]);

const SECRETS: Record<string, string> = { DATADOG_API_KEY: "dd-key", SENTRY_TOKEN: "sentry-key" };

function resolve(secrets: Record<string, string>, lines: string[] = []) {
  return harnessMcpServers({
    provider: PROVIDER,
    configured: CONFIGURED,
    secret: (name) => secrets[name],
    log: (line) => lines.push(line),
  });
}

describe("harnessMcpServers", () => {
  it("puts the provider's server first, with its headers as name and value pairs", () => {
    expect(resolve(SECRETS)[0]).toEqual({
      type: "http",
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: [{ name: "Authorization", value: "Bearer lin" }],
    });
  });

  it("fills a remote server's headers from the secrets", () => {
    expect(resolve(SECRETS)[1]).toEqual({
      type: "http",
      name: "datadog",
      url: "https://mcp.datadoghq.com/mcp",
      headers: [{ name: "DD-API-KEY", value: "dd-key" }],
    });
  });

  it("fills a command server's env and keeps its plain values", () => {
    expect(resolve(SECRETS)[2]).toEqual({
      name: "sentry",
      command: "npx",
      args: ["-y", "@sentry/mcp-server"],
      env: [
        { name: "SENTRY_ACCESS_TOKEN", value: "sentry-key" },
        { name: "SENTRY_HOST", value: "sentry.example.com" },
      ],
    });
  });

  it("skips a server whose secret is unset and names the server and the secret", () => {
    const lines: string[] = [];
    const servers = resolve({ SENTRY_TOKEN: "sentry-key" }, lines);
    expect(servers.map((server) => server.name)).toEqual(["linear", "sentry"]);
    expect(lines).toEqual(["mcp datadog skipped: DATADOG_API_KEY unset"]);
  });

  it("treats an empty secret as unset", () => {
    const servers = resolve({ ...SECRETS, DATADOG_API_KEY: "" });
    expect(servers.map((server) => server.name)).toEqual(["linear", "sentry"]);
  });

  it("keeps the customer's servers when the provider has none", () => {
    const servers = harnessMcpServers({
      provider: null,
      configured: CONFIGURED,
      secret: (name) => SECRETS[name],
      log: () => {},
    });
    expect(servers.map((server) => server.name)).toEqual(["datadog", "sentry"]);
  });
});
