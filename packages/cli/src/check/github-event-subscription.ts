import { loadDeploymentConfig, readDeploymentConfig } from "@artfct-ai/core/config";
import { z } from "zod";
import { githubEventOfVendorEventName } from "../clients";
import { readIngressAppLogin } from "../connect/code/github/ingress-config";
import type { CheckOutcome, RunGh } from "./types";

/** The GitHub events every GitHub App receives without a subscription to them. */
const EVENTS_EVERY_APP_RECEIVES = [
  "installation",
  "installation_repositories",
  "installation_target",
  "github_app_authorization",
];

/** The part of GitHub's answer about an App that the check reads: its event subscription. */
const GithubApp = z.object({ events: z.array(z.string()) });

type WorkflowDefinitions = ReturnType<typeof loadDeploymentConfig>["workflowDefinitions"];

/** A trigger on a GitHub event, where config declares it, and the webhook event it needs. */
type GithubEventTrigger = { place: string; event: string; githubEvent: string };

/** Where the check finds the deployment's triggers and its GitHub App, and how it asks GitHub. */
export type GithubEventSubscriptionEnvironment = {
  configDir: string;
  ingressConfigPath: string;
  runGh: RunGh | null;
};

function githubEventTriggers(definitions: WorkflowDefinitions): GithubEventTrigger[] {
  return definitions.flatMap((definition) =>
    definition.triggers.flatMap((trigger, position) => {
      if (!("event" in trigger)) return [];
      const githubEvent = githubEventOfVendorEventName(trigger.event);
      if (githubEvent === null) return [];
      const place = `workflows/${definition.name}.yaml triggers[${position}]`;
      return [{ place, event: trigger.event, githubEvent }];
    }),
  );
}

function isMissingProgram(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readAppEvents(stdout: string): string[] | null {
  try {
    const answer = GithubApp.safeParse(JSON.parse(stdout));
    return answer.success ? answer.data.events : null;
  } catch {
    return null;
  }
}

/**
 * Fail when a trigger names a GitHub event that the deployment's GitHub App is not subscribed
 * to, so the trigger would never fire. The GitHub CLI reads the App with the person's own login.
 * The check never reads a credential.
 */
export async function checkGithubEventSubscription(
  environment: GithubEventSubscriptionEnvironment,
): Promise<CheckOutcome> {
  const { workflowDefinitions } = loadDeploymentConfig(readDeploymentConfig(environment.configDir));
  const triggers = githubEventTriggers(workflowDefinitions);
  if (triggers.length === 0) {
    return { outcome: "passed", detail: "no trigger names a GitHub event" };
  }
  if (environment.runGh === null) return { outcome: "skipped", detail: "--offline skips it" };
  const appLogin = readIngressAppLogin(environment.ingressConfigPath);
  if (appLogin === null) {
    return {
      outcome: "failed",
      problems: [
        "ingress/wrangler.jsonc does not name the GitHub App in GITHUB_APP_LOGIN. Run `npx artfct connect code`",
      ],
    };
  }
  const command = ["api", `apps/${encodeURIComponent(appLogin)}`];
  let result;
  try {
    result = await environment.runGh(command);
  } catch (error) {
    if (!isMissingProgram(error)) throw error;
    return {
      outcome: "skipped",
      detail:
        "the GitHub CLI is not installed. Install it and run `gh auth login` to check the events the GitHub App receives",
    };
  }
  if (result.exitCode !== 0) {
    return {
      outcome: "failed",
      problems: [
        `gh ${command.join(" ")} exited with ${result.exitCode}. Log the GitHub CLI in with \`gh auth login\` as a person who can see the GitHub App ${appLogin}. ${result.stderr.trim()}`.trim(),
      ],
    };
  }
  const appEvents = readAppEvents(result.stdout);
  if (appEvents === null) {
    return {
      outcome: "failed",
      problems: [`GitHub answered gh ${command.join(" ")} without the App's events`],
    };
  }
  const received = new Set([...appEvents, ...EVENTS_EVERY_APP_RECEIVES]);
  const unreceived = triggers.filter((trigger) => !received.has(trigger.githubEvent));
  if (unreceived.length === 0) {
    return {
      outcome: "passed",
      detail: `the GitHub App ${appLogin} receives every GitHub event the triggers name`,
    };
  }
  return {
    outcome: "failed",
    problems: unreceived.map(
      (trigger) =>
        `${trigger.place}: the GitHub App ${appLogin} does not receive ${trigger.githubEvent} events, so ${trigger.event} never fires. Subscribe the App to ${trigger.githubEvent} under Permissions & events in its settings`,
    ),
  };
}
