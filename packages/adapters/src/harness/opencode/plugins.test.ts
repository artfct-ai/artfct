import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_TODO_PLUGIN } from "./plugins";

type TodoTool = {
  name: string;
  execute(input: { todos: { status: string }[] }): Promise<{ content: string }>;
};
type PluginContext = {
  tool: {
    transform(edit: (tools: { add(tool: TodoTool): void }) => void): Promise<void>;
  };
};
type PluginModule = { default: { id: string; setup(context: PluginContext): Promise<void> } };

async function setUp(fileName: string, source: string) {
  const file = join(mkdtempSync(join(tmpdir(), "opencode-plugin-")), fileName);
  writeFileSync(file, source);
  const loaded = (await import(file)) as PluginModule;
  const tools: TodoTool[] = [];
  await loaded.default.setup({
    tool: {
      transform: async (edit) => edit({ add: (tool) => tools.push(tool) }),
    },
  });
  return { id: loaded.default.id, tools };
}

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
