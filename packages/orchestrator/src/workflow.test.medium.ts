import { bridgeTokenHeaders } from "@artfct-ai/acp/bridge-token";
import { jsonRpcNotification } from "@artfct-ai/acp/jsonrpc";
import { BridgeHeartbeat, BridgeMethods, type BridgeHelloParams } from "@artfct-ai/acp/methods";
import type { ConnectionContext } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "./workflow";
import { fakeMcpServerAnswer } from "../test/fake-mcp-server";
import { fakeConnection, type FakeSocket } from "../test/fake-runtime";
import { scenario, type Scenario } from "../test/scenario";

const FIXED_NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
type TaskFixture = { workflow: Workflow; name: string; taskId: string; socket: FakeSocket };

let opened = 0;

async function seedProvisioningTask(workflow: Workflow, name: string): Promise<string> {
  await workflow.status();
  workflow.patchState({ workflow_id: name, status: "running" });
  const taskId = `${name}.1`;
  const jobId = `${name}-1`;
  workflow.store.insertJob({
    job_id: jobId,
    stage: "design",
    issue_id: null,
    issue_key: null,
    input_key: null,
    preceding_job_id: null,
    branch: null,
    brief: "",
  });
  workflow.store.insertTask({
    task_id: taskId,
    job_id: jobId,
    role: "author",
    sandbox: { harness: "opencode", bridge_token: "secret" },
    model: "mock",
  });
  workflow.store.updateTask(taskId, { status: "provisioning" });
  workflow.store.updateSandbox(taskId, { generation: 1 });
  return taskId;
}

const provisioningTask: Scenario<TaskFixture> = async (run) => {
  opened += 1;
  const name = `wf_medium_${opened}`;
  const stub = env.Workflow.getByName(name);
  await runInDurableObject(stub, async (workflow) => {
    const taskId = await seedProvisioningTask(workflow, name);
    await run({ workflow, name, taskId, socket: fakeConnection(taskId, 1) });
  });
};

async function openBridgeSocket(): Promise<WebSocket> {
  opened += 1;
  const name = `wf_medium_${opened}`;
  const stub = env.Workflow.getByName(name);
  const taskId = await runInDurableObject(stub, (workflow) => seedProvisioningTask(workflow, name));
  const response = await stub.fetch(`https://do/bridge/${name}/${taskId}`, {
    headers: { upgrade: "websocket", ...bridgeTokenHeaders("secret") },
  });
  if (!response.webSocket) throw new Error(`the bridge dial answered ${response.status}`);
  response.webSocket.accept();
  return response.webSocket;
}

function nextFrame(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(event.data), { once: true });
  });
}
type McpFixture = { workflow: Workflow; requests: Request[]; tools: string[] };

const connectedMcp: Scenario<McpFixture> = async (run) => {
  opened += 1;
  const requests: Request[] = [];
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    const request = new Request(...args);
    requests.push(request.clone());
    return fakeMcpServerAnswer(request, { tools: ["get_issue", "delete_comment"] });
  });
  try {
    await runInDurableObject(env.Workflow.getByName(`wf_mcp_${opened}`), async (workflow) => {
      await workflow.status();
      workflow.services.mcpCredential = async () => "lin_oauth_a";
      const tools = Object.keys(await workflow.mcpTools());
      await run({ workflow, requests, tools });
    });
  } finally {
    vi.unstubAllGlobals();
  }
};
function dial(name: string, taskId: string, token: string): ConnectionContext {
  const headers = bridgeTokenHeaders(token);
  return { request: new Request(`https://do/bridge/${name}/${taskId}`, { headers }) };
}

describe("Workflow", () => {
  describe("the orchestrator agent's MCP tools", () => {
    it("offers the allowed tools of the tracker server", () =>
      connectedMcp(async ({ tools }) => {
        expect(tools).toEqual(["tool_linear_get_issue"]);
      }));

    it("sends the credential on every request", () =>
      connectedMcp(async ({ requests }) => {
        const credentials = new Set(
          requests.map((request) => request.headers.get("authorization")),
        );
        expect([...credentials]).toEqual(["Bearer lin_oauth_a"]);
      }));

    it("stores no server, so the credential stays out of the Durable Object", () =>
      connectedMcp(async ({ workflow }) => {
        expect(workflow.mcp.listServers()).toEqual([]);
      }));
  });

  describe("alarms", () => {
    describe("a delay that is not a finite number of seconds", () => {
      it("refuses every one of them", () =>
        provisioningTask(async ({ workflow }) => {
          for (const delay of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
            await expect(workflow.scheduleAlarm(delay, "onIdle", {})).rejects.toThrow(
              /^alarm onIdle: delay must be a finite number of seconds/,
            );
          }
        }));
    });

    describe("a delay of sixty seconds", () => {
      it("gives an alarm id back", () =>
        provisioningTask(async ({ workflow }) => {
          const id = await workflow.scheduleAlarm(60, "onIdle", {});
          await workflow.cancelAlarm(id);
          expect(id).toBeTruthy();
        }));
    });
  });

  describe("repeating alarms", () => {
    const ALARM = { job_id: "wf_medium-1" };

    describe("one started twice with the same payload", () => {
      it("repeats once", () =>
        provisioningTask(async ({ workflow }) => {
          await workflow.startRepeatingAlarm(60, "recheckChecks", ALARM);
          await workflow.startRepeatingAlarm(60, "recheckChecks", ALARM);
          const scheduled = workflow.getSchedules({ type: "interval" });
          await workflow.cancelAllAlarms();
          expect(scheduled).toMatchObject([{ callback: "recheckChecks", payload: ALARM }]);
        }));
    });

    describe("one that is stopped", () => {
      it("leaves the alarm of another payload running", () =>
        provisioningTask(async ({ workflow }) => {
          const other = { job_id: "wf_medium-2" };
          await workflow.startRepeatingAlarm(60, "recheckChecks", ALARM);
          await workflow.startRepeatingAlarm(60, "recheckChecks", other);
          await workflow.stopRepeatingAlarm("recheckChecks", ALARM);
          const scheduled = workflow.getSchedules({ type: "interval" });
          await workflow.cancelAllAlarms();
          expect(scheduled).toMatchObject([{ callback: "recheckChecks", payload: other }]);
        }));
    });
  });

  describe("a tracker and a document host installed after the workflow first asked", () => {
    let tracker: FakeTracker;
    let documents: FakeDocuments;
    const installedLate = scenario(provisioningTask, async ({ workflow }) => {
      tracker = new FakeTracker();
      documents = new FakeDocuments();
      const trackers = [null, tracker];
      const hosts = [null, documents];
      workflow.services.tracker = async () => trackers.shift() ?? null;
      workflow.services.documents = async () => hosts.shift() ?? null;
      await workflow.tracker();
      await workflow.documents();
    });

    it("finds the tracker when asked again", () =>
      installedLate(async ({ workflow }) => {
        expect(await workflow.tracker()).toBe(tracker);
      }));

    it("finds the document host when asked again", () =>
      installedLate(async ({ workflow }) => {
        expect(await workflow.documents()).toBe(documents);
      }));

    it("posts through them", () =>
      installedLate(async ({ workflow }) => {
        const event = { type: "info", text: "Hello." } as const;
        await workflow.notifier.post(
          { source: "tracker", session_id: "s1", issue_id: "i1" },
          event,
        );
        await workflow.notifier.post({ source: "documents", page_id: "p1" }, event);
        expect(tracker.argsOf("activity")).toHaveLength(1);
        expect(documents.argsOf("comment")).toEqual([["p1", "Hello."]]);
      }));
  });

  describe("bridge sockets", () => {
    describe("a state frame from a socket", () => {
      it("is refused", () =>
        provisioningTask(({ workflow, socket }) => {
          expect(() => workflow.validateStateChange(workflow.state, socket.connection)).toThrow(
            "a bridge socket cannot write the workflow state",
          );
        }));

      it("leaves the workflow free to write its own state", () =>
        provisioningTask(({ workflow }) => {
          expect(() => workflow.validateStateChange(workflow.state, "server")).not.toThrow();
        }));
    });

    describe("a heartbeat on an open socket", () => {
      it("is answered by the Durable Object", async () => {
        const socket = await openBridgeSocket();
        const answer = nextFrame(socket);
        socket.send(BridgeHeartbeat.request);
        expect(await answer).toBe(BridgeHeartbeat.response);
        socket.close();
      });
    });

    describe("a dial with the wrong token", () => {
      const refused = scenario(provisioningTask, ({ workflow, name, taskId, socket }) =>
        workflow.onConnect(socket.connection, dial(name, taskId, "wrong")),
      );

      it("closes the socket as unauthorized", () =>
        refused(({ socket }) => {
          expect(socket.closes).toEqual([{ code: 4001, reason: "unauthorized" }]);
        }));
    });

    describe("a dial with the right token", () => {
      const connected = scenario(provisioningTask, async ({ workflow, name, taskId, socket }) => {
        workflow.services.now = () => FIXED_NOW;
        await workflow.onConnect(socket.connection, dial(name, taskId, "secret"));
      });

      it("keeps the socket open", () =>
        connected(({ socket }) => {
          expect(socket.closes).toEqual([]);
        }));

      describe("once the bridge says hello", () => {
        const greeted = scenario(connected, async ({ workflow, socket }) => {
          const hello: BridgeHelloParams = { fresh: true, harness: "opencode", generation: 1 };
          await workflow.onMessage(
            socket.connection,
            JSON.stringify(jsonRpcNotification(BridgeMethods.hello, hello)),
          );
        });

        it("opens the ACP handshake", () =>
          greeted(({ workflow, taskId }) => {
            expect(workflow.store.handshakePending(taskId)).toBe(true);
          }));

        it("moves the task to working", () =>
          greeted(({ workflow, taskId }) => {
            expect(workflow.store.requireTask(taskId).status).toBe("working");
          }));

        describe("and then the socket closes", () => {
          const closed = scenario(greeted, ({ workflow, socket }) =>
            workflow.onClose(socket.connection),
          );

          it("stamps the close time on the task", () =>
            closed(({ workflow, taskId }) => {
              expect(workflow.store.requireSandbox(taskId).bridge_closed_at).toBe(
                new Date(FIXED_NOW).toISOString(),
              );
            }));

          it("logs the connect and the disconnect", () =>
            closed(({ workflow }) => {
              expect(workflow.store.logLines().map((row) => row.line)).toEqual(
                expect.arrayContaining(["bridge connected", "bridge disconnected"]),
              );
            }));
        });
      });
    });
  });
});
