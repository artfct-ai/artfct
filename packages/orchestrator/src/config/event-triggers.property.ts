import { aConversationalEventNeverFires } from "@artfct-ai/adapters/test/inbound-invariants";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import { describe, it } from "bun:test";
import fc from "fast-check";
import { conversationalEvents } from "../clients";
import { Adapters } from "./adapters";
import { eventTriggersProblem } from "./event-triggers";
import { loadWorkflowDefinition, type EventTrigger } from "./workflow-definition";

const RUNS = 500;

const DEPLOYMENTS = [Adapters.parse({}), Adapters.parse({ documents: { provider: "notion" } })];

const BASE_DEFINITION = loadWorkflowDefinition(
  "reviews",
  [
    "description: Review pull requests.",
    "stages:",
    "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
  ].join("\n"),
);

const LISTED_NAMES = [...new Set(DEPLOYMENTS.flatMap(conversationalEvents))];

const anyEventName = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...LISTED_NAMES) },
  fc.constantFrom(
    "github.pull_request.opened",
    "github.pull_request_review.dismissed",
    "github.issue_comment.edited",
    "slack.channel_created",
    "linear.Issue.create",
    "notion.page.created",
  ),
  fc
    .tuple(
      fc.constantFrom("github", "slack", "linear", "notion"),
      fc.stringMatching(/^[A-Za-z_]{1,12}(\.[A-Za-z_]{1,10})?$/),
    )
    .map(([vendor, rest]) => `${vendor}.${rest}`),
);

const anyTrigger: fc.Arbitrary<EventTrigger> = fc
  .tuple(anyEventName, fc.option(fc.constant("C1"), { nil: undefined }))
  .map(([event, channel]) => ({
    event,
    filters: {},
    prompt: "Go.",
    ...(channel === undefined ? {} : { channel }),
  }));

describe("trigger config invariants", () => {
  it(
    "hold for an event trigger on any listed or unlisted name, with or without a channel",
    () => {
      fc.assert(
        fc.property(anyTrigger, fc.constantFrom(...DEPLOYMENTS), (trigger, adapters) => {
          const definition = { ...BASE_DEFINITION, triggers: [trigger] };
          aConversationalEventNeverFires({
            step: "config_load",
            name: trigger.event,
            conversational: conversationalEvents(adapters).includes(trigger.event),
            accepted: eventTriggersProblem(definition, adapters) === null,
          });
        }),
        propertyRuns("trigger config", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
