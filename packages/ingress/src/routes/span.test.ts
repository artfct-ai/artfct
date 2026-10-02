import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { tagSpan, type SpanAttributes } from "./span";

function recordingSpan() {
  const recorded: SpanAttributes[] = [];
  return { recorded, setAttributes: (attributes: SpanAttributes) => recorded.push(attributes) };
}

function executionContext(span: ReturnType<typeof recordingSpan> | undefined) {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
    tracing: { getActiveSpan: () => span },
  };
}

function taggingApp(attributes: SpanAttributes) {
  const app = new Hono<HonoEnv>();
  app.get("/", (ctx) => {
    tagSpan(ctx, attributes);
    return ctx.text("ok");
  });
  return app;
}

describe("tagSpan", () => {
  it("sets the attributes on the active span", async () => {
    const span = recordingSpan();
    const app = taggingApp({ "artfct.vendor": "github", "artfct.event.kind": "feedback" });
    await app.request("http://ingress/", {}, {}, executionContext(span));
    expect(span.recorded).toEqual([{ "artfct.vendor": "github", "artfct.event.kind": "feedback" }]);
  });

  it("does nothing when the request is outside a trace", async () => {
    const app = taggingApp({ "artfct.vendor": "slack" });
    const response = await app.request("http://ingress/", {}, {}, executionContext(undefined));
    expect(response.status).toBe(200);
  });

  it("does nothing when there is no execution context", async () => {
    const app = taggingApp({ "artfct.vendor": "linear" });
    const response = await app.request("http://ingress/");
    expect(response.status).toBe(200);
  });
});
