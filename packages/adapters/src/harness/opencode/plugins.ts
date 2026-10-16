/**
 * The plugins every OpenCode task gets, as the source of the files OpenCode loads from the
 * plugins directory of its config.
 */

/**
 * Adds the `todowrite` tool, because OpenCode 2 does not ship a todo tool. The todo list of a
 * task comes from the calls of this tool.
 */
export const OPENCODE_TODO_PLUGIN = `const todo = {
  type: "object",
  properties: {
    content: { type: "string", description: "What the step does" },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
    priority: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["content", "status", "priority"],
};

export default {
  id: "todo",
  async setup(context) {
    await context.tool.transform((tools) => {
      tools.add({
        name: "todowrite",
        options: { codemode: false },
        description:
          "Record the todo list for this task. Call it when you plan the work and each time a step starts or finishes. Send the whole list every time.",
        input: { type: "object", properties: { todos: { type: "array", items: todo } }, required: ["todos"] },
        execute: async ({ todos }) => {
          const open = todos.filter((entry) => entry.status === "pending" || entry.status === "in_progress");
          return { content: open.length + " of " + todos.length + " todos open" };
        },
      });
    });
  },
};
`;
