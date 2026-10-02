import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_RTK_PLUGIN, OPENCODE_TODO_PLUGIN } from "./plugins";

type ShellEvent = { tool: string; input: { command: string } };
type TodoTool = {
  name: string;
  execute(input: { todos: { status: string }[] }): Promise<{ content: string }>;
};
type PluginContext = {
  tool: {
    hook(name: string, handler: (event: ShellEvent) => Promise<void>): Promise<void>;
    transform(edit: (tools: { add(tool: TodoTool): void }) => void): Promise<void>;
  };
};
type PluginModule = { default: { id: string; setup(context: PluginContext): Promise<void> } };

async function setUp(fileName: string, source: string) {
  const file = join(mkdtempSync(join(tmpdir(), "opencode-plugin-")), fileName);
  writeFileSync(file, source);
  const loaded = (await import(file)) as PluginModule;
  const hooks: { name: string; handler: (event: ShellEvent) => Promise<void> }[] = [];
  const tools: TodoTool[] = [];
  await loaded.default.setup({
    tool: {
      hook: async (name, handler) => {
        hooks.push({ name, handler });
      },
      transform: async (edit) => edit({ add: (tool) => tools.push(tool) }),
    },
  });
  return { id: loaded.default.id, hooks, tools };
}

describe("OPENCODE_RTK_PLUGIN", () => {
  it("hooks the tool call before it runs", async () => {
    const plugin = await setUp("rtk.mjs", OPENCODE_RTK_PLUGIN);
    expect(plugin.hooks.map((hook) => hook.name)).toEqual(["execute.before"]);
  });

  it("leaves a tool that is not the shell as it is", async () => {
    const plugin = await setUp("rtk.mjs", OPENCODE_RTK_PLUGIN);
    const event = { tool: "read", input: { command: "git status" } };
    await plugin.hooks[0]!.handler(event);
    expect(event.input.command).toBe("git status");
  });
});

describe("OPENCODE_TODO_PLUGIN", () => {
  it("adds the todowrite tool", async () => {
    const plugin = await setUp("todo.mjs", OPENCODE_TODO_PLUGIN);
    expect(plugin.tools.map((tool) => tool.name)).toEqual(["todowrite"]);
  });

  it("answers with the count of open todos", async () => {
    const plugin = await setUp("todo.mjs", OPENCODE_TODO_PLUGIN);
    const todos = [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }];
    expect(await plugin.tools[0]!.execute({ todos })).toEqual({ content: "2 of 3 todos open" });
  });
});
