import { describe, expect, it } from "bun:test";
import type { Choice } from "@artfct-ai/adapters/gateway/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import type { Scenario } from "../../../test/scenario";
import {
  closingTextWithheld,
  namesModelFrom,
  OWED_REPLY_PURPOSE,
  owedReplyFrom,
  readPersonMessage,
  requestsWorkFrom,
  UNREAD_MESSAGE,
  type PersonMessage,
} from "./owed-reply";

type Asked = { runtime: FakeRuntime; decisions: FakeDecisions; read: PersonMessage };

function askedWith(
  answers: Record<string, number> | Error,
  message: string,
  choices: Record<string, Choice> = {},
): Scenario<Asked> {
  return (run) =>
    freshRuntime(async (runtime) => {
      const decisions = new FakeDecisions(answers, choices);
      runtime.gatewayInstance = new FakeGateway({ decisions });
      const read = await readPersonMessage(runtime, message);
      await run({ runtime, decisions, read });
    });
}

describe("owedReplyFrom", () => {
  it("reads clear work with no question as the board", () => {
    expect(owedReplyFrom({ wants_answer: 0.12, wants_work: 0.93 })).toBe("board");
  });

  it("reads a question as an answer", () => {
    expect(owedReplyFrom({ wants_answer: 0.96, wants_work: 0.15 })).toBe("answer");
  });

  it("reads a question that also asks for work as an answer", () => {
    expect(owedReplyFrom({ wants_answer: 0.65, wants_work: 0.83 })).toBe("answer");
  });

  it("reads a message that asks for neither as an answer", () => {
    expect(owedReplyFrom({ wants_answer: 0.02, wants_work: 0.19 })).toBe("answer");
  });
});

describe("requestsWorkFrom", () => {
  it("reads clear work as a request for work", () => {
    expect(requestsWorkFrom({ wants_work: 0.93 })).toBe(true);
  });

  it("reads a question as no request for work", () => {
    expect(requestsWorkFrom({ wants_work: 0.19 })).toBe(false);
  });

  it("reads an unsure answer as a request for work", () => {
    expect(requestsWorkFrom({ wants_work: 0.5 })).toBe(true);
  });
});

describe("closingTextWithheld", () => {
  it("withholds the text of a turn nobody wrote to", () => {
    expect(closingTextWithheld(null, false)).toBe("nobody wrote");
  });

  it("withholds the text after a board change the person asked for", () => {
    expect(closingTextWithheld("board", true)).toBe("the board is the reply");
  });

  it("posts the text when the person asked for work and no board changed", () => {
    expect(closingTextWithheld("board", false)).toBeNull();
  });

  it("posts the answer even when the board changed", () => {
    expect(closingTextWithheld("answer", true)).toBeNull();
  });
});

describe("namesModelFrom", () => {
  it("reads a clear yes as naming a model", () => {
    expect(namesModelFrom({ names_model: 0.97 })).toBe(true);
  });

  it("reads an unsure answer as naming no model", () => {
    expect(namesModelFrom({ names_model: 0.5 })).toBe(false);
  });
});

describe("readPersonMessage", () => {
  describe("a message that names a model", () => {
    const asked = askedWith(
      { wants_answer: 0.1, wants_work: 0.9, names_model: 0.97 },
      "implement it with glm 5.3",
    );

    it("names a model", () =>
      asked(({ read }) => {
        expect(read.namesModel).toBe(true);
      }));
  });

  describe("a message that asks for work", () => {
    const asked = askedWith({ wants_answer: 0.1, wants_work: 0.9 }, "lets move to a plan");

    it("is owed the board and requests work", () =>
      asked(({ read }) => {
        expect(read).toEqual({
          owed: "board",
          requestsWork: true,
          namesModel: false,
          inputArtifact: null,
        });
      }));

    it("sends the person's words as the state", () =>
      asked(({ decisions }) => {
        expect(decisions.asked).toEqual([{ message: "lets move to a plan" }]);
      }));

    it("records what the call used", () =>
      asked(({ runtime }) => {
        expect(runtime.store.modelUsage()).toEqual([
          expect.objectContaining({ purpose: OWED_REPLY_PURPOSE, model: "fake-decisions" }),
        ]);
      }));
  });

  describe("a message that names an issue", () => {
    const asked = askedWith({ wants_answer: 0.1, wants_work: 0.9 }, "pickup ENG-42 please", {
      artifact: { option: "issues", probability: 0.9 },
    });

    it("reads the kind of input artifact", () =>
      asked(({ read }) => {
        expect(read.inputArtifact).toBe("issues");
      }));

    it("asks the artifact question in the same call", () =>
      asked(({ decisions }) => {
        expect(decisions.asked).toHaveLength(1);
        expect(decisions.offered).toHaveLength(1);
      }));
  });

  describe("a question", () => {
    const asked = askedWith({ wants_answer: 0.9, wants_work: 0.1 }, "how does the refiner work?");

    it("is owed an answer and requests no work", () =>
      asked(({ read }) => {
        expect(read).toEqual({
          owed: "answer",
          requestsWork: false,
          namesModel: false,
          inputArtifact: null,
        });
      }));
  });

  describe("a decisions call that fails", () => {
    const failed = askedWith(new Error("timeout"), "lets move to a plan");

    it("is owed an answer and requests work", () =>
      failed(({ read }) => {
        expect(read).toEqual(UNREAD_MESSAGE);
      }));
  });
});
