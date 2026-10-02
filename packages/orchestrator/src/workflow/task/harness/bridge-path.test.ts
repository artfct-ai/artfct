import { describe, expect, it } from "bun:test";
import { bridgeDialUrl, parseBridgePath } from "./bridge-path";

describe("parseBridgePath", () => {
  it("reads the workflow and the task out of a dial path", () => {
    expect(parseBridgePath("/bridge/wf_abc/wf_abc.2")).toEqual({
      workflowId: "wf_abc",
      taskId: "wf_abc.2",
    });
  });

  it("refuses a path with no task segment", () => {
    expect(parseBridgePath("/bridge/wf_abc")).toBeNull();
  });

  it("refuses a path with a segment too many", () => {
    expect(parseBridgePath("/bridge/wf_abc/wf_abc.2/extra")).toBeNull();
  });

  it("refuses any other path", () => {
    expect(parseBridgePath("/")).toBeNull();
  });
});

describe("bridgeDialUrl", () => {
  it("turns a secure public origin into a wss dial", () => {
    expect(bridgeDialUrl("https://ao.example.com/", "wf_x", "wf_x.1")).toBe(
      "wss://ao.example.com/bridge/wf_x/wf_x.1",
    );
  });

  it("turns a local origin into a ws dial", () => {
    expect(bridgeDialUrl("http://localhost:8787", "wf_x", "wf_x.1")).toBe(
      "ws://localhost:8787/bridge/wf_x/wf_x.1",
    );
  });
});
