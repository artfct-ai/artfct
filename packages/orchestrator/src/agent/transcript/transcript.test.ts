import type { ModelMessage } from "ai";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario } from "../../../test/scenario";

function bulky(role: "user" | "assistant", chars: number): ModelMessage {
  return { role, content: "x".repeat(chars) };
}

describe("TranscriptStore", () => {
  describe("an empty inbox", () => {
    it("drains nothing", () =>
      freshRuntime((workflow) => {
        expect(workflow.transcript.drainInbox()).toBeNull();
      }));
  });

  describe("two queued messages", () => {
    const queued = scenario(freshRuntime, (workflow) => {
      workflow.transcript.enqueue("first", "message");
      workflow.transcript.enqueue("second", "none");
    });

    it("keeps why each one arrived", () =>
      queued((workflow) => {
        expect(workflow.transcript.inbox().map((row) => row.wake)).toEqual(["message", "none"]);
      }));

    it("drains both into the row it returns", () =>
      queued((workflow) => {
        const id = workflow.transcript.drainInbox();
        expect(workflow.transcript.all()).toEqual([
          expect.objectContaining({ id, message: { role: "user", content: "first\n\nsecond" } }),
        ]);
      }));

    describe("once drained", () => {
      const drained = scenario(queued, (workflow) => {
        workflow.transcript.drainInbox();
      });

      it("leaves the inbox empty", () =>
        drained((workflow) => {
          expect(workflow.transcript.inbox()).toEqual([]);
        }));

      it("moves them into one user message in order", () =>
        drained((workflow) => {
          expect(workflow.transcript.all().map((row) => row.message)).toEqual([
            { role: "user", content: "first\n\nsecond" },
          ]);
        }));
    });
  });

  describe("a very large row", () => {
    const appended = scenario(freshRuntime, (workflow) => {
      workflow.transcript.append([bulky("user", 500_000)]);
    });

    it("is stored whole", () =>
      appended((workflow) => {
        expect(workflow.transcript.all()[0]?.message.content).toHaveLength(500_000);
      }));
  });

  describe("four appended rows", () => {
    const four = scenario(freshRuntime, (workflow) => {
      workflow.transcript.append([
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: "four" },
      ]);
    });

    describe("replaced through the third row", () => {
      let ids: number[] = [];
      const replaced = scenario(four, (workflow) => {
        ids = workflow.transcript.all().map((row) => row.id);
        workflow.transcript.replaceThrough(ids[2]!, { role: "user", content: "summary" });
      });

      it("keeps that row's id on the summary and holds the rows after it", () =>
        replaced((workflow) => {
          const rows = workflow.transcript.all();
          expect(rows.map((row) => [row.id, row.message.content])).toEqual([
            [ids[2]!, "summary"],
            [ids[3]!, "four"],
          ]);
        }));

      describe("with one more row appended", () => {
        const appended = scenario(replaced, (workflow) => {
          workflow.transcript.append([{ role: "user", content: "five" }]);
        });

        it("gives it an id after the rows it kept", () =>
          appended((workflow) => {
            const rows = workflow.transcript.all();
            expect(rows.at(-1)!.id).toBeGreaterThan(rows.at(-2)!.id);
          }));
      });
    });
  });
});
