import { describe, expect, it } from "bun:test";
import { FakeSandboxProvider } from "../../../../test/fake-sandbox";
import type { SandboxRef } from "../../../sandbox/spec";
import {
  RESEARCH_PAYLOAD_MAX_BYTES,
  RESEARCH_PAYLOAD_PATH,
  readResearchPayload,
} from "./research-payload";

const RESEARCHER: SandboxRef = { id: "wf_x.1", size: "small" };

describe("readResearchPayload", () => {
  it("returns the payload the researcher wrote", async () => {
    const sandbox = new FakeSandboxProvider();
    sandbox.putFile("wf_x.1", RESEARCH_PAYLOAD_PATH, '{"files":[]}');
    expect(await readResearchPayload(sandbox, RESEARCHER)).toEqual({ payload: '{"files":[]}' });
  });

  it("reads the payload from the researcher's own sandbox", async () => {
    const sandbox = new FakeSandboxProvider();
    sandbox.putFile("wf_x.1", RESEARCH_PAYLOAD_PATH, "{}");
    await readResearchPayload(sandbox, RESEARCHER);
    expect(sandbox.calls).toEqual([`readFile wf_x.1 ${RESEARCH_PAYLOAD_PATH}`]);
  });

  it("answers the error text of the read for a payload the researcher never wrote", async () => {
    const read = await readResearchPayload(new FakeSandboxProvider(), RESEARCHER);
    expect(read).toEqual({
      readError: `Error: no file at ${RESEARCH_PAYLOAD_PATH} in sandbox wf_x.1`,
    });
  });

  it("takes a payload of exactly the limit", async () => {
    const sandbox = new FakeSandboxProvider();
    sandbox.putFile("wf_x.1", RESEARCH_PAYLOAD_PATH, "a".repeat(RESEARCH_PAYLOAD_MAX_BYTES));
    expect("payload" in (await readResearchPayload(sandbox, RESEARCHER))).toBe(true);
  });

  it("fails a payload over the limit, counting bytes and not characters", async () => {
    const sandbox = new FakeSandboxProvider();
    const payload = "é".repeat(RESEARCH_PAYLOAD_MAX_BYTES / 2 + 1);
    sandbox.putFile("wf_x.1", RESEARCH_PAYLOAD_PATH, payload);
    const read = await readResearchPayload(sandbox, RESEARCHER);
    expect("failure" in read && read.failure).toContain(
      `over the limit of ${RESEARCH_PAYLOAD_MAX_BYTES}`,
    );
  });
});
