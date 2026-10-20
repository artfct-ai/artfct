import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { SANDBOX_HOME } from "@artfct-ai/adapters/harness/types";
import { CodeProvider, DocumentsProvider, TrackerProvider } from "../src/config/adapters";
import type { SandboxStartSpec } from "../src/sandbox/spec";

const PROVIDER_NAMES: ReadonlySet<string> = new Set([
  ...CodeProvider.options,
  ...TrackerProvider.options,
  ...DocumentsProvider.options,
]);

/** Where the opencode harness reads its model route, key included. */
const OPENCODE_CONFIG = `${SANDBOX_HOME}/.config/opencode/opencode.json`;

/** One place in a sandbox a Worker secret may be written. */
type SandboxSlot = { env: string } | { file: string };

/**
 * What one `.dev.vars` name holds: a plain setting, a secret of the Worker's own with the sandbox
 * slots it may fill, or a secret the customer's MCP servers reference.
 */
export type DevVarHandling =
  | { kind: "setting" }
  | { kind: "worker_secret"; sandbox: readonly SandboxSlot[] }
  | { kind: "customer_secret" };

/**
 * The allowlist: every name in the orchestrator's `.dev.vars.example` and where it may go. A
 * Worker secret also reaches the vendor SDK the Worker builds on it, which no test output records.
 */
export const DEV_VAR_HANDLING: Record<string, DevVarHandling> = {
  PUBLIC_URL: { kind: "setting" },
  CF_ACCOUNT_ID: { kind: "setting" },
  AI_GATEWAY_ID: { kind: "setting" },
  AI_GATEWAY_TOKEN: {
    kind: "worker_secret",
    sandbox: [{ env: "ANTHROPIC_CUSTOM_HEADERS" }, { file: OPENCODE_CONFIG }],
  },
  OPEN_ROUTER_API_KEY: { kind: "worker_secret", sandbox: [{ file: OPENCODE_CONFIG }] },
  CLAUDE_CODE_OAUTH_TOKEN: { kind: "worker_secret", sandbox: [{ env: "CLAUDE_CODE_OAUTH_TOKEN" }] },
  ANTHROPIC_API_KEY: { kind: "worker_secret", sandbox: [{ env: "ANTHROPIC_API_KEY" }] },
  GITHUB_APP_ID: { kind: "setting" },
  GITHUB_INSTALLATION_ID: { kind: "setting" },
  GITHUB_PRIVATE_KEY: { kind: "worker_secret", sandbox: [] },
  LINEAR_CLIENT_ID: { kind: "setting" },
  LINEAR_CLIENT_SECRET: { kind: "worker_secret", sandbox: [] },
  LINEAR_API_URL: { kind: "setting" },
  SLACK_BOT_TOKEN: { kind: "worker_secret", sandbox: [] },
  NOTION_TOKEN: { kind: "worker_secret", sandbox: [{ env: "NOTION_API_TOKEN" }] },
  NOTION_API_URL: { kind: "setting" },
  CF_READ_API_TOKEN: { kind: "customer_secret" },
};

/** A credential the Worker holds or derives, with the value a test gave it. */
export type Credential =
  | { kind: "dev_var"; name: string; value: string }
  | { kind: "workflow_repo_token"; value: string }
  | { kind: "all_repos_read_token"; value: string }
  | { kind: "bridge_token"; value: string }
  | { kind: "tracker_access_token"; value: string }
  | { kind: "tracker_refresh_token"; value: string };

/** Where an output of the Worker went. */
export type Destination =
  | { kind: "sandbox_env"; name: string }
  | { kind: "sandbox_file"; path: string }
  | { kind: "sandbox_token_file"; token: "workflow_repo" | "all_repos_read" }
  | { kind: "sandbox_bridge_token" }
  | { kind: "sandbox_start" }
  | { kind: "token_refresh" }
  | { kind: "mcp_server"; server: string; provider: boolean }
  | { kind: "bridge_frame" }
  | { kind: "store"; table: string; column: string }
  | {
      kind: "output";
      output:
        | "log"
        | "post"
        | "agent_note"
        | "outbox"
        | "pull_comment"
        | "tracker_call"
        | "documents_call"
        | "debug_dump"
        | "status"
        | "console";
    };

/** One text the Worker sent to one destination. */
export type Exposure = { destination: Destination; text: string };

/** The provider MCP server each derived credential may reach. */
const PROVIDER_SERVER_OF = { workflow_repo_token: "github", tracker_access_token: "linear" };

function sandboxSlotMatches(slot: SandboxSlot, destination: Destination): boolean {
  if ("env" in slot) return destination.kind === "sandbox_env" && destination.name === slot.env;
  return destination.kind === "sandbox_file" && destination.path === slot.file;
}

function devVarPermitted(name: string, destination: Destination): boolean {
  const handling = DEV_VAR_HANDLING[name];
  if (!handling) throw new Error(`${name} has no entry in the secret allowlist`);
  switch (handling.kind) {
    case "setting":
      return true;
    case "worker_secret":
      return handling.sandbox.some((slot) => sandboxSlotMatches(slot, destination));
    case "customer_secret":
      return destination.kind === "mcp_server" && !destination.provider;
    default: {
      const unreachable: never = handling;
      throw new Error(`unhandled handling ${String(unreachable)}`);
    }
  }
}

function permitted(credential: Credential, destination: Destination): boolean {
  switch (credential.kind) {
    case "dev_var":
      return devVarPermitted(credential.name, destination);
    case "workflow_repo_token":
      return (
        (destination.kind === "sandbox_token_file" && destination.token === "workflow_repo") ||
        destination.kind === "token_refresh" ||
        (destination.kind === "mcp_server" &&
          destination.provider &&
          destination.server === PROVIDER_SERVER_OF.workflow_repo_token)
      );
    case "all_repos_read_token":
      return (
        (destination.kind === "sandbox_token_file" && destination.token === "all_repos_read") ||
        destination.kind === "token_refresh"
      );
    case "bridge_token":
      return (
        destination.kind === "sandbox_bridge_token" ||
        (destination.kind === "store" &&
          destination.table === "sandboxes" &&
          destination.column === "bridge_token")
      );
    case "tracker_access_token":
      return (
        destination.kind === "mcp_server" &&
        destination.provider &&
        destination.server === PROVIDER_SERVER_OF.tracker_access_token
      );
    case "tracker_refresh_token":
      return false;
    default: {
      const unreachable: never = credential;
      throw new Error(`unhandled credential ${String(unreachable)}`);
    }
  }
}

function credentialName(credential: Credential): string {
  return credential.kind === "dev_var" ? credential.name : credential.kind;
}

/**
 * A credential the Worker holds or derives reaches only the destinations it exists for: the
 * sandbox slot, token refresh, provider MCP server, or store column the allowlist names.
 */
export function secretsReachOnlyTheirDestinations(record: {
  credentials: readonly Credential[];
  exposures: readonly Exposure[];
}): void {
  for (const exposure of record.exposures) {
    for (const credential of record.credentials) {
      if (!credential.value || !exposure.text.includes(credential.value)) continue;
      if (permitted(credential, exposure.destination)) continue;
      throw new Error(
        `secretsReachOnlyTheirDestinations: ${credentialName(credential)} reached ${JSON.stringify(exposure.destination)}`,
      );
    }
  }
}

/** The value a test gives one secret `.dev.vars` name, unlike any other text a test writes. */
export function secretMarker(name: string): string {
  return `secret-marker-${name}-9c1e`;
}

/** Every secret name of the allowlist, set to its marker. */
export function markedSecrets(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DEV_VAR_HANDLING)
      .filter(([, handling]) => handling.kind !== "setting")
      .map(([name]) => [name, secretMarker(name)]),
  );
}

/** The `.dev.vars` credentials an env holds: each secret name of the allowlist with a value. */
export function devVarCredentials(env: object): Credential[] {
  return Object.entries(DEV_VAR_HANDLING).flatMap(([name, handling]) => {
    const value: unknown = Reflect.get(env, name);
    if (handling.kind === "setting" || typeof value !== "string" || !value) return [];
    return [{ kind: "dev_var" as const, name, value }];
  });
}

/** What one sandbox start sent, split by where each part lands. */
export function startSpecExposures(spec: SandboxStartSpec): Exposure[] {
  const {
    env,
    files,
    token,
    workflow_repo_token: workflowRepoToken,
    all_repos_read_token: allReposReadToken,
    ...rest
  } = spec;
  return [
    ...Object.entries(env).map(([name, value]) => ({
      destination: { kind: "sandbox_env" as const, name },
      text: `${name}=${value}`,
    })),
    ...files.map((file) => ({
      destination: { kind: "sandbox_file" as const, path: file.path },
      text: `${file.path}\n${file.content}`,
    })),
    { destination: { kind: "sandbox_bridge_token" }, text: token },
    {
      destination: { kind: "sandbox_token_file", token: "workflow_repo" },
      text: workflowRepoToken ?? "",
    },
    {
      destination: { kind: "sandbox_token_file", token: "all_repos_read" },
      text: JSON.stringify(allReposReadToken),
    },
    { destination: { kind: "sandbox_start" }, text: JSON.stringify(rest) },
  ];
}

/**
 * What one frame to the sandbox carried. Each MCP server of a new session is its own
 * destination. A server named after a provider is that provider's, since a customer's may not be.
 */
export function bridgeFrameExposures(frame: string): Exposure[] {
  const message = JSON.parse(frame) as { method?: string; params?: NewSessionRequest };
  if (message.method !== "session/new" || !message.params) {
    return [{ destination: { kind: "bridge_frame" }, text: frame }];
  }
  const { mcpServers, ...params } = message.params;
  return [
    ...mcpServers.map((server) => ({
      destination: {
        kind: "mcp_server" as const,
        server: server.name,
        provider: PROVIDER_NAMES.has(server.name),
      },
      text: JSON.stringify(server),
    })),
    {
      destination: { kind: "bridge_frame" },
      text: JSON.stringify({ ...message, params }),
    },
  ];
}

/**
 * Every cell of the store, each its own destination. A table that holds none of the credentials
 * is left out, so a check over a large store stays cheap.
 */
export function storeExposures(
  rows: Record<string, unknown[]>,
  credentials: readonly Credential[],
): Exposure[] {
  return Object.entries(rows).flatMap(([table, tableRows]) => {
    const whole = JSON.stringify(tableRows);
    if (!credentials.some((credential) => credential.value && whole.includes(credential.value)))
      return [];
    return tableRows.flatMap((row) =>
      Object.entries(row as Record<string, unknown>).map(([column, value]) => ({
        destination: { kind: "store" as const, table, column },
        text: typeof value === "string" ? value : JSON.stringify(value ?? null),
      })),
    );
  });
}

/** Texts that went to one output. */
export function outputExposures(
  output: Extract<Destination, { kind: "output" }>["output"],
  texts: readonly unknown[],
): Exposure[] {
  return texts.map((text) => ({
    destination: { kind: "output", output },
    text: typeof text === "string" ? text : JSON.stringify(text),
  }));
}
