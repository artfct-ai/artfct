import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { RpcAck } from "@artfct-ai/contracts/types";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { conversationIdOf } from "../db/conversations";
import { keepWatch, type Watch } from "../db/watches";
import { writeWorkflowRow } from "../db/workflows";
import { deliver } from "./deliver";

const db = createDb(env.DB);
const PULL = { repo: "acme/watched", number: 21 };

const comment: InboundEvent = {
  id: "evt-watched-comment",
  kind: "feedback",
  actor: { email: "dev@acme.test", display_name: "Dev" },
  bindings: [{ source: "code_pull", ...PULL }],
  links: [],
  text: "Please split this function.",
};

type Handed = { stub: string; conversationId: string; event: InboundEvent };

function recordHandles(failing: Set<string> = new Set()): Handed[] {
  const handed: Handed[] = [];
  vi.spyOn(env.Conversation, "getByName").mockImplementation((stub) => {
    const handle = async (conversationId: string, event: InboundEvent): Promise<RpcAck> => {
      handed.push({ stub, conversationId, event });
      if (failing.has(conversationId)) throw new Error("Durable Object reset");
      return { ok: true };
    };
    return { handle } as unknown as ReturnType<typeof env.Conversation.getByName>;
  });
  return handed;
}

async function keepRunningWatch(watch: Watch): Promise<void> {
  const workflowId = `wf_${watch.definition}_${watch.repo}_${watch.number}`;
  await writeWorkflowRow(db, { workflow_id: workflowId, conversation_id: "cv", status: "running" });
  await keepWatch(db, watch, workflowId);
}

function watcherOf(definition: string): Promise<string> {
  return conversationIdOf({ source: "pull_request", ...PULL, definition });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an event on a pull request that two definitions watch", () => {
  it("reaches each watcher's conversation once", async () => {
    await keepRunningWatch({ ...PULL, definition: "reviews" });
    await keepRunningWatch({ ...PULL, definition: "docs" });
    const handed = recordHandles();
    const delivery = await deliver(env, comment);
    const expected = [await watcherOf("reviews"), await watcherOf("docs")];
    expect(handed.map(({ conversationId }) => conversationId).toSorted()).toEqual(
      expected.toSorted(),
    );
    expect(handed.every(({ stub, conversationId }) => stub === conversationId)).toBe(true);
    expect(delivery).toEqual({ fanned_out: 2, results: [{ ok: true }, { ok: true }] });
  });
});

describe("an event on a watched pull request whose delivery to one watcher fails", () => {
  it("still reaches the other watcher", async () => {
    const pull = { repo: "acme/watched", number: 22 };
    await keepRunningWatch({ ...pull, definition: "reviews" });
    await keepRunningWatch({ ...pull, definition: "docs" });
    const failingWatcher = await conversationIdOf({
      source: "pull_request",
      ...pull,
      definition: "reviews",
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handed = recordHandles(new Set([failingWatcher]));
    const event = { ...comment, bindings: [{ source: "code_pull" as const, ...pull }] };
    const delivery = await deliver(env, event);
    expect(handed).toHaveLength(2);
    expect(delivery).toEqual({ fanned_out: 2, results: [{ ok: true }] });
  });
});

describe("an event on a pull request that nobody watches or owns", () => {
  it("is dropped", async () => {
    const handed = recordHandles();
    const event = {
      ...comment,
      bindings: [{ source: "code_pull" as const, repo: "acme/watched", number: 99 }],
    };
    expect(await deliver(env, event)).toEqual({ dropped: "no conversation for feedback" });
    expect(handed).toEqual([]);
  });
});
