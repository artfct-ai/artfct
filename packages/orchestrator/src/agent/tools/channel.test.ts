import { describe, expect, it } from "bun:test";
import { acceptingD1 } from "../../../test/accepting-d1";
import { freshRuntime } from "../../../test/fresh-runtime";
import { FakeRuntime, seedTask } from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import { scenario, type Scenario } from "../../../test/scenario";
import { testEnv } from "../../../test/test-env";
import { toolText } from "../../../test/tool-result";
import { channelTools } from "./channel";

const call = { toolCallId: "call-1", messages: [], context: {} };

const routedRuntime: Scenario<FakeRuntime> = async (run) => {
  await run(new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: acceptingD1() }));
};

describe("channel tools", () => {
  describe("acknowledge", () => {
    let result: string;
    const acknowledged = scenario(freshRuntime, async (workflow) => {
      result = toolText(
        await channelTools(workflow).acknowledge.execute({ text: "Working on it." }, call),
      );
    });

    it("answers that the line went out", () =>
      acknowledged(() => {
        expect(result).toBe("Acknowledged.");
      }));

    it("sends an info event to the channels", () =>
      acknowledged((workflow) => {
        expect(workflow.posted).toEqual([{ type: "info", text: "Working on it." }]);
      }));

    it("keeps the workflow running", () =>
      acknowledged((workflow) => {
        expect(workflow.state.status).toBe("running");
      }));

    describe("called twice in one turn", () => {
      let refusal = "";
      const twice = scenario(freshRuntime, async (workflow) => {
        const tools = channelTools(workflow);
        await tools.acknowledge.execute({ text: "Got it." }, call);
        try {
          await tools.acknowledge.execute({ text: "Still working." }, call);
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
      });

      it("refuses the second line", () =>
        twice(() => {
          expect(refusal).toMatch(/^Already acknowledged/);
        }));

      it("posts only the first", () =>
        twice((workflow) => {
          expect(workflow.posted).toEqual([{ type: "info", text: "Got it." }]);
        }));
    });
  });

  describe("tell", () => {
    let result: string;
    const told = scenario(freshRuntime, async (workflow) => {
      result = toolText(
        await channelTools(workflow).tell.execute({ text: "The harness cannot push." }, call),
      );
    });

    it("answers that the line went out", () =>
      told(() => {
        expect(result).toBe("Told.");
      }));

    it("sends an info event to the channels", () =>
      told((workflow) => {
        expect(workflow.posted).toEqual([{ type: "info", text: "The harness cannot push." }]);
      }));
  });

  describe("ask", () => {
    describe("while no task runs", () => {
      let result: string;
      const asked = scenario(routedRuntime, async (workflow) => {
        result = toolText(await channelTools(workflow).ask.execute({ text: "Which repo?" }, call));
      });

      it("answers that the question went out", () =>
        asked(() => {
          expect(result).toMatch(/^Asked/);
        }));

      it("marks the workflow as waiting for input", () =>
        asked((workflow) => {
          expect(workflow.state.status).toBe("waiting_input");
        }));

      it("sends a question event to the channels", () =>
        asked((workflow) => {
          expect(workflow.posted).toEqual([{ type: "question", text: "Which repo?" }]);
        }));
    });

    describe("while a task is active", () => {
      const asked = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow);
        await channelTools(workflow).ask.execute({ text: "Merge now?" }, call);
      });

      it("keeps the workflow running", () =>
        asked((workflow) => {
          expect(workflow.state.status).toBe("running");
        }));

      it("sends a question event to the channels", () =>
        asked((workflow) => {
          expect(workflow.posted).toEqual([{ type: "question", text: "Merge now?" }]);
        }));
    });
  });
});
