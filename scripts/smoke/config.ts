/**
 * Shared constants for the smoke run. Values match what `wrangler dev` is started with
 * so the signed webhooks and the admin token line up with the Workers under test.
 */
import { SCRIPTED_AUTHOR_OPTIONS } from "../../packages/orchestrator/test/scripted-model";
import {
  DOC_STAGES,
  PR_STAGE_NAME,
  REVIEWED_DOC_STAGE,
} from "../../packages/orchestrator/test/smoke-config";

/** Base URL of the ingress Worker. Set INGRESS_URL to target an already running stack. */
export const INGRESS_URL = process.env.INGRESS_URL ?? "http://localhost:8787";

/** True when the caller supplied INGRESS_URL. The harness is then not started. */
export const IS_EXTERNAL_INGRESS = Boolean(process.env.INGRESS_URL);

/** Port of the mock sandbox host that the Workflow DO posts start requests to. */
export const MOCK_SANDBOX_PORT = 9797;

/** URL of the mock sandbox host. */
export const MOCK_SANDBOX_URL = `http://localhost:${MOCK_SANDBOX_PORT}`;

/** Port of the mock Linear API that the orchestrator sends OAuth and GraphQL calls to. */
export const MOCK_LINEAR_PORT = 9898;

/** URL of the mock Linear API. The orchestrator gets it as `LINEAR_API_URL`. */
export const MOCK_LINEAR_URL = `http://localhost:${MOCK_LINEAR_PORT}`;

/** Port of the mock Notion API that the orchestrator and the mock reviewer both talk to. */
export const MOCK_NOTION_PORT = 9999;

/** URL of the mock Notion API. The orchestrator gets it as `NOTION_API_URL`. */
export const MOCK_NOTION_URL = `http://localhost:${MOCK_NOTION_PORT}`;

/** Integration token the orchestrator sends the mock Notion API. It checks no credential. */
export const NOTION_TOKEN = "smoke-notion";

/** OAuth app credentials the orchestrator and the mock Linear API agree on. */
export const LINEAR_CLIENT_ID = "smoke-linear-client";
export const LINEAR_CLIENT_SECRET = "smoke-linear-secret";

/** Port `wrangler dev` serves the ingress Worker on. */
export const INGRESS_PORT = 8787;

/** Bearer token for the ingress admin endpoints. */
export const ADMIN_TOKEN = "smoke-admin";

/** Secret used to sign mock Linear webhooks. */
export const LINEAR_WEBHOOK_SECRET = "linear-smoke";

/** Secret used to sign mock GitHub webhooks. */
export const GITHUB_WEBHOOK_SECRET = "github-smoke";

/** Secret used to sign mock Slack events. */
export const SLACK_SIGNING_SECRET = "slack-smoke";

/** Repository referenced by every mock issue and pull request. */
export const REPO_FULL_NAME = "acme/app";

/** Random suffix that keeps this run's Linear session and issue ids unique. */
export const RUN_ID = Math.random().toString(36).slice(2, 8);

/** The option a person selects on the page of the model stage. */
export const SELECTED_OPTION = SCRIPTED_AUTHOR_OPTIONS[0]!;

/** The Notion page the plan names as the page parent, so a model-call author creates its page under it. */
export const PAGE_PARENT_ID = "0000000000004000800000000000d0c5";

/** Every stage of the smoke workflow, in order. */
export const STAGE_NAMES = [...DOC_STAGES, PR_STAGE_NAME];

/** True for a stage that declares refiners: the reviewed document stage and the PR stage. */
export function stageHasRefiners(stage: string): boolean {
  return stage === REVIEWED_DOC_STAGE || stage === PR_STAGE_NAME;
}

/**
 * Harness turns the tasks of every stage up to and including `stage` take. One per stage, plus the
 * turn the reviewed stage spends answering what its reviewer found. The model stage takes its one
 * turn in the researcher. Reviewer turns are not counted.
 */
export function authorTurnsThrough(stage: string): number {
  const run = STAGE_NAMES.slice(0, STAGE_NAMES.indexOf(stage) + 1);
  return run.length + run.filter((name) => name === REVIEWED_DOC_STAGE).length;
}
