import { describe, expect, it } from "bun:test";
import { PAYLOAD_CAP_BYTES, renderedPayload } from "./payload";

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

describe("renderedPayload", () => {
  it("renders a small payload as compact JSON", () => {
    expect(renderedPayload({ action: "opened", number: 12 })).toBe(
      '{"action":"opened","number":12}',
    );
  });

  it("cuts a large payload at the cap and says so", () => {
    const rendered = renderedPayload({ body: "x".repeat(PAYLOAD_CAP_BYTES * 2) });
    expect(bytesOf(rendered)).toBeLessThanOrEqual(PAYLOAD_CAP_BYTES);
    expect(rendered).toEndWith(" [cut at 16 KB]");
  });

  it("keeps every character whole when it cuts", () => {
    const rendered = renderedPayload({ body: "é😀".repeat(PAYLOAD_CAP_BYTES) });
    expect(bytesOf(rendered)).toBeLessThanOrEqual(PAYLOAD_CAP_BYTES);
    expect(rendered).not.toContain("�");
    expect(new TextDecoder().decode(new TextEncoder().encode(rendered))).toBe(rendered);
  });

  it("keeps a payload of exactly the cap whole", () => {
    const body = "x".repeat(PAYLOAD_CAP_BYTES - bytesOf('{"b":""}'));
    expect(renderedPayload({ b: body })).toBe(`{"b":"${body}"}`);
  });
});
