import type { VendorEvent } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { loadWorkflowDefinition } from "../config/workflow-definition";
import { matchingTriggers } from "./match";

function definitionWithTriggers(name: string, triggers: string[]) {
  return loadWorkflowDefinition(
    name,
    [
      "description: Review pull requests.",
      "stages:",
      "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
      "triggers:",
      ...triggers.map((trigger) => `  - ${trigger}`),
    ].join("\n"),
  );
}

function pullOpened(payload: VendorEvent["payload"], aboutApp = false): VendorEvent {
  return {
    delivery_id: "d-1",
    name: "github.pull_request.opened",
    payload,
    causer: { source: "code", user: { login: "octocat", repo: "acme/app", app: false } },
    about_app: aboutApp,
    enrichment: { kind: "pull_request", repo: "acme/app", number: 12 },
  };
}

const PAYLOAD = {
  action: "opened",
  pull_request: { base: { ref: "main" }, draft: false, labels: [{ name: "deps" }] },
  numbers: [1, 2],
};

function matchedPositions(triggers: string[], event: VendorEvent) {
  return matchingTriggers([definitionWithTriggers("reviews", triggers)], event).map(
    ({ position }) => position,
  );
}

describe("matchingTriggers", () => {
  it("matches a trigger that names the event", () => {
    const triggers = ["{ event: github.pull_request.opened, prompt: Go. }"];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([0]);
  });

  it("skips a trigger that names another event", () => {
    const triggers = ["{ event: github.pull_request.closed, prompt: Go. }"];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([]);
  });

  it("skips a schedule", () => {
    const triggers = ['{ schedule: "0 9 * * *", channel: C1, prompt: Go. }'];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([]);
  });

  it("matches when the value at every filter path is an accepted one", () => {
    const triggers = [
      "{ event: github.pull_request.opened, filters: { pull_request.base.ref: [main, release], pull_request.draft: [false] }, prompt: Go. }",
    ];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([0]);
  });

  it("skips when one filter does not hold", () => {
    const triggers = [
      "{ event: github.pull_request.opened, filters: { pull_request.base.ref: [main], pull_request.draft: [true] }, prompt: Go. }",
    ];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([]);
  });

  it("matches a list that holds an accepted value", () => {
    const triggers = [
      "{ event: github.pull_request.opened, filters: { numbers: [2] }, prompt: Go. }",
    ];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([0]);
  });

  it("skips a path that does not resolve", () => {
    const triggers = [
      "{ event: github.pull_request.opened, filters: { pull_request.head.ref: [main] }, prompt: Go. }",
    ];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([]);
  });

  it("skips a path that resolves to an object", () => {
    const triggers = [
      "{ event: github.pull_request.opened, filters: { pull_request.base: [main] }, prompt: Go. }",
    ];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([]);
  });

  it("reads artfct.about_app from the adapter, not the payload", () => {
    const triggers = [
      "{ event: github.pull_request.opened, filters: { artfct.about_app: [true] }, prompt: Go. }",
    ];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD, false))).toEqual([]);
    expect(matchedPositions(triggers, pullOpened(PAYLOAD, true))).toEqual([0]);
  });

  it("does not read an inherited key", () => {
    const triggers = [
      "{ event: github.pull_request.opened, filters: { pull_request.constructor: [x] }, prompt: Go. }",
    ];
    expect(matchedPositions(triggers, pullOpened(PAYLOAD))).toEqual([]);
  });

  it("returns every matching trigger of every definition, in config order", () => {
    const definitions = [
      definitionWithTriggers("reviews", [
        '{ schedule: "0 9 * * *", channel: C1, prompt: Go. }',
        "{ event: github.pull_request.opened, prompt: Review. }",
      ]),
      definitionWithTriggers("labels", ["{ event: github.pull_request.opened, prompt: Label. }"]),
    ];
    expect(
      matchingTriggers(definitions, pullOpened(PAYLOAD)).map(({ definition, position }) => ({
        definition,
        position,
      })),
    ).toEqual([
      { definition: "reviews", position: 1 },
      { definition: "labels", position: 0 },
    ]);
  });
});
