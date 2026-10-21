import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  theCheckReportsEveryTriggerTheAppDoesNotReceive,
  type DeclaredGithubTrigger,
  type GithubAppAnswer,
} from "../../test/cli-check-invariants";
import { copyTemplate } from "../../test/template";
import { checkGithubEventSubscription } from "./github-event-subscription";
import type { RunGh } from "./types";

const RUNS = 100;

const APP_LOGIN = "artfct-acme";

const GITHUB_EVENTS = [
  "pull_request",
  "check_run",
  "check_suite",
  "push",
  "issues",
  "release",
  "workflow_run",
  "deployment_status",
  "repository",
  "installation",
  "installation_repositories",
  "github_app_authorization",
];

const ACTIONS = ["opened", "created", "completed", "closed", "added", "synchronize"];

type GeneratedTrigger =
  | { kind: "github"; githubEvent: string; action: string | null }
  | { kind: "other vendor"; event: string }
  | { kind: "schedule" };

type GeneratedDefinition = { name: string; triggers: GeneratedTrigger[] };

const generatedTrigger: fc.Arbitrary<GeneratedTrigger> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("github" as const),
      githubEvent: fc.constantFrom(...GITHUB_EVENTS),
      action: fc.option(fc.constantFrom(...ACTIONS), { nil: null }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("other vendor" as const),
      event: fc.constantFrom("slack.member_joined_channel", "linear.Project.create"),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "schedule" as const }) },
);

const generatedDefinitions: fc.Arbitrary<GeneratedDefinition[]> = fc
  .array(fc.array(generatedTrigger, { maxLength: 12 }), { minLength: 1, maxLength: 3 })
  .map((triggerLists) =>
    triggerLists.map((triggers, index) => ({
      name: index === 0 ? "development" : `definition-${index}`,
      triggers,
    })),
  );

const githubAppAnswer: fc.Arbitrary<GithubAppAnswer> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("events" as const),
      events: fc.subarray([...GITHUB_EVENTS, "member", "star"]),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "failed" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "unreadable" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "not installed" as const }) },
);

function eventName(trigger: Extract<GeneratedTrigger, { kind: "github" }>): string {
  const name = `github.${trigger.githubEvent}`;
  return trigger.action === null ? name : `${name}.${trigger.action}`;
}

function triggerYaml(trigger: GeneratedTrigger): string {
  switch (trigger.kind) {
    case "github": {
      const name = eventName(trigger);
      const channel = name.startsWith("github.pull_request.") ? "" : "\n    channel: C0123456";
      return `  - event: ${name}${channel}\n    prompt: Look at it.`;
    }
    case "other vendor":
      return `  - event: ${trigger.event}\n    channel: C0123456\n    prompt: Look at it.`;
    case "schedule":
      return '  - schedule: "0 9 * * 1"\n    channel: C0123456\n    prompt: Look at it.';
    default: {
      const unreachable: never = trigger;
      throw new Error(`unhandled trigger ${JSON.stringify(unreachable)}`);
    }
  }
}

function declaredGithubTriggers(definitions: GeneratedDefinition[]): DeclaredGithubTrigger[] {
  return definitions.flatMap((definition) =>
    definition.triggers.flatMap((trigger, position) =>
      trigger.kind === "github"
        ? [
            {
              place: `workflows/${definition.name}.yaml triggers[${position}]`,
              event: eventName(trigger),
            },
          ]
        : [],
    ),
  );
}

function fakeGh(answer: GithubAppAnswer): RunGh {
  return async () => {
    switch (answer.kind) {
      case "events":
        return {
          exitCode: 0,
          stdout: JSON.stringify({ slug: APP_LOGIN, events: answer.events }),
          stderr: "",
        };
      case "failed":
        return { exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" };
      case "unreadable":
        return { exitCode: 0, stdout: '{"slug":"artfct-acme"}', stderr: "" };
      case "not installed":
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      default: {
        const unreachable: never = answer;
        throw new Error(`unhandled answer ${JSON.stringify(unreachable)}`);
      }
    }
  };
}

const repoDir = copyTemplate();
const workflowsDir = join(repoDir, "orchestrator/workflows");
const definitionText = readFileSync(join(workflowsDir, "development.yaml"), "utf8");
mkdirSync(join(repoDir, "ingress"));
writeFileSync(
  join(repoDir, "ingress/wrangler.jsonc"),
  `{ "vars": { "GITHUB_APP_LOGIN": "${APP_LOGIN}" } }\n`,
);

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function writeDefinitions(definitions: GeneratedDefinition[]): void {
  for (const file of readdirSync(workflowsDir)) unlinkSync(join(workflowsDir, file));
  for (const definition of definitions) {
    const triggers = definition.triggers.length
      ? `\ntriggers:\n${definition.triggers.map(triggerYaml).join("\n")}\n`
      : "";
    writeFileSync(join(workflowsDir, `${definition.name}.yaml`), `${definitionText}${triggers}`);
  }
}

const reached = new Map<string, number>(
  [
    "no GitHub trigger",
    "every event received",
    "an event unreceived",
    "several events unreceived",
    "an event every App receives",
    "gh failed",
    "answer unreadable",
    "gh not installed",
  ].map((name) => [name, 0]),
);

function reach(name: string): void {
  reached.set(name, (reached.get(name) ?? 0) + 1);
}

function reachRun(triggers: DeclaredGithubTrigger[], answer: GithubAppAnswer): void {
  if (triggers.length === 0) return reach("no GitHub trigger");
  if (answer.kind === "failed") return reach("gh failed");
  if (answer.kind === "unreadable") return reach("answer unreadable");
  if (answer.kind === "not installed") return reach("gh not installed");
  const events = new Set(answer.events);
  const webhookEvents = triggers.map((trigger) => trigger.event.split(".")[1] ?? "");
  const always = ["installation", "installation_repositories", "github_app_authorization"];
  if (webhookEvents.some((event) => always.includes(event) && !events.has(event))) {
    reach("an event every App receives");
  }
  const unreceived = webhookEvents.filter((event) => !events.has(event) && !always.includes(event));
  if (unreceived.length === 0) reach("every event received");
  if (unreceived.length === 1) reach("an event unreceived");
  if (unreceived.length > 1) reach("several events unreceived");
}

describe("the GitHub event subscription check", () => {
  it(
    "reports every trigger whose GitHub event the App does not receive",
    async () => {
      await fc.assert(
        fc.asyncProperty(generatedDefinitions, githubAppAnswer, async (definitions, answer) => {
          writeDefinitions(definitions);
          const triggers = declaredGithubTriggers(definitions);
          reachRun(triggers, answer);
          const outcome = await checkGithubEventSubscription({
            configDir: join(repoDir, "orchestrator"),
            ingressConfigPath: join(repoDir, "ingress/wrangler.jsonc"),
            runGh: fakeGh(answer),
          });
          theCheckReportsEveryTriggerTheAppDoesNotReceive({ triggers, answer, outcome });
        }),
        propertyRuns("GitHub event subscription", RUNS),
      );
      expect([...reached].filter(([, count]) => count === 0)).toEqual([]);
    },
    propertyTimeoutMs(30_000, RUNS),
  );
});
