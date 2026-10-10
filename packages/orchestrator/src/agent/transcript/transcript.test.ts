import type { ModelMessage } from "ai";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario } from "../../../test/scenario";

function bulky(role: "user" | "assistant", chars: number): ModelMessage {
  return { role, content: "x".repeat(chars) };
}

describe("TranscriptStore", () => {
  describe("an empty inbox", () => {
    it("takes nothing", () =>
      freshRuntime((workflow) => {
        expect(workflow.transcript.takeInbox()).toBeNull();
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

    it("takes both into the row it returns", () =>
      queued((workflow) => {
        const id = workflow.transcript.takeInbox();
        expect(workflow.transcript.all()).toEqual([
          expect.objectContaining({ id, message: { role: "user", content: "first\n\nsecond" } }),
        ]);
      }));

    describe("once taken", () => {
      const taken = scenario(queued, (workflow) => {
        workflow.transcript.takeInbox();
      });

      it("leaves nothing waiting", () =>
        taken((workflow) => {
          expect(workflow.transcript.inbox()).toEqual([]);
        }));

      it("keeps them as the running turn's rows", () =>
        taken((workflow) => {
          expect(workflow.transcript.taken().map((row) => row.text)).toEqual(["first", "second"]);
        }));

      it("owes a reply only to the message a person wrote", () =>
        taken((workflow) => {
          expect(workflow.transcript.takenMessages().map((row) => row.text)).toEqual(["first"]);
        }));

      it("moves them into one user message in order", () =>
        taken((workflow) => {
          expect(workflow.transcript.all().map((row) => row.message)).toEqual([
            { role: "user", content: "first\n\nsecond" },
          ]);
        }));

      describe("with a row that arrives during the turn", () => {
        const arrived = scenario(taken, (workflow) => {
          workflow.transcript.enqueue("third", "message");
        });

        it("leaves it waiting for the next turn", () =>
          arrived((workflow) => {
            expect(workflow.transcript.inbox().map((row) => row.text)).toEqual(["third"]);
            expect(workflow.transcript.taken().map((row) => row.text)).toEqual(["first", "second"]);
          }));

        describe("taken again by a resumed turn", () => {
          const resumed = scenario(arrived, (workflow) => {
            workflow.transcript.takeInbox();
          });

          it("adds only the new row to the transcript", () =>
            resumed((workflow) => {
              expect(workflow.transcript.all().map((row) => row.message.content)).toEqual([
                "first\n\nsecond",
                "third",
              ]);
            }));

          it("owes a reply to every message the turns took", () =>
            resumed((workflow) => {
              expect(workflow.transcript.takenMessages().map((row) => row.text)).toEqual([
                "first",
                "third",
              ]);
            }));
        });

        describe("when the turn ends", () => {
          const ended = scenario(arrived, (workflow) => {
            workflow.transcript.deleteTaken();
          });

          it("deletes the taken rows and keeps the waiting one", () =>
            ended((workflow) => {
              expect(workflow.transcript.taken()).toEqual([]);
              expect(workflow.transcript.inbox().map((row) => row.text)).toEqual(["third"]);
            }));
        });
      });
    });
  });

  describe("a message a person wrote in a chat thread", () => {
    const queued = scenario(freshRuntime, (workflow) => {
      workflow.transcript.enqueue("fix it", "message", {
        reply_to: { source: "chat", channel: "C1", thread: "1.0" },
        chat_message: { channel: "C1", message: "1.5" },
      });
      workflow.transcript.enqueue("note", "none");
    });

    it("keeps the chat message for the first reply", () =>
      queued((workflow) => {
        expect(workflow.transcript.inbox().map((row) => row.chat_message)).toEqual([
          { channel: "C1", message: "1.5" },
          null,
        ]);
      }));

    describe("once taken", () => {
      const taken = scenario(queued, (workflow) => {
        workflow.transcript.takeInbox();
      });

      it("answers where the person wrote from", () =>
        taken((workflow) => {
          expect(workflow.transcript.answering()).toEqual([
            { source: "chat", channel: "C1", thread: "1.0" },
          ]);
        }));

      it("awaits the thumbs-up on it", () =>
        taken((workflow) => {
          expect(workflow.transcript.awaitingThumbsUp().map((row) => row.text)).toEqual(["fix it"]);
        }));

      describe("once the thumbs-up landed", () => {
        const reacted = scenario(taken, (workflow) => {
          workflow.transcript.markReacted(workflow.transcript.awaitingThumbsUp()[0]!.id);
        });

        it("awaits it no more", () =>
          reacted((workflow) => {
            expect(workflow.transcript.awaitingThumbsUp()).toEqual([]);
          }));
      });
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
