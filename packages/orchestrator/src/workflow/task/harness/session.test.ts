import { jsonRpcNotification, jsonRpcResponse } from "@artfct-ai/acp/jsonrpc";
import { type BridgeHelloParams, BridgeMethods } from "@artfct-ai/acp/methods";
import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import type { McpServer, NewSessionRequest, SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "bun:test";
import { Adapters } from "../../../config/adapters";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { effortLine, onInitialized, onSessionNew } from "./session";
import { onBridgeMessage } from "./bridge";
import {
  type FakeRuntime,
  type FakeSocket,
  fakeConnection,
  REVIEW_TASK,
  seedReviewerRun,
  seedTask,
  type SeedTaskPatch,
  sentMethods,
} from "../../../../test/fake-runtime";
import { type Scenario, scenario } from "../../../../test/scenario";

const TASK = "wf_x.1";
const MCP_TASK = "wf_x.9";

type Session = { workflow: FakeRuntime; socket: FakeSocket };

function appHost(): FakeCodeHost {
  return new FakeCodeHost({ token: { token: "ghs_1", expiresAt: Date.now() + 3_600_000 } });
}

function sessionOf(taskId: string, generation = 1): Scenario<Session> {
  return (run) =>
    freshRuntime((workflow) => {
      const socket = fakeConnection(taskId, generation);
      workflow.sockets.push(socket.connection);
      return run({ workflow, socket });
    });
}

async function hello(workflow: FakeRuntime, socket: FakeSocket, fresh: boolean) {
  const params: BridgeHelloParams = { fresh, harness: "opencode", generation: 1 };
  const frame = JSON.stringify(jsonRpcNotification(BridgeMethods.hello, params));
  await onBridgeMessage(workflow, socket.connection, frame);
}

describe("onBridgeHello", () => {
  describe("a reconnect with a prompt queued", () => {
    const reconnected = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
      seedTask(workflow, {}, { session_id: "s1", bridge_closed_at: new Date().toISOString() });
      workflow.store.enqueuePrompt(TASK, "next");
      await hello(workflow, socket, false);
    });

    it("skips the handshake and drains the queue", () =>
      reconnected(({ socket }) => {
        expect(sentMethods(socket)).toEqual(["session/prompt"]);
      }));

    it("keeps the session the task already had", () =>
      reconnected(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).session_id).toBe("s1");
      }));

    it("marks the bridge open again", () =>
      reconnected(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).bridge_closed_at).toBeNull();
      }));
  });

  describe("a reconnect whose GitHub token is about to die", () => {
    const reconnected = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
      workflow.codeHostInstance = appHost();
      workflow.patchState({ repo: { full: "acme/app" } });
      seedTask(
        workflow,
        {},
        { session_id: "s1", credential_expires_at: new Date(Date.now() + 60_000).toISOString() },
      );
      workflow.store.enqueuePrompt(TASK, "next");
      await hello(workflow, socket, false);
    });

    it("gives the sandbox a new token, then touches the keepalive with the prompt", () =>
      reconnected(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([
          `refreshGithubTokens ${TASK} ghs_1`,
          `keepAlive ${TASK}`,
        ]);
      }));

    it("sends the queued prompt", () =>
      reconnected(({ socket }) => {
        expect(sentMethods(socket)).toEqual(["session/prompt"]);
      }));

    it("schedules the next refresh", () =>
      reconnected(({ workflow }) => {
        expect(workflow.alarmsFor("refreshToken")).toHaveLength(1);
      }));
  });

  describe("a reconnect whose GitHub token has an hour on it", () => {
    let code: FakeCodeHost;
    const reconnected = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
      code = appHost();
      workflow.codeHostInstance = code;
      seedTask(
        workflow,
        {},
        { session_id: "s1", credential_expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      );
      await hello(workflow, socket, false);
    });

    it("touches no sandbox", () =>
      reconnected(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("asks the code host for nothing", () =>
      reconnected(() => {
        expect(code.calls).toEqual([]);
      }));
  });

  describe("a fresh hello on a task with a prompt in flight", () => {
    let oldId: number;
    const restarted = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
      seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
      oldId = workflow.store.insertRpc(TASK, "session/prompt", "prompt");
      await hello(workflow, socket, true);
    });

    it("starts the handshake over", () =>
      restarted(({ socket }) => {
        expect(sentMethods(socket)).toEqual(["initialize"]);
      }));

    it("holds the handshake open", () =>
      restarted(({ workflow }) => {
        expect(workflow.store.handshakePending(TASK)).toBe(true);
      }));

    it("forgets the session and the prompt in flight", () =>
      restarted(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          session_id: null,
          prompt_in_flight: 0,
        });
      }));

    describe("and a late response of the old session arrives", () => {
      const ignored = scenario(restarted, async ({ workflow, socket }) => {
        const late = JSON.stringify(jsonRpcResponse(oldId, { stopReason: "end_turn" }));
        await onBridgeMessage(workflow, socket.connection, late);
      });

      it("leaves the handshake pending", () =>
        ignored(({ workflow }) => {
          expect(workflow.store.handshakePending(TASK)).toBe(true);
        }));

      it("leaves no prompt in flight", () =>
        ignored(({ workflow }) => {
          expect(workflow.store.requireSandbox(TASK).prompt_in_flight).toBe(0);
        }));

      it("posts nothing", () =>
        ignored(({ workflow }) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("queues no note", () =>
        ignored(({ workflow }) => {
          expect(workflow.notes).toEqual([]);
        }));
    });
  });

  describe("a session-level error response that carries no request id", () => {
    const logged = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
      seedTask(workflow, {}, { session_id: "s1" });
      const frame = '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"boom"}}';
      await onBridgeMessage(workflow, socket.connection, frame);
    });

    it("logs the error with its code and message", () =>
      logged(({ workflow }) => {
        expect(workflow.lines).toContain("session error without request id (-32000: boom)");
      }));
  });
});

function sessionServers(socket: FakeSocket): McpServer[] {
  const frame = socket.sent.map(
    (text) => JSON.parse(text) as { method?: string; params?: NewSessionRequest },
  );
  return frame.find((message) => message.method === "session/new")?.params?.mcpServers ?? [];
}

function handshake(
  patch: SeedTaskPatch,
  arrange: (workflow: FakeRuntime) => void,
): Scenario<{ workflow: FakeRuntime; servers: McpServer[] }> {
  return (run) =>
    freshRuntime(async (workflow) => {
      arrange(workflow);
      seedTask(workflow, { task_id: MCP_TASK, ...patch });
      const socket = fakeConnection(MCP_TASK, 1);
      workflow.sockets.push(socket.connection);
      await onInitialized(workflow, workflow.store.requireTask(MCP_TASK), { protocolVersion: 1 });
      await run({ workflow, servers: sessionServers(socket) });
    });
}

const REVIEW_OF_PULL: SeedTaskPatch = { stage: "implement", role: "reviewer" };

describe("onInitialized", () => {
  describe("a review of a pull request", () => {
    describe("with an App that mints a scoped token", () => {
      const opened = handshake(REVIEW_OF_PULL, (workflow) => {
        workflow.patchState({ repo: { full: "acme/app" } });
        workflow.codeHostInstance = new FakeCodeHost({
          token: { token: "ghs_scoped", expiresAt: Date.now() + 3_600_000 },
        });
      });

      it("gives the session the code server with the task's own token", () =>
        opened(({ servers }) => {
          expect(servers).toEqual([
            {
              name: "github",
              type: "http",
              url: "https://api.githubcopilot.com/mcp/",
              headers: [{ name: "Authorization", value: "Bearer ghs_scoped" }],
            },
          ]);
        }));
    });

    describe("when the code host will not mint a token", () => {
      const opened = handshake(REVIEW_OF_PULL, (workflow) => {
        workflow.patchState({ repo: { full: "acme/app" } });
        workflow.codeHostInstance = new FakeCodeHost({ failing: true });
      });

      it("keeps the session without the server", () =>
        opened(({ servers }) => {
          expect(servers).toEqual([]);
        }));

      it("logs the failure", () =>
        opened(({ workflow }) => {
          expect(workflow.lines.some((line) => line.startsWith("credential mint failed"))).toBe(
            true,
          );
        }));
    });

    describe("with no code credentials at all", () => {
      const opened = handshake(REVIEW_OF_PULL, () => {});

      it("opens the session with no server", () =>
        opened(({ servers }) => {
          expect(servers).toEqual([]);
        }));

      it("names what it is missing", () =>
        opened(({ workflow }) => {
          expect(workflow.lines).toContain(
            "mcp github skipped: no GitHub App to mint a workflow repo token from",
          );
        }));
    });
  });

  describe("a stage that produces a page", () => {
    describe("with the documents credential set", () => {
      let code: FakeCodeHost;
      const opened = handshake({ stage: "design" }, (workflow) => {
        workflow.mcpCredentialValue = "lin_oauth_a";
        code = new FakeCodeHost({ failing: true });
        workflow.codeHostInstance = code;
      });

      it("opens the session with the documents server on the deployment credential", () =>
        opened(({ servers }) => {
          expect(servers).toEqual([
            {
              name: "linear",
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: [{ name: "Authorization", value: "Bearer lin_oauth_a" }],
            },
          ]);
        }));

      it("mints no token", () =>
        opened(() => {
          expect(code.calls).toEqual([]);
        }));

      it("logs no token failure", () =>
        opened(({ workflow }) => {
          expect(workflow.lines.some((line) => line.startsWith("github token failed"))).toBe(false);
        }));
    });

    describe("with no documents credential", () => {
      const opened = handshake({ stage: "design" }, () => {});

      it("opens the session with no server", () =>
        opened(({ servers }) => {
          expect(servers).toEqual([]);
        }));

      it("names what it is missing", () =>
        opened(({ workflow }) => {
          expect(workflow.lines).toContain("mcp linear skipped: the Linear app is not installed");
        }));
    });

    describe("when Notion holds the pages", () => {
      const opened = handshake({ stage: "design" }, (workflow) => {
        workflow.patchConfig({ adapters: Adapters.parse({ documents: { provider: "notion" } }) });
        workflow.mcpCredentialValue = "ntn_secret";
      });

      it("opens the session with no server, because the Notion CLI reaches the page", () =>
        opened(({ servers }) => {
          expect(servers).toEqual([]);
        }));
    });
  });
});

describe("onSessionNew", () => {
  describe("the session of a review task", () => {
    let socket: FakeSocket;
    const opened = scenario(freshRuntime, async (workflow) => {
      const review = seedReviewerRun(workflow);
      socket = fakeConnection(REVIEW_TASK, workflow.store.requireSandbox(REVIEW_TASK).generation);
      workflow.sockets.push(socket.connection);
      await onSessionNew(workflow, review, { sessionId: "s1" });
    });

    it("sends the review task its first prompt", () =>
      opened(() => {
        expect(sentMethods(socket)).toEqual(["session/prompt"]);
      }));

    it("records the session and the prompt in flight", () =>
      opened((workflow) => {
        expect(workflow.store.requireSandbox(REVIEW_TASK)).toMatchObject({
          session_id: "s1",
          prompt_in_flight: 1,
        });
      }));

    it("logs that the session reports no effort option", () =>
      opened((workflow) => {
        expect(workflow.lines).toContain("session reports no effort option");
      }));
  });

  describe("a session reply that names the harness's own effort", () => {
    const opened = scenario(freshRuntime, async (workflow) => {
      const task = seedTask(workflow);
      const socket = fakeConnection(TASK, workflow.store.requireSandbox(TASK).generation);
      workflow.sockets.push(socket.connection);
      await onSessionNew(workflow, task, {
        sessionId: "s1",
        configOptions: [effortOption("xhigh")],
      });
    });

    it("logs the effort as the harness default", () =>
      opened((workflow) => {
        expect(workflow.lines).toContain("session effort=xhigh, harness default");
      }));
  });

  describe("a session that holds another effort than the stage asked for", () => {
    let socket: FakeSocket;
    const opened = scenario(freshRuntime, async (workflow) => {
      askForHighEffort(workflow);
      const task = seedTask(workflow);
      socket = fakeConnection(TASK, workflow.store.requireSandbox(TASK).generation);
      workflow.sockets.push(socket.connection);
      await onSessionNew(workflow, task, {
        sessionId: "s1",
        configOptions: [effortOption("low")],
      });
    });

    it("tells the session the asked effort and holds the first prompt back", () =>
      opened(() => {
        expect(socket.sent.map((frame) => JSON.parse(frame))).toMatchObject([
          {
            method: "session/set_config_option",
            params: { sessionId: "s1", configId: "effort", value: "high" },
          },
        ]);
      }));

    it("keeps a queued prompt waiting as part of the handshake", () =>
      opened((workflow) => {
        expect(workflow.store.handshakePending(TASK)).toBe(true);
      }));
  });

  describe("a session that already holds the asked effort", () => {
    let socket: FakeSocket;
    const opened = scenario(freshRuntime, async (workflow) => {
      askForHighEffort(workflow);
      const task = seedTask(workflow);
      socket = fakeConnection(TASK, workflow.store.requireSandbox(TASK).generation);
      workflow.sockets.push(socket.connection);
      await onSessionNew(workflow, task, {
        sessionId: "s1",
        configOptions: [effortOption("high")],
      });
    });

    it("sends the first prompt at once", () =>
      opened(() => {
        expect(sentMethods(socket)).toEqual(["session/prompt"]);
      }));
  });
});

async function toldEffort(workflow: FakeRuntime): Promise<FakeSocket> {
  askForHighEffort(workflow);
  const task = seedTask(workflow);
  const socket = fakeConnection(TASK, workflow.store.requireSandbox(TASK).generation);
  workflow.sockets.push(socket.connection);
  await onSessionNew(workflow, task, { sessionId: "s1", configOptions: [effortOption("low")] });
  return socket;
}

describe("the answer to the effort a session was told", () => {
  describe("a session that took the effort", () => {
    let socket: FakeSocket;
    const answered = scenario(freshRuntime, async (workflow) => {
      socket = await toldEffort(workflow);
      const result = { configOptions: [effortOption("high")] };
      const frame = JSON.stringify({ jsonrpc: "2.0", id: requestId(socket), result });
      await onBridgeMessage(workflow, socket.connection, frame);
    });

    it("logs the effort as confirmed", () =>
      answered((workflow) => {
        expect(workflow.lines).toContain("session effort=high confirmed");
      }));

    it("sends the first prompt", () =>
      answered(() => {
        expect(sentMethods(socket)).toEqual(["session/set_config_option", "session/prompt"]);
      }));
  });

  describe("a session that refused the effort", () => {
    let socket: FakeSocket;
    const refused = scenario(freshRuntime, async (workflow) => {
      socket = await toldEffort(workflow);
      const error = { code: -32602, message: "effort not found: high" };
      const frame = JSON.stringify({ jsonrpc: "2.0", id: requestId(socket), error });
      await onBridgeMessage(workflow, socket.connection, frame);
    });

    it("logs the refusal", () =>
      refused((workflow) => {
        expect(workflow.lines).toContain(
          "session/set_config_option error -32602: effort not found: high",
        );
      }));

    it("still sends the first prompt, at the effort the session holds", () =>
      refused(() => {
        expect(sentMethods(socket)).toEqual(["session/set_config_option", "session/prompt"]);
      }));
  });
});

function requestId(socket: FakeSocket): number {
  return (JSON.parse(socket.sent[0]!) as { id: number }).id;
}

function askForHighEffort(workflow: FakeRuntime): void {
  const { orchestrator } = workflow.config();
  workflow.patchConfig({
    orchestrator: { ...orchestrator, task: { ...orchestrator.task, effort: "high" } },
  });
}

describe("effortLine", () => {
  it("reports the harness default when no effort was configured", () => {
    expect(effortLine(null, [effortOption("high")])).toBe("session effort=high, harness default");
  });

  it("reports no effort option and no ask when none was configured", () => {
    expect(effortLine(null, null)).toBe("session reports no effort option");
  });

  it("reports the effort the session confirms", () => {
    expect(effortLine("xhigh", [effortOption("xhigh")])).toBe("session effort=xhigh confirmed");
  });

  it("reports the effort the session held instead of the one asked for", () => {
    expect(effortLine("max", [effortOption("high")])).toBe("session effort=high, asked for max");
  });

  it("reports no effort option when the session has none", () => {
    expect(effortLine("xhigh", null)).toBe("session reports no effort option, asked for xhigh");
  });

  it("reports no effort option when no option is the effort one", () => {
    expect(
      effortLine("xhigh", [{ id: "mode", type: "boolean", name: "Mode", currentValue: true }]),
    ).toBe("session reports no effort option, asked for xhigh");
  });
});

function effortOption(value: string): SessionConfigOption {
  return {
    id: "effort",
    type: "select",
    name: "Effort",
    currentValue: value,
    options: [{ value, name: value }],
  };
}
