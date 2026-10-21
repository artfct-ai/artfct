import { describe, expect, it } from "bun:test";
import { Adapters } from "./adapters";
import { eventTriggersProblem } from "./event-triggers";
import { loadWorkflowDefinition } from "./workflow-definition";

const ADAPTERS = Adapters.parse({});

function definitionWithTrigger(trigger: string) {
  return loadWorkflowDefinition(
    "reviews",
    [
      "description: Review pull requests.",
      "stages:",
      "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
      "triggers:",
      `  - ${trigger}`,
    ].join("\n"),
  );
}

describe("eventTriggersProblem", () => {
  it("accepts a pull request event without a channel", () => {
    const definition = definitionWithTrigger("{ event: github.pull_request.opened, prompt: Go. }");
    expect(eventTriggersProblem(definition, ADAPTERS)).toBeNull();
  });

  it("accepts another vendor event with a channel", () => {
    const definition = definitionWithTrigger(
      "{ event: linear.Issue.create, channel: C1, prompt: Triage it. }",
    );
    expect(eventTriggersProblem(definition, ADAPTERS)).toBeNull();
  });

  it("accepts a schedule", () => {
    const definition = definitionWithTrigger('{ schedule: "0 9 * * *", channel: C1, prompt: Go. }');
    expect(eventTriggersProblem(definition, ADAPTERS)).toBeNull();
  });

  it("rejects a vendor the deployment does not configure", () => {
    const definition = definitionWithTrigger(
      "{ event: gitlab.merge_request.open, channel: C1, prompt: Go. }",
    );
    expect(eventTriggersProblem(definition, ADAPTERS)).toContain(
      "gitlab, which the deployment does not configure",
    );
  });

  it.each([
    "github.issue_comment.created",
    "github.pull_request_review.submitted",
    "github.pull_request_review_comment.created",
    "slack.app_mention",
    "slack.message",
    "linear.AgentSessionEvent.created",
    "linear.Comment.create",
  ])("rejects the conversational event %s", (event) => {
    const definition = definitionWithTrigger(`{ event: ${event}, channel: C1, prompt: Go. }`);
    expect(eventTriggersProblem(definition, ADAPTERS)).toContain("is a conversational event");
  });

  it("rejects a channel on a pull request event", () => {
    const definition = definitionWithTrigger(
      "{ event: github.pull_request.closed, channel: C1, prompt: Go. }",
    );
    expect(eventTriggersProblem(definition, ADAPTERS)).toContain(
      "reports on its pull request, so it does not take a channel",
    );
  });

  it("rejects another vendor event without a channel", () => {
    const definition = definitionWithTrigger("{ event: github.release.published, prompt: Go. }");
    expect(eventTriggersProblem(definition, ADAPTERS)).toContain("needs a channel to report in");
  });

  it("accepts a member joining a channel without a channel, since the event names one", () => {
    const definition = definitionWithTrigger(
      "{ event: slack.member_joined_channel, filters: { artfct.about_app: [true] }, prompt: Go. }",
    );
    expect(eventTriggersProblem(definition, ADAPTERS)).toBeNull();
  });

  it("names the definition file and the trigger's position", () => {
    const definition = definitionWithTrigger("{ event: slack.message, channel: C1, prompt: Go. }");
    expect(eventTriggersProblem(definition, ADAPTERS)).toStartWith(
      "workflows/reviews.yaml triggers[0]: ",
    );
  });
});
