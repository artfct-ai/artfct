import { GithubCodeHost } from "@artfct-ai/adapters/code/github/code-host";
import {
  GITHUB_PULL_INSTRUCTIONS,
  GITHUB_REPOSITORY_NOTES,
  githubMcpServer,
} from "@artfct-ai/adapters/code/github/mcp";
import { GITHUB_CODE_REVIEW } from "@artfct-ai/adapters/code/github/review";
import {
  githubCloneUrl,
  githubPullFromUrl,
  githubPullUrl,
} from "@artfct-ai/adapters/code/github/url";
import type { CodeHost, CodeReview } from "@artfct-ai/adapters/code/types";
import { SlackChat } from "@artfct-ai/adapters/chat/slack/chat";
import type { Chat } from "@artfct-ai/adapters/chat/types";
import { LinearDocuments } from "@artfct-ai/adapters/documents/linear/documents";
import { NotionDocuments } from "@artfct-ai/adapters/documents/notion/documents";
import {
  NOTION_PAGE_INSTRUCTIONS,
  NOTION_PAGE_PARENT_HINT,
  notionCliEnv,
} from "@artfct-ai/adapters/documents/notion/cli";
import { notionPageFromUrl } from "@artfct-ai/adapters/documents/notion/page-id";
import type { Documents } from "@artfct-ai/adapters/documents/types";
import { CloudflareGateway } from "@artfct-ai/adapters/gateway/cloudflare/gateway";
import { OpenRouterGateway } from "@artfct-ai/adapters/gateway/openrouter/gateway";
import type { Gateway } from "@artfct-ai/adapters/gateway/types";
import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import type { Harness, HarnessAdapter } from "@artfct-ai/adapters/harness/types";
import type { TokenSource } from "@artfct-ai/adapters/tracker/linear/sdk";
import { linearIssueKeyFromUrl } from "@artfct-ai/adapters/tracker/linear/url";
import type { HostInstructions, PageInstructions } from "@artfct-ai/adapters/instructions";
import type { McpServer } from "@artfct-ai/adapters/mcp";
import { LinearTracker } from "@artfct-ai/adapters/tracker/linear/tracker";
import {
  LINEAR_ISSUES_INSTRUCTIONS,
  LINEAR_MCP_TOOLS,
  LINEAR_PAGE_INSTRUCTIONS,
  LINEAR_PAGE_PARENT_HINT,
  linearMcpServer,
} from "@artfct-ai/adapters/tracker/linear/mcp";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import { HttpWeb } from "@artfct-ai/adapters/web/http";
import type { Web } from "@artfct-ai/adapters/web/types";
import type { ArtifactKind } from "@artfct-ai/contracts/types";
import { issuesArtifact } from "./artifact/issues";
import { pageArtifact } from "./artifact/page";
import { pullArtifact } from "./artifact/pull";
import type { Artifact } from "./artifact/types";
import type { GatewayAdapter, GatewayProvider } from "./config/gateway";
import type {
  ChatProvider,
  CodeProvider,
  DocumentsProvider,
  McpCapability,
  Adapters,
  TrackerProvider,
} from "./config/adapters";
import { createDb } from "./db/client";
import { readLinearInstall } from "./db/linear-installs";
import type { Env } from "./env";
import { InstallToken, linearApi, type TokenOptions } from "./oauth/token";

/** The code host from a GitHub App installation. Null while any of its credentials is unset. */
export function codeHost(env: Env, provider: CodeProvider): CodeHost | null {
  switch (provider) {
    case "github": {
      if (env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID) {
        return new GithubCodeHost({
          appId: env.GITHUB_APP_ID,
          privateKeyPem: env.GITHUB_PRIVATE_KEY,
          installationId: env.GITHUB_INSTALLATION_ID,
        });
      }
      return null;
    }
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

/** The named model gateway, or null while any secret it needs is unset. */
export function gateway(
  env: Env,
  provider: GatewayProvider,
  region: GatewayAdapter["region"],
): Gateway | null {
  const openRouterKey = env.OPEN_ROUTER_API_KEY || undefined;
  if (provider === "openrouter") {
    return openRouterKey ? new OpenRouterGateway({ apiKey: openRouterKey, region }) : null;
  }
  const { CF_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN } = env;
  if (!CF_ACCOUNT_ID || !AI_GATEWAY_ID || !AI_GATEWAY_TOKEN) return null;
  return new CloudflareGateway({
    accountId: CF_ACCOUNT_ID,
    gatewayId: AI_GATEWAY_ID,
    token: AI_GATEWAY_TOKEN,
    openRouterKey,
    openRouterRegion: region,
  });
}

/** The adapter for a harness, with the deployment's Claude credentials when it has them. */
export function harness(env: Env, name: Harness): HarnessAdapter {
  return harnessAdapter(name, {
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
  });
}

/** Page reads over HTTP for the orchestrator agent. */
export function web(): Web {
  return new HttpWeb();
}

/** A tracker over one fixed token, for reading who a fresh OAuth token acts as. */
export function trackerForToken(env: Env, token: string): Tracker {
  return new LinearTracker(token, linearApi(env));
}

/** What Linear work acts as: the token to send now, and the app user it acts as. */
type LinearCredential = { token: TokenSource; appUserId: string };

/** The credential every Linear client runs on. Null before the app is installed. */
async function linearCredential(
  env: Env,
  options: TokenOptions = {},
): Promise<LinearCredential | null> {
  const db = createDb(env.DB);
  const install = await readLinearInstall(db);
  if (!install) return null;
  const token = new InstallToken(install, env, db, options);
  return { token: () => token.current(), appUserId: install.app_user_id };
}

/** The tracker over the Linear credential. Null when the deployment holds none. */
export async function tracker(env: Env, options: TokenOptions = {}): Promise<Tracker | null> {
  const credential = await linearCredential(env, options);
  if (!credential) return null;
  const api = { ...linearApi(env), appUserId: credential.appUserId };
  return new LinearTracker(credential.token, api);
}

/**
 * The document host the workflow writes and reads pages on. Linear serves documents on the
 * tracker credential. Null without a credential.
 */
export async function documents(
  env: Env,
  provider: DocumentsProvider,
  options: TokenOptions = {},
): Promise<Documents | null> {
  switch (provider) {
    case "notion":
      return env.NOTION_TOKEN
        ? new NotionDocuments(env.NOTION_TOKEN, { baseUrl: env.NOTION_API_URL || undefined })
        : null;
    case "linear": {
      const credential = await linearCredential(env, options);
      return credential ? new LinearDocuments(credential.token, linearApi(env)) : null;
    }
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled documents provider ${String(unreachable)}`);
    }
  }
}

/** The chat the notifier posts through. Null without a credential. */
export function chat(env: Env, provider: ChatProvider): Chat | null {
  switch (provider) {
    case "slack":
      return env.SLACK_BOT_TOKEN ? new SlackChat(env.SLACK_BOT_TOKEN) : null;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled chat provider ${String(unreachable)}`);
    }
  }
}

/** What one artifact kind's module needs from the deployment to do its work. */
export type ArtifactClients = {
  adapters: Adapters;
  /** The code host, for the kinds that live on it. Null without a credential. */
  code: () => CodeHost | null;
  /** The document host, for the kinds that live on it. Null without a credential. */
  documents: () => Promise<Documents | null>;
  /** The repository the workflow works in. Another repository's artifact is not this one. */
  repo: () => string | null;
  log: (line: string) => void;
};

/** The capability an artifact kind's MCP server serves. */
export function artifactCapability(kind: ArtifactKind): McpCapability {
  switch (kind) {
    case "pull":
      return "code";
    case "page":
      return "documents";
    case "issues":
      return "tracker";
    default: {
      const unreachable: never = kind;
      throw new Error(`unhandled artifact kind ${String(unreachable)}`);
    }
  }
}

/** Everything that depends on the kind of artifact a stage produces, for one deployment. */
export function artifact(kind: ArtifactKind, clients: ArtifactClients): Artifact {
  const { adapters, log } = clients;
  const capability = artifactCapability(kind);
  const mcp = (credential: string | null) => mcpServer({ capability, adapters, credential, log });
  switch (kind) {
    case "pull":
      return pullArtifact({
        host: clients.code,
        repo: clients.repo,
        readUrl: (url) => pullFromUrl(adapters.code.provider, url),
        writeUrl: (ref) => pullUrl(adapters.code.provider, ref),
        review: codeReview(adapters.code.provider),
        mcp,
        instructions: pullInstructions(adapters.code.provider),
        notes: repositoryInstructions(adapters.code.provider),
        inspectNote: inspectChecksNote(adapters.code.provider),
        log,
      });
    case "page":
      return pageArtifact({
        readUrl: (url) => pageFromUrl(adapters.documents.provider, url, clients.documents),
        page: async (pageId) => (await clients.documents())?.page(pageId) ?? null,
        removed: async (url) => (await (await clients.documents())?.pageRemoved(url)) ?? false,
        comments: async (pageId, since) =>
          (await clients.documents())?.comments(pageId, since) ?? [],
        fetchComment: async (commentId) =>
          (await clients.documents())?.fetchComment(commentId) ?? null,
        heldComments: async (pageId) => (await clients.documents())?.heldComments(pageId) ?? [],
        self: async () => (await clients.documents())?.self() ?? null,
        comment: async (pageId, text) => (await clients.documents())?.comment(pageId, text),
        acknowledgeComment: async (comment) =>
          (await clients.documents())?.acknowledgeComment(comment),
        instructions: pageInstructions(adapters.documents.provider),
        pageParentHint: pageParentHint(adapters.documents.provider),
        mcp,
        notes: repositoryInstructions(adapters.code.provider),
        log,
      });
    case "issues":
      return issuesArtifact({
        ownsUrl: (url) => trackerOwnsUrl(adapters.tracker.provider, url),
        mcp,
        instructions: issuesInstructions(adapters.tracker.provider),
        notes: repositoryInstructions(adapters.code.provider),
      });
    default: {
      const unreachable: never = kind;
      throw new Error(`unhandled artifact kind ${String(unreachable)}`);
    }
  }
}

/** The URL a sandbox clones the repository from, on the configured code host. */
export function cloneUrl(adapters: Adapters, repoFull: string): string {
  switch (adapters.code.provider) {
    case "github":
      return githubCloneUrl(repoFull);
    default: {
      const unreachable: never = adapters.code.provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

/** True when the artifact kind's MCP server runs on the workflow repo token. */
export function artifactNeedsWorkflowRepoToken(kind: ArtifactKind, adapters: Adapters): boolean {
  return kind === "pull" && adapters.code.provider === "github";
}

function pullFromUrl(
  provider: CodeProvider,
  url: string,
): { repo: string; number: number; url: string } | null {
  switch (provider) {
    case "github": {
      const pull = githubPullFromUrl(url);
      return pull ? { ...pull, url: githubPullUrl(pull) } : null;
    }
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

function pullUrl(provider: CodeProvider, pull: { repo: string; number: number }): string {
  switch (provider) {
    case "github":
      return githubPullUrl(pull);
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

function codeReview(provider: CodeProvider): CodeReview {
  switch (provider) {
    case "github":
      return GITHUB_CODE_REVIEW;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

function inspectChecksNote(provider: CodeProvider): string {
  switch (provider) {
    case "github":
      return "Inspect the checks with `gh pr checks` and `gh run view --log-failed`.";
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

async function pageFromUrl(
  provider: DocumentsProvider,
  url: string,
  documentHost: () => Promise<Documents | null>,
): Promise<{ page_id: string } | null> {
  switch (provider) {
    case "notion":
      return notionPageFromUrl(url);
    case "linear":
      return (await (await documentHost())?.pageFromUrl(url)) ?? null;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled documents provider ${String(unreachable)}`);
    }
  }
}

function trackerOwnsUrl(provider: TrackerProvider, url: string): boolean {
  switch (provider) {
    case "linear":
      return linearIssueKeyFromUrl(url) !== null;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled tracker provider ${String(unreachable)}`);
    }
  }
}

/**
 * The credential the deployment holds for one capability's MCP server or CLI. The code host has
 * none, since every task's server runs on a token minted for that task.
 */
export async function mcpCredential(options: {
  env: Env;
  capability: McpCapability;
  adapters: Adapters;
}): Promise<string | null> {
  const { env, capability, adapters } = options;
  switch (capability) {
    case "code":
      return null;
    case "tracker":
      return trackerCredential(env, adapters.tracker.provider);
    case "documents":
      return documentsCredential(env, adapters.documents.provider);
    default: {
      const unreachable: never = capability;
      throw new Error(`unhandled capability ${String(unreachable)}`);
    }
  }
}

function trackerCredential(env: Env, provider: TrackerProvider): Promise<string | null> {
  switch (provider) {
    case "linear":
      return linearToken(env);
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled tracker provider ${String(unreachable)}`);
    }
  }
}

async function documentsCredential(env: Env, provider: DocumentsProvider): Promise<string | null> {
  switch (provider) {
    case "notion":
      return env.NOTION_TOKEN || null;
    case "linear":
      return linearToken(env);
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled documents provider ${String(unreachable)}`);
    }
  }
}

async function linearToken(env: Env): Promise<string | null> {
  const credential = await linearCredential(env);
  return credential ? credential.token() : null;
}

/**
 * The MCP server one capability serves, from its configured provider, on the credential the
 * caller resolved for it. Null when the provider's host has a CLI in its place. Null without
 * that credential, with one line on `log` saying so.
 */
export function mcpServer(options: {
  capability: McpCapability;
  adapters: Adapters;
  credential: string | null;
  log: (line: string) => void;
}): McpServer | null {
  const { capability, adapters, credential, log } = options;
  switch (capability) {
    case "code":
      return codeMcpServer(adapters.code.provider, credential, log);
    case "tracker":
      return trackerMcpServer(adapters.tracker.provider, credential, log);
    case "documents":
      return documentsMcpServer(adapters.documents.provider, credential, log);
    default: {
      const unreachable: never = capability;
      throw new Error(`unhandled capability ${String(unreachable)}`);
    }
  }
}

function codeMcpServer(
  provider: CodeProvider,
  token: string | null,
  log: (line: string) => void,
): McpServer | null {
  switch (provider) {
    case "github":
      if (token) return githubMcpServer(token);
      log("mcp github skipped: no GitHub App to mint a workflow repo token from");
      return null;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

function trackerMcpServer(
  provider: TrackerProvider,
  token: string | null,
  log: (line: string) => void,
): McpServer | null {
  switch (provider) {
    case "linear":
      return linearMcp(token, log);
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled tracker provider ${String(unreachable)}`);
    }
  }
}

function documentsMcpServer(
  provider: DocumentsProvider,
  token: string | null,
  log: (line: string) => void,
): McpServer | null {
  switch (provider) {
    case "notion":
      return null;
    case "linear":
      return linearMcp(token, log);
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled documents provider ${String(unreachable)}`);
    }
  }
}

/**
 * The environment a CLI in the sandbox image reads one capability's credential from. Empty when
 * the provider's host has no such CLI, with one line on `log` when the credential is missing.
 */
export function cliEnv(options: {
  capability: McpCapability;
  adapters: Adapters;
  credential: string | null;
  log: (line: string) => void;
}): Record<string, string> {
  const { capability, adapters, credential, log } = options;
  switch (capability) {
    case "code":
    case "tracker":
      return {};
    case "documents":
      return documentsCliEnv(adapters.documents.provider, credential, log);
    default: {
      const unreachable: never = capability;
      throw new Error(`unhandled capability ${String(unreachable)}`);
    }
  }
}

function documentsCliEnv(
  provider: DocumentsProvider,
  token: string | null,
  log: (line: string) => void,
): Record<string, string> {
  switch (provider) {
    case "notion":
      if (token) return notionCliEnv(token);
      log("notion cli skipped: NOTION_TOKEN is unset");
      return {};
    case "linear":
      return {};
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled documents provider ${String(unreachable)}`);
    }
  }
}

function linearMcp(token: string | null, log: (line: string) => void): McpServer | null {
  if (token) return linearMcpServer(token);
  log("mcp linear skipped: the Linear app is not installed");
  return null;
}

/** The MCP server the orchestrator agent reads through, and the tools it may call on it. */
export type OrchestratorMcp = { server: McpServer; tools: string[] };

/** The MCP server the orchestrator agent works on. Null without a tracker credential. */
export function orchestratorMcp(options: {
  adapters: Adapters;
  credential: string | null;
  log: (line: string) => void;
}): OrchestratorMcp | null {
  const { adapters } = options;
  const server = mcpServer({ ...options, capability: "tracker" });
  if (!server) return null;
  switch (adapters.tracker.provider) {
    case "linear":
      return { server, tools: LINEAR_MCP_TOOLS };
    default: {
      const unreachable: never = adapters.tracker.provider;
      throw new Error(`unhandled tracker provider ${String(unreachable)}`);
    }
  }
}

function repositoryInstructions(provider: CodeProvider): string {
  switch (provider) {
    case "github":
      return GITHUB_REPOSITORY_NOTES;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

function pullInstructions(provider: CodeProvider): HostInstructions {
  switch (provider) {
    case "github":
      return GITHUB_PULL_INSTRUCTIONS;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled code provider ${String(unreachable)}`);
    }
  }
}

function pageInstructions(provider: DocumentsProvider): PageInstructions {
  switch (provider) {
    case "notion":
      return NOTION_PAGE_INSTRUCTIONS;
    case "linear":
      return LINEAR_PAGE_INSTRUCTIONS;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled documents provider ${String(unreachable)}`);
    }
  }
}

function pageParentHint(provider: DocumentsProvider): string {
  switch (provider) {
    case "notion":
      return NOTION_PAGE_PARENT_HINT;
    case "linear":
      return LINEAR_PAGE_PARENT_HINT;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled documents provider ${String(unreachable)}`);
    }
  }
}

function issuesInstructions(provider: TrackerProvider): HostInstructions {
  switch (provider) {
    case "linear":
      return LINEAR_ISSUES_INSTRUCTIONS;
    default: {
      const unreachable: never = provider;
      throw new Error(`unhandled tracker provider ${String(unreachable)}`);
    }
  }
}
