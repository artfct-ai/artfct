import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { applyEvent } from "../src/workflow/inbound/apply";
import type { Applied } from "../src/workflow/types";
import type { FakeRuntime } from "./fake-runtime";
import type { Scenario } from "./scenario";

const actor = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

/** A Slack prompt from a team member, patched per scenario. */
export function slackPrompt(patch: Partial<InboundEvent>): InboundEvent {
  return {
    id: "evt-1",
    kind: "prompt",
    actor,
    bindings: [],
    links: [],
    text: "",
    ...patch,
  };
}

/** The runtime the event landed on, and what `applyEvent` answered. */
export type AppliedEvent = {
  workflow: FakeRuntime;
  result: Awaited<ReturnType<typeof applyEvent>>;
};

/** Seeds a fresh runtime from `base`, applies one event to it, and hands both to the block's tests. */
export function afterAppliedEvent(
  base: Scenario<FakeRuntime>,
  patch: Partial<InboundEvent>,
  seed: (workflow: FakeRuntime) => void = () => {},
): Scenario<AppliedEvent> {
  return (run) =>
    base(async (workflow) => {
      seed(workflow);
      const result = await applyEvent(workflow, slackPrompt(patch));
      await run({ workflow, result });
    });
}

/** What an event left for the agent. Throws when code handled it without the agent. */
export function appliedForAgent(result: Applied | "handled"): Applied {
  if (result === "handled") throw new Error("the event was handled without the agent");
  return result;
}
