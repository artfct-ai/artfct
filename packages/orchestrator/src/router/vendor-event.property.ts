import type { Actor } from "@artfct-ai/contracts/inbound";
import type { JsonValue, VendorEvent } from "@artfct-ai/contracts/types";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import { describe, it } from "bun:test";
import fc from "fast-check";
import {
  aTriggeredPayloadStaysWithinItsCap,
  aTriggerFiresOnlyForAnAuthorizedCauser,
  aTriggerFiresOnlyWhenEveryFilterHolds,
  anUnmatchedEventStaysInMemory,
  type CauserLookup,
  type VendorEventRun,
} from "../../test/trigger-matching-invariants";
import {
  loadWorkflowDefinition,
  type EventTrigger,
  type WorkflowDefinition,
} from "../config/workflow-definition";
import type { TriggerFiring } from "../triggers/types";
import { fireMatchingTriggers } from "./vendor-event";

const RUNS = 300;

const BASE_DEFINITION = loadWorkflowDefinition(
  "reviews",
  [
    "description: Review pull requests.",
    "stages:",
    "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
  ].join("\n"),
);

const EVENT_NAMES = ["github.pull_request.opened", "github.release.published"];
const KEYS = ["a", "b", "c"];
const PATHS = ["a", "b", "a.b", "a.c", "c.a.b", "a.0", "artfct.about_app", "artfct.other"];

const anyScalar = fc.constantFrom<string | number | boolean>("x", "y", 1, 2, true, false);

const anyLeaf: fc.Arbitrary<JsonValue> = fc.oneof(
  anyScalar,
  fc.constant(null),
  fc.array(anyScalar, { maxLength: 3 }),
);

const anyPayloadTree: fc.Arbitrary<JsonValue> = fc.letrec<{ tree: JsonValue }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    anyLeaf,
    fc.dictionary(fc.constantFrom(...KEYS), tie("tree"), { maxKeys: 3 }),
  ),
})).tree;

const anyLongText = fc
  .tuple(fc.constantFrom("a", "é", "😀", "\n", '"'), fc.integer({ min: 1, max: 300_000 }))
  .map(([unit, count]) => unit.repeat(count));

const anyPayload: fc.Arbitrary<JsonValue> = fc.oneof(
  { weight: 4, arbitrary: anyPayloadTree },
  fc.record({ a: anyPayloadTree, body: anyLongText }),
  fc.array(anyLongText, { maxLength: 4 }),
);

const anyEvent: fc.Arbitrary<VendorEvent> = fc.record({
  delivery_id: fc.constant("d-1"),
  name: fc.constantFrom(...EVENT_NAMES),
  payload: anyPayload,
  causer: fc.constant({
    source: "code" as const,
    user: { login: "octocat", repo: "acme/app", app: false },
  }),
  about_app: fc.boolean(),
});

const anyTrigger: fc.Arbitrary<EventTrigger> = fc.record({
  event: fc.constantFrom(...EVENT_NAMES),
  filters: fc.dictionary(
    fc.constantFrom(...PATHS),
    fc.array(anyScalar, { minLength: 1, maxLength: 3 }),
    {
      maxKeys: 3,
    },
  ),
  channel: fc.constant("C1"),
  prompt: fc.constant("Go."),
});

const anyDefinitions: fc.Arbitrary<WorkflowDefinition[]> = fc
  .array(fc.array(anyTrigger, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 2 })
  .map((triggerLists) =>
    triggerLists.map((triggers, index) => ({ ...BASE_DEFINITION, name: `def-${index}`, triggers })),
  );

const anyLookup = fc.constantFrom<CauserLookup>("authorized", "unauthorized", "error");

const OCTOCAT: Actor = { email: "octocat@acme.test", display_name: "octocat" };

async function routedRun(
  definitions: WorkflowDefinition[],
  event: VendorEvent,
  lookup: CauserLookup,
): Promise<VendorEventRun> {
  const run: VendorEventRun = { definitions, event, lookup, lookups: 0, sent: [] };
  const router = {
    definitions,
    resolveActor: async (): Promise<Actor | null> => {
      run.lookups += 1;
      if (lookup === "error") throw new Error("the identity lookup failed");
      return lookup === "authorized" ? OCTOCAT : null;
    },
    sendFirings: async (firings: TriggerFiring[]): Promise<void> => {
      run.sent.push(...firings);
    },
  };
  await fireMatchingTriggers(router, event).catch(() => undefined);
  return run;
}

describe("trigger matching invariants", () => {
  it(
    "hold for any event, any filters and any causer lookup",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          anyDefinitions,
          anyEvent,
          anyLookup,
          async (definitions, event, lookup) => {
            const run = await routedRun(definitions, event, lookup);
            aTriggerFiresOnlyWhenEveryFilterHolds(run);
            anUnmatchedEventStaysInMemory(run);
            aTriggerFiresOnlyForAnAuthorizedCauser(run);
            aTriggeredPayloadStaysWithinItsCap(run);
          },
        ),
        propertyRuns("trigger matching", RUNS),
      );
    },
    propertyTimeoutMs(20_000, RUNS),
  );
});
