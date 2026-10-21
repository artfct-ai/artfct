import type { CheckOutcome } from "../src/check/types";

/** A trigger on a GitHub event that a generated config declares, by its place in config. */
export type DeclaredGithubTrigger = { place: string; event: string };

/** How GitHub answered the check's read of the App. */
export type GithubAppAnswer =
  | { kind: "events"; events: string[] }
  | { kind: "failed" }
  | { kind: "unreadable" }
  | { kind: "not installed" };

/** One run of the subscription check: the triggers config declared, GitHub's answer, and the outcome. */
export type SubscriptionCheckRun = {
  triggers: DeclaredGithubTrigger[];
  answer: GithubAppAnswer;
  outcome: CheckOutcome;
};

const EVENTS_EVERY_APP_RECEIVES = new Set([
  "installation",
  "installation_repositories",
  "installation_target",
  "github_app_authorization",
]);

function violated(detail: string): never {
  throw new Error(`theCheckReportsEveryTriggerTheAppDoesNotReceive: ${detail}`);
}

function webhookEventOf(event: string): string {
  return event.split(".")[1] ?? "";
}

function expectedUnreceived(triggers: DeclaredGithubTrigger[], events: string[]): string[] {
  const received = new Set(events);
  return triggers
    .filter((trigger) => {
      const webhookEvent = webhookEventOf(trigger.event);
      return !received.has(webhookEvent) && !EVENTS_EVERY_APP_RECEIVES.has(webhookEvent);
    })
    .map((trigger) => trigger.place);
}

/**
 * `artfct check` fails and names every trigger whose GitHub event the App does not receive, and
 * only those. It passes only when GitHub answered with the App's events and every trigger's event
 * is among them, or when no trigger names a GitHub event.
 */
export function theCheckReportsEveryTriggerTheAppDoesNotReceive(run: SubscriptionCheckRun): void {
  const { triggers, answer, outcome } = run;
  if (triggers.length === 0) {
    if (outcome.outcome !== "passed") violated(`no GitHub trigger, yet ${outcome.outcome}`);
    return;
  }
  if (answer.kind === "not installed") {
    if (outcome.outcome === "passed") violated("passed without the GitHub CLI");
    return;
  }
  if (answer.kind !== "events") {
    if (outcome.outcome !== "failed")
      violated(`GitHub's answer was ${answer.kind}, yet ${outcome.outcome}`);
    return;
  }
  const unreceived = expectedUnreceived(triggers, answer.events);
  if (unreceived.length === 0) {
    if (outcome.outcome !== "passed") violated(`every event is received, yet ${outcome.outcome}`);
    return;
  }
  if (outcome.outcome !== "failed") {
    violated(`${unreceived.join(", ")} miss their events, yet ${outcome.outcome}`);
  }
  for (const trigger of triggers) {
    const named = outcome.problems.filter((problem) => problem.startsWith(`${trigger.place}:`));
    const shouldBeNamed = unreceived.includes(trigger.place);
    if (named.length !== (shouldBeNamed ? 1 : 0)) {
      violated(`${trigger.place} (${trigger.event}) is named ${named.length} times`);
    }
  }
}
