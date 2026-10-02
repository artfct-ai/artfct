import { describe, expect, test } from "bun:test";
import { fetchHeader, fetchUrl } from "../../../test/fetch";
import { CloudflareDecisions } from "./decisions";

await import("cloudflare/client");

const QUESTIONS = {
  wants_answer: {
    instructions: "Does `message` ask a question?",
    yes: "It asks.",
    no: "It tells.",
  },
};

type Seen = { url: string; authorization: string | null; gateway: string | null; body: unknown };

function decisionsAnswering(answers: unknown, status = 200) {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({
      url: fetchUrl(request),
      authorization: fetchHeader(request, "authorization"),
      gateway: fetchHeader(request, "cf-aig-gateway-id"),
      body: JSON.parse(await request.text()),
    });
    const payload =
      status === 200
        ? {
            result: { model: "clef", answers, usage: { input_tokens: 40, output_tokens: 2 } },
            success: true,
            errors: [],
            messages: [],
          }
        : {
            result: null,
            success: false,
            errors: [{ code: status, message: "no" }],
            messages: [],
          };
    return Response.json(payload, { status });
  };
  const decisions = new CloudflareDecisions({
    accountId: "acct",
    gatewayId: "gw",
    token: "t",
    fetch: fake,
  });
  return { decisions, seen };
}

describe("CloudflareDecisions", () => {
  test("sends the state and every question as a noul to the Workers AI run endpoint", async () => {
    const { decisions, seen } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });

    await decisions.decide({ message: "done yet?" }, { yesNo: QUESTIONS, choices: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef",
    );
    expect(seen[0]!.body).toEqual({
      model: "clef",
      state: { message: "done yet?" },
      questions: {
        wants_answer: {
          type: "noul",
          instructions: "Does `message` ask a question?",
          criteria: { true: "It asks.", false: "It tells." },
        },
      },
    });
  });

  test("authorizes with the token and names the gateway that logs the call", async () => {
    const { decisions, seen } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });

    await decisions.decide({ message: "done yet?" }, { yesNo: QUESTIONS, choices: {} });

    expect(seen[0]!.authorization).toBe("Bearer t");
    expect(seen[0]!.gateway).toBe("gw");
  });

  test("returns the probability of yes and the usage at no cost", async () => {
    const { decisions } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });

    const answered = await decisions.decide(
      { message: "done yet?" },
      { yesNo: QUESTIONS, choices: {} },
    );

    expect(answered.probabilities).toEqual({ wants_answer: 0.9 });
    expect(answered.usage).toEqual({ input_tokens: 40, output_tokens: 2, cost_usd: 0 });
  });

  test("throws when an asked question has no answer", async () => {
    const { decisions } = decisionsAnswering({});

    expect(decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} })).rejects.toThrow(
      "wants_answer",
    );
  });

  test("throws when the endpoint refuses the request, without a retry", async () => {
    const { decisions, seen } = decisionsAnswering({}, 500);

    await expect(
      decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});

const MODEL_QUESTION = {
  model: {
    instructions: "Which model does `message` name?",
    options: { "claude-opus-5-5": "Claude Opus 5.5", none: "No model in this list." },
  },
};

describe("CloudflareDecisions choice questions", () => {
  test("sends every question as a choice whose criteria are its options", async () => {
    const { decisions, seen } = decisionsAnswering({
      model: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 1 },
    });

    await decisions.decide({ message: "use opus" }, { yesNo: {}, choices: MODEL_QUESTION });

    expect(seen[0]!.body).toEqual({
      model: "clef",
      state: { message: "use opus" },
      questions: {
        model: {
          type: "choice",
          instructions: "Which model does `message` name?",
          criteria: { "claude-opus-5-5": "Claude Opus 5.5", none: "No model in this list." },
        },
      },
    });
  });

  test("returns the picked option with its probability", async () => {
    const { decisions } = decisionsAnswering({
      model: {
        type: "choice",
        choice: "claude-opus-5-5",
        confidence: 0.7,
        probabilities: { "claude-opus-5-5": 0.8, none: 0.2 },
      },
    });

    const answered = await decisions.decide(
      { message: "use opus" },
      { yesNo: {}, choices: MODEL_QUESTION },
    );

    expect(answered.choices).toEqual({ model: { option: "claude-opus-5-5", probability: 0.8 } });
  });

  test("throws when a question gets no choice", async () => {
    const { decisions } = decisionsAnswering({ model: { type: "noul", noul: 0.9 } });

    expect(
      decisions.decide({ message: "use opus" }, { yesNo: {}, choices: MODEL_QUESTION }),
    ).rejects.toThrow("model");
  });

  test("throws when the picked option has no probability", async () => {
    const { decisions } = decisionsAnswering({
      model: { type: "choice", choice: "none", probabilities: {}, confidence: 0 },
    });

    expect(
      decisions.decide({ message: "use opus" }, { yesNo: {}, choices: MODEL_QUESTION }),
    ).rejects.toThrow("model");
  });
});

describe("CloudflareDecisions with both kinds of question", () => {
  test("sends every question in one request", async () => {
    const { decisions, seen } = decisionsAnswering({
      wants_answer: { type: "noul", noul: 0.2 },
      model: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 1 },
    });

    await decisions.decide({ message: "use opus" }, { yesNo: QUESTIONS, choices: MODEL_QUESTION });

    expect(seen).toHaveLength(1);
    expect(Object.keys((seen[0]!.body as { questions: object }).questions)).toEqual([
      "wants_answer",
      "model",
    ]);
  });

  test("returns the probabilities and the picks together", async () => {
    const { decisions } = decisionsAnswering({
      wants_answer: { type: "noul", noul: 0.2 },
      model: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 1 },
    });

    const answered = await decisions.decide(
      { message: "use opus" },
      { yesNo: QUESTIONS, choices: MODEL_QUESTION },
    );

    expect(answered.probabilities).toEqual({ wants_answer: 0.2 });
    expect(answered.choices).toEqual({ model: { option: "none", probability: 1 } });
  });
});
