import type { Context } from "hono";
import type { HonoEnv } from "../env";

/** Attributes a webhook route puts on its trace span. The vendor lives here and nowhere else. */
export type SpanAttributes = Record<string, boolean | number | string | undefined>;

/** Tag the active trace span. A request with no execution context or no active span is skipped. */
export function tagSpan(ctx: Context<HonoEnv>, attributes: SpanAttributes): void {
  try {
    const executionCtx = ctx.executionCtx as ExecutionContext;
    executionCtx.tracing.getActiveSpan()?.setAttributes(attributes);
  } catch {
    return;
  }
}
