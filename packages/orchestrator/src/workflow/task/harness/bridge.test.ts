import { bridgeTokenHeaders } from "@artfct-ai/acp/bridge-token";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import {
  acceptBridge,
  authorizeBridge,
  bridgeLossGraceSeconds,
  LOST_SANDBOX_TEXT,
  onBridgeClosed,
  onBridgeLost,
  onBridgeMessage,
  send,
} from "./bridge";
import { jsonRpcRequest } from "@artfct-ai/acp/jsonrpc";
import {
  fakeConnection,
  seedTask,
  type FakeRuntime,
  type FakeSocket,
} from "../../../../test/fake-runtime";
import { freshStore } from "../../../../test/fresh-store";
import { scenario, type Scenario } from "../../../../test/scenario";
import { RECONNECT_CEILING_MS } from "./prompt-queue";

const TASK = "wf_x.1";
const ALARM = { task_id: TASK, generation: 1 };
const CLOCK = 1_000_000_000_000;

function longGone(): string {
  return new Date(Date.now() - RECONNECT_CEILING_MS - 5000).toISOString();
}

describe("bridgeLossGraceSeconds", () => {
  it("outlasts the reconnect window", () => {
    expect(bridgeLossGraceSeconds() * 1000).toBeGreaterThan(RECONNECT_CEILING_MS);
  });
});

describe("send", () => {
  it("writes to the task's open socket", () =>
    freshRuntime(async (workflow) => {
      seedTask(workflow);
      const socket = fakeConnection(TASK, 1);
      workflow.sockets.push(socket.connection);
      send(workflow, workflow.store.requireTask(TASK), jsonRpcRequest(1, "x", {}));
      expect(socket.sent).toHaveLength(1);
    }));

  it("drops the message for a socket that already closed", () =>
    freshRuntime(async (workflow) => {
      seedTask(workflow);
      const socket = fakeConnection(TASK, 1, WebSocket.CLOSED);
      workflow.sockets.push(socket.connection);
      send(workflow, workflow.store.requireTask(TASK), jsonRpcRequest(1, "x", {}));
      expect(socket.sent).toEqual([]);
    }));
});

describe("onBridgeClosed", () => {
  describe("a close with no prompt in flight", () => {
    const closed = scenario(freshRuntime, async (workflow) => {
      workflow.clock = CLOCK;
      seedTask(workflow, {}, { session_id: "s1" });
      await onBridgeClosed(workflow, ALARM);
    });

    it("records when the bridge closed", () =>
      closed((workflow) => {
        expect(workflow.store.requireSandbox(TASK).bridge_closed_at).toBe(
          new Date(CLOCK).toISOString(),
        );
      }));

    it("arms no loss alarm", () =>
      closed((workflow) => {
        expect(workflow.alarms).toEqual([]);
      }));

    describe("and then a close with a prompt in flight", () => {
      const inFlight = scenario(closed, async (workflow) => {
        workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
        await onBridgeClosed(workflow, ALARM);
      });

      it("arms the loss alarm after the grace period", () =>
        inFlight((workflow) => {
          expect(workflow.alarmsFor("onBridgeLost")[0]?.delay).toBe(bridgeLossGraceSeconds());
        }));

      it("names the task and the generation on the alarm", () =>
        inFlight((workflow) => {
          expect(workflow.alarmsFor("onBridgeLost")[0]?.payload).toEqual(ALARM);
        }));
    });
  });
});

describe("a socket of an older generation", () => {
  const restarted = scenario(freshRuntime, (workflow) => {
    workflow.clock = CLOCK;
    seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1, generation: 2 });
  });

  describe("that closes", () => {
    const closed = scenario(restarted, async (workflow) => {
      await onBridgeClosed(workflow, ALARM);
    });

    it("records no bridge close", () =>
      closed((workflow) => {
        expect(workflow.store.requireSandbox(TASK).bridge_closed_at).toBeNull();
      }));

    it("arms no loss alarm", () =>
      closed((workflow) => {
        expect(workflow.alarms).toEqual([]);
      }));
  });

  describe("that sends the answer to the running prompt", () => {
    const answered = scenario(restarted, async (workflow) => {
      const id = workflow.store.insertRpc(TASK, "session/prompt", "prompt");
      const old = fakeConnection(TASK, 1);
      workflow.sockets.push(old.connection);
      const answer = JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      await onBridgeMessage(workflow, old.connection, answer);
    });

    it("leaves the turn in flight", () =>
      answered((workflow) => {
        expect(workflow.store.requireSandbox(TASK).prompt_in_flight).toBe(1);
      }));
  });
});

describe("onBridgeLost", () => {
  describe("a bridge that came back before the alarm fired", () => {
    const reconnected = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
      workflow.sockets.push(fakeConnection(TASK, 1).connection);
      await onBridgeLost(workflow, ALARM);
    });

    it("leaves the sandbox alone", () =>
      reconnected((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("leaves the turn in flight", () =>
      reconnected((workflow) => {
        expect(workflow.store.requireSandbox(TASK).prompt_in_flight).toBe(1);
      }));
  });

  describe("a turn that already ended", () => {
    const ended = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 0 });
      await onBridgeLost(workflow, ALARM);
    });

    it("leaves the sandbox alone", () =>
      ended((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));
  });

  describe("a task that already finished", () => {
    const finished = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { status: "failed" }, { session_id: "s1", prompt_in_flight: 1 });
      await onBridgeLost(workflow, ALARM);
    });

    it("leaves the sandbox alone", () =>
      finished((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));
  });

  describe("an alarm from an older generation", () => {
    const stale = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
      await onBridgeLost(workflow, { ...ALARM, generation: 0 });
    });

    it("leaves the sandbox alone", () =>
      stale((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("leaves the turn in flight", () =>
      stale((workflow) => {
        expect(workflow.store.requireSandbox(TASK).prompt_in_flight).toBe(1);
      }));
  });

  describe("a turn lost with the bridge long gone", () => {
    const restarted = scenario(freshRuntime, async (workflow) => {
      seedTask(
        workflow,
        {},
        {
          session_id: "s1",
          prompt_in_flight: 1,
          turn_text: "half a turn",
          bridge_closed_at: longGone(),
        },
      );
      workflow.store.insertRpc(TASK, "session/prompt", "prompt");
      await onBridgeLost(workflow, ALARM);
    });

    it("restarts the sandbox", () =>
      restarted((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`start ${TASK}`]);
      }));

    it("provisions the task again with the half turn dropped", () =>
      restarted((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "provisioning" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          generation: 2,
          prompt_in_flight: 0,
          turn_text: "",
        });
      }));

    it("closes the open rpc of the lost turn", () =>
      restarted((workflow) => {
        expect(workflow.store.handshakePending(TASK)).toBe(false);
      }));

    it("queues the lost-sandbox text, which the resume prompt reads at session start", () =>
      restarted((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([LOST_SANDBOX_TEXT]);
      }));
  });

  describe("a turn lost with a prompt already queued", () => {
    const restarted = scenario(freshRuntime, async (workflow) => {
      seedTask(
        workflow,
        {},
        { session_id: "s1", prompt_in_flight: 1, bridge_closed_at: longGone() },
      );
      workflow.store.enqueuePrompt(TASK, "Address the review.");
      await onBridgeLost(workflow, ALARM);
    });

    it("restarts the sandbox", () =>
      restarted((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`start ${TASK}`]);
      }));

    it("lets the queued prompt be the wake text instead", () =>
      restarted((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual(["Address the review."]);
      }));
  });
});

function dial(taskId: string, headers: Record<string, string>): Request {
  return new Request(`https://do/bridge/wf/${taskId}`, { headers });
}

describe("authorizeBridge", () => {
  const withTask = scenario(freshStore, (store) => {
    store.insertJob({
      job_id: "j1",
      stage: "implement",
      issue_id: null,
      issue_key: null,
      input_key: null,
      preceding_job_id: null,
      branch: null,
      brief: "",
    });
    store.insertTask({
      task_id: "t1",
      job_id: "j1",
      role: "author",
      sandbox: { harness: "opencode", bridge_token: "secret" },
      model: "mock",
    });
  });

  it("answers the sandbox for its own token", () =>
    withTask((store) => {
      expect(authorizeBridge(store, dial("t1", bridgeTokenHeaders("secret")))).toEqual(
        store.requireSandbox("t1"),
      );
    }));

  it("refuses a wrong token", () =>
    withTask((store) => {
      expect(authorizeBridge(store, dial("t1", bridgeTokenHeaders("wrong")))).toBeNull();
    }));

  it("refuses a dial without a token", () =>
    withTask((store) => {
      expect(authorizeBridge(store, dial("t1", {}))).toBeNull();
    }));

  it("refuses a token in the query string", () =>
    withTask((store) => {
      const request = new Request("https://do/bridge/wf/t1?token=secret");
      expect(authorizeBridge(store, request)).toBeNull();
    }));

  it("refuses a task that has no sandbox", () =>
    withTask((store) => {
      expect(authorizeBridge(store, dial("t2", bridgeTokenHeaders("secret")))).toBeNull();
    }));
});

type Accepted = {
  workflow: FakeRuntime;
  older: FakeSocket;
  other: FakeSocket;
  fresh: FakeSocket;
};

const accepted: Scenario<Accepted> = (run) =>
  freshRuntime(async (workflow) => {
    seedTask(workflow, {}, { generation: 2 });
    const older = fakeConnection(TASK, 1);
    const other = fakeConnection("wf_x.2", 1);
    workflow.sockets.push(older.connection, other.connection);
    const fresh = fakeConnection(TASK, 0);
    acceptBridge(workflow, fresh.connection, workflow.store.requireSandbox(TASK));
    await run({ workflow, older, other, fresh });
  });

describe("acceptBridge", () => {
  it("closes the older socket of the task", () =>
    accepted(({ older }) => {
      expect(older.closes).toEqual([{ code: 4002, reason: "replaced" }]);
    }));

  it("leaves another task's socket open", () =>
    accepted(({ other }) => {
      expect(other.closes).toEqual([]);
    }));

  it("keeps the new socket open", () =>
    accepted(({ fresh }) => {
      expect(fresh.closes).toEqual([]);
    }));

  it("stamps the task and the generation on the new socket", () =>
    accepted(({ fresh }) => {
      expect(fresh.connection.state).toEqual({ task_id: TASK, generation: 2 });
    }));

  it("logs the connection against the task", () =>
    accepted(({ workflow }) => {
      expect(workflow.store.logLines().map((row) => [row.task_id, row.line])).toEqual([
        [TASK, "bridge connected"],
      ]);
    }));
});
