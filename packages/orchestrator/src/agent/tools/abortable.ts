import type { ToolSet } from "ai";

/**
 * The same tools, each rejecting with the abort reason as soon as the turn's signal aborts. For
 * tools whose client takes no signal, such as the Agents SDK's MCP tools, so the turn deadline
 * does not wait on them. The call itself runs on until its client's own timeout.
 */
export function abortableTools(tools: ToolSet): ToolSet {
  const wrapped = Object.entries(tools).map(([name, tool]) => {
    const { execute } = tool;
    if (!execute) return [name, tool] as const;
    const abortable: typeof execute = (input, options) => {
      const call = Promise.resolve(execute(input, options));
      return options.abortSignal ? settledOrAborted(call, options.abortSignal) : call;
    };
    return [name, { ...tool, execute: abortable }] as const;
  });
  return Object.fromEntries(wrapped);
}

function settledOrAborted<Result>(call: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    void call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
