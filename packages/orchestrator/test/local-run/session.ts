import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type McpServer,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { chooseAllowOption, toolActivity, updateText } from "@artfct-ai/acp/updates";
import type { Effort } from "@artfct-ai/adapters/harness/types";
import type { HarnessChild } from "./container";

const EFFORT_OPTION = "effort";

/** What one turn of the harness produced. */
export type LocalTurn = { stopReason: string; text: string; updates: SessionUpdate[] };

/**
 * Run one prompt through a harness session, as the workflow does: `initialize`, `session/new`
 * with the MCP servers of the workflow, the effort of the stage, then the first prompt.
 * Every permission request is granted.
 */
export async function runLocalSession(options: {
  child: HarnessChild;
  cwd: string;
  mcpServers: McpServer[];
  effort: Effort | null;
  prompt: string;
  onActivity: (line: string) => void;
}): Promise<LocalTurn> {
  const updates: SessionUpdate[] = [];
  let text = "";
  const client: Client = {
    async requestPermission(request) {
      const optionId = chooseAllowOption(request.options);
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    },
    async sessionUpdate(notification) {
      const { update } = notification;
      updates.push(update);
      text += updateText(update) ?? "";
      const activity = toolActivity(update);
      if (activity) options.onActivity(`${activity.kind === "call" ? "→" : "✗"} ${activity.title}`);
    },
  };
  const { stdin, stdout } = options.child;
  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({
      write: (chunk) => void stdin.write(chunk),
      close: () => void stdin.end(),
    }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        stdout.on("end", () => controller.close());
      },
    }),
  );
  const agent = new ClientSideConnection(() => client, stream);

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const session = await agent.newSession({
    cwd: options.cwd,
    mcpServers: options.mcpServers,
  });
  const held = session.configOptions?.find((option) => option.id === EFFORT_OPTION)?.currentValue;
  if (options.effort && held !== undefined && held !== options.effort) {
    await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: EFFORT_OPTION,
      value: options.effort,
    });
  }
  const result = await agent.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: options.prompt }],
  });
  return { stopReason: result.stopReason, text, updates };
}
