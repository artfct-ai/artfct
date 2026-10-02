import { describe, expect, test } from "bun:test";
import { fetchHeader, fetchUrl } from "../../../test/fetch";
import { OPENROUTER_DECISIONS_MODEL, OpenRouterDecisions } from "./decisions";

await Promise.all([
  import("@openrouter/sdk/funcs/alphaDecisionsCreate.js"),
  import("@openrouter/sdk/core.js"),
  import("@openrouter/sdk/lib/http.js"),
]);

const QUESTIONS = {
  wants_answer: {
    instructions: "Does `message` ask a question?",
    yes: "It asks.",
    no: "It tells.",
  },
};

type Seen = { url: string; authorization: string | null; body: unknown };

type Host = { serverUrl: string } | { region: "eu" | "us" };

function decisionsAnswering(
  answers: unknown,
  status = 200,
  host: Host = { serverUrl: "https://router.test" },
) {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({
      url: fetchUrl(request),
      authorization: fetchHeader(request, "authorization"),
      body: JSON.parse(await request.text()),
    });
    const payload =
      status === 200
        ? {
            model: OPENROUTER_DECISIONS_MODEL,
            answers,
            usage: { input_tokens: 40, output_tokens: 2, cost: 0.000002 },
          }
        : { error: { code: status, message: "no" } };
    return Response.json(payload, { status });
  };
  const decisions = new OpenRouterDecisions({ apiKey: "key", ...host, fetch: fake });
  return { decisions, seen };
}

describe("OpenRouterDecisions", () => {
  test("sends the state and every question as a noul to the decisions endpoint", async () => {
    const { decisions, seen } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });

    await decisions.decide({ message: "done yet?" }, { yesNo: QUESTIONS, choices: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://router.test/api/alpha/decisions");
    expect(seen[0]!.authorization).toBe("Bearer key");
    expect(seen[0]!.body).toEqual({
      model: OPENROUTER_DECISIONS_MODEL,
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

  test("sends a decision to the host of its region", async () => {
    const { decisions, seen } = decisionsAnswering(
      { wants_answer: { type: "noul", noul: 0.9 } },
      200,
      { region: "eu" },
    );

    await decisions.decide({ message: "done yet?" }, { yesNo: QUESTIONS, choices: {} });

    expect(seen.map((request) => request.url)).toEqual([
      "https://eu.openrouter.ai/api/alpha/decisions",
    ]);
  });

  test("returns the probability of yes and the usage with its cost", async () => {
    const { decisions } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });

    const answered = await decisions.decide(
      { message: "done yet?" },
      { yesNo: QUESTIONS, choices: {} },
    );

    expect(answered.probabilities).toEqual({ wants_answer: 0.9 });
    expect(answered.usage).toEqual({ input_tokens: 40, output_tokens: 2, cost_usd: 0.000002 });
  });

  test("throws when an asked question has no answer", async () => {
    const { decisions } = decisionsAnswering({});

    expect(decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} })).rejects.toThrow(
      "wants_answer",
    );
  });

  test("throws when the endpoint refuses the request", async () => {
    const { decisions } = decisionsAnswering({}, 401);

    expect(
      decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} }),
    ).rejects.toThrow();
  });
});

const MODEL_QUESTION = {
  model: {
    instructions: "Which model does `message` name?",
    options: { "claude-opus-5-5": "Claude Opus 5.5", none: "No model in this list." },
  },
};

describe("OpenRouterDecisions choice questions", () => {
  test("sends every question as a choice whose criteria are its options", async () => {
    const { decisions, seen } = decisionsAnswering({
      model: { type: "choice", choice: "none", probabilities: { none: 1 } },
    });

    await decisions.decide({ message: "use opus" }, { yesNo: {}, choices: MODEL_QUESTION });

    expect(seen[0]!.body).toEqual({
      model: OPENROUTER_DECISIONS_MODEL,
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

  test("returns the picked option with its probability and the usage", async () => {
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
    expect(answered.usage).toEqual({ input_tokens: 40, output_tokens: 2, cost_usd: 0.000002 });
  });

  test("throws when a question gets no choice", async () => {
    const { decisions } = decisionsAnswering({ model: { type: "noul", noul: 0.9 } });

    expect(
      decisions.decide({ message: "use opus" }, { yesNo: {}, choices: MODEL_QUESTION }),
    ).rejects.toThrow("model");
  });
});

describe("OpenRouterDecisions with both kinds of question", () => {
  test("sends every question in one request", async () => {
    const { decisions, seen } = decisionsAnswering({
      wants_answer: { type: "noul", noul: 0.2 },
      model: { type: "choice", choice: "none", probabilities: { none: 1 } },
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
      model: { type: "choice", choice: "none", probabilities: { none: 1 } },
    });

    const answered = await decisions.decide(
      { message: "use opus" },
      { yesNo: QUESTIONS, choices: MODEL_QUESTION },
    );

    expect(answered.probabilities).toEqual({ wants_answer: 0.2 });
    expect(answered.choices).toEqual({ model: { option: "none", probability: 1 } });
  });
});
