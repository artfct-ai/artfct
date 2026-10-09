import type { InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  ROUTE_INVARIANTS,
  type ObservedBinding,
  type RouteRecord,
} from "../../test/router-invariants";
import { findBinding } from "../db/bindings";
import { createDb } from "../db/client";
import { findWorkflow, setWorkflowStatus } from "../db/workflows";
import { isWorkflowFinished } from "../workflow/store/state";
import { deliver } from "./deliver";

const NUM_RUNS = 60;
const MAX_ACTIONS = 14;
const TIMEOUT_MS = 120_000;

const db = createDb(env.DB);

const PERSON = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

type SurfaceName = "thread" | "session_a" | "session_b";

type KeyedBinding = Extract<Binding, { external_id: string }>;

type Surface = { bindings: KeyedBinding[]; reply_to: ReplyTarget };

type MessageKind = "start" | "prompt" | "status" | "stop";

type Message = { kind: MessageKind; person: boolean };

type RouteAction =
  | { type: "deliver"; surface: SurfaceName; messages: Message[] }
  | { type: "create_fails_then_retry"; surface: SurfaceName; message: Message }
  | { type: "workflow_ends"; surface: SurfaceName; status: "done" | "failed" | "cancelled" };

class RouteWorld {
  readonly created: string[] = [];
  private failing = false;
  private eventNumber = 0;
  private readonly surfaces: Record<SurfaceName, Surface>;

  constructor(run: number) {
    const issue: KeyedBinding = { source: "tracker_issue", external_id: `ISS-${run}` };
    const session = (name: string): Surface => ({
      bindings: [{ source: "tracker_session", external_id: `${name}-${run}` }, issue],
      reply_to: {
        source: "tracker",
        session_id: `${name}-${run}`,
        issue_id: issue.external_id,
        team_id: "team-1",
      },
    });
    this.surfaces = {
      thread: {
        bindings: [{ source: "chat_thread", external_id: `C${run}:1.0` }],
        reply_to: { source: "chat", channel: `C${run}`, thread: "1.0" },
      },
      session_a: session("sess-a"),
      session_b: session("sess-b"),
    };
  }

  installWorkflows() {
    const getByName = env.Workflow.getByName.bind(env.Workflow);
    return vi.spyOn(env.Workflow, "getByName").mockImplementation(
      (name) =>
        new Proxy(getByName(name), {
          get: (stub, key) => {
            if (key === "create") return async () => this.create(name);
            if (key === "handle") return async () => ({ ok: true });
            return Reflect.get(stub, key);
          },
        }),
    );
  }

  private async create(name: string) {
    if (this.failing) throw new Error("Durable Object reset");
    this.created.push(name);
    return { ok: true, workflow_id: name };
  }

  async apply(action: RouteAction): Promise<RouteRecord | null> {
    const surface = this.surfaces[action.surface];
    switch (action.type) {
      case "workflow_ends":
        await this.endWorkflowOf(surface, action.status);
        return null;
      case "deliver":
        return this.observeAround(surface, action.messages, async () => {
          await Promise.all(action.messages.map((message) => this.send(surface, message)));
        });
      case "create_fails_then_retry": {
        const event = this.eventOf(surface, action.message);
        return this.observeAround(surface, [action.message], async () => {
          this.failing = true;
          await deliver(env, event, null).catch(() => null);
          this.failing = false;
          await deliver(env, event, null);
        });
      }
      default: {
        const unreachable: never = action;
        throw new Error(`unhandled action ${String(unreachable)}`);
      }
    }
  }

  private async observeAround(
    surface: Surface,
    messages: Message[],
    run: () => Promise<void>,
  ): Promise<RouteRecord> {
    const before = await this.observe(surface);
    const createdBefore = this.created.length;
    await run();
    return {
      personWrote: messages.some(
        (message) => message.person && (message.kind === "start" || message.kind === "prompt"),
      ),
      before,
      after: await this.observe(surface),
      created: this.created.slice(createdBefore),
    };
  }

  private async send(surface: Surface, message: Message): Promise<void> {
    await deliver(env, this.eventOf(surface, message), null);
  }

  private eventOf(surface: Surface, message: Message): InboundEvent {
    this.eventNumber += 1;
    return {
      id: `evt-${this.eventNumber}`,
      kind: message.kind,
      actor: message.person ? PERSON : null,
      bindings: surface.bindings,
      links: [],
      text: "also add a test",
      reply_to: surface.reply_to,
    };
  }

  private async endWorkflowOf(
    surface: Surface,
    status: "done" | "failed" | "cancelled",
  ): Promise<void> {
    for (const binding of surface.bindings) {
      const workflowId = await findBinding(db, binding);
      if (workflowId) return setWorkflowStatus(db, workflowId, status);
    }
  }

  private async observe(surface: Surface): Promise<ObservedBinding[]> {
    const observed: ObservedBinding[] = [];
    for (const binding of surface.bindings) {
      const workflowId = await findBinding(db, binding);
      const row = workflowId ? await findWorkflow(db, workflowId) : null;
      observed.push({
        key: `${binding.source}:${binding.external_id}`,
        workflowId,
        ended: row !== null && isWorkflowFinished(row.status),
      });
    }
    return observed;
  }
}

const surfaceNames = fc.constantFrom<SurfaceName>("thread", "session_a", "session_b");

const messages: fc.Arbitrary<Message> = fc.record({
  kind: fc.constantFrom<MessageKind>("start", "prompt", "prompt", "prompt", "status", "stop"),
  person: fc.constantFrom(true, true, true, false),
});

const routeActions: fc.Arbitrary<RouteAction> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(surfaceNames, fc.array(messages, { minLength: 1, maxLength: 3 }))
      .map(([surface, batch]) => ({ type: "deliver" as const, surface, messages: batch })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(surfaceNames, fc.constantFrom<MessageKind>("start", "prompt"))
      .map(([surface, kind]) => ({
        type: "create_fails_then_retry" as const,
        surface,
        message: { kind, person: true },
      })),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        surfaceNames,
        fc.constantFrom("done" as const, "failed" as const, "cancelled" as const),
      )
      .map(([surface, status]) => ({ type: "workflow_ends" as const, surface, status })),
  },
);

let runs = 0;

async function holdsThroughout(sequence: RouteAction[]): Promise<void> {
  runs += 1;
  const world = new RouteWorld(runs);
  const spy = world.installWorkflows();
  try {
    for (const action of sequence) {
      const record = await world.apply(action);
      if (record) for (const invariant of ROUTE_INVARIANTS) invariant(record);
    }
  } finally {
    spy.mockRestore();
  }
}

describe("the router invariants", () => {
  it(
    "hold after every delivery of any sequence on a thread and two sessions of one issue",
    async () => {
      const property = fc.asyncProperty(
        fc.array(routeActions, { maxLength: MAX_ACTIONS }),
        holdsThroughout,
      );
      await fc.assert(property, { numRuns: NUM_RUNS });
      expect(ROUTE_INVARIANTS.length).toBe(1);
    },
    TIMEOUT_MS,
  );
});
