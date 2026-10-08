import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { fetchHeader, fetchUrl } from "../../../test/fetch";
import type { DecisionsModels } from "../types";
import { OPENROUTER_DEFAULT_DECISIONS_MODEL, OpenRouterDecisions } from "./decisions";

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

type Seen = {
  url: string;
  authorization: string | null;
  body: { model: string; state: Record<string, unknown>; questions: Record<string, unknown> };
};

type Host = { serverUrl: string } | { region: "eu" | "us" };

type Reply = { status: number; answers?: unknown };

const FALLBACK_MODEL = "typesafe/jev-1.12";

function decisionsReplying(
  reply: (seen: Seen, index: number) => Reply,
  options: { models?: DecisionsModels; host?: Host } = {},
) {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const current: Seen = {
      url: fetchUrl(request),
      authorization: fetchHeader(request, "authorization"),
      body: JSON.parse(await request.text()),
    };
    seen.push(current);
    const { status, answers } = reply(current, seen.length - 1);
    const payload =
      status === 200
        ? {
            model: current.body.model,
            answers,
            usage: { input_tokens: 40, output_tokens: 2, cost: 0.000002 },
          }
        : { error: { code: status, message: "no" } };
    return Response.json(payload, { status, headers: { "retry-after-ms": "1" } });
  };
  const decisions = new OpenRouterDecisions({
    apiKey: "key",
    ...(options.host ?? { serverUrl: "https://router.test" }),
    models: options.models ?? [OPENROUTER_DEFAULT_DECISIONS_MODEL],
    fetch: fake,
  });
  return { decisions, seen };
}

function decisionsAnswering(answers: unknown, status = 200, host?: Host) {
  return decisionsReplying(() => ({ status, answers }), { host });
}

type HangingFetch = { fetch: typeof fetch; sent: Promise<AbortSignal> };

function hangingFetch(): HangingFetch {
  const hanging: Partial<HangingFetch> = {};
  hanging.sent = new Promise<AbortSignal>((sent) => {
    hanging.fetch = (input, init) => {
      const signal = new Request(input, init).signal;
      sent(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    };
  });
  return hanging as HangingFetch;
}

describe("OpenRouterDecisions", () => {
  test("sends the state and every question as a noul to the decisions endpoint", async () => {
    const { decisions, seen } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });

    await decisions.decide({ message: "done yet?" }, { yesNo: QUESTIONS, choices: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://router.test/api/alpha/decisions");
    expect(seen[0]!.authorization).toBe("Bearer key");
    expect(seen[0]!.body).toEqual({
      model: OPENROUTER_DEFAULT_DECISIONS_MODEL,
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
    expect(answered.usage).toEqual({
      model: OPENROUTER_DEFAULT_DECISIONS_MODEL,
      input_tokens: 40,
      output_tokens: 2,
      cost_usd: 0.000002,
    });
  });

  test("throws when an asked question has no answer", async () => {
    const { decisions } = decisionsAnswering({});

    expect(decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} })).rejects.toThrow(
      "wants_answer",
    );
  });

  test("throws when the endpoint refuses the request, without a retry", async () => {
    const { decisions, seen } = decisionsAnswering({}, 401);

    await expect(
      decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("OpenRouterDecisions over several decisions models", () => {
  const ASKED = { yesNo: QUESTIONS, choices: {} };
  const ANSWERS = { wants_answer: { type: "noul", noul: 0.9 } };

  afterEach(() => {
    setSystemTime();
  });

  test("sends the first model it names", async () => {
    const { decisions, seen } = decisionsReplying(() => ({ status: 200, answers: ANSWERS }), {
      models: [FALLBACK_MODEL, OPENROUTER_DEFAULT_DECISIONS_MODEL],
    });

    await decisions.decide({ message: "hi" }, ASKED);

    expect(seen.map((request) => request.body.model)).toEqual([FALLBACK_MODEL]);
  });

  test("retries an overloaded model and takes its answer", async () => {
    const { decisions, seen } = decisionsReplying((_seen, index) =>
      index === 0 ? { status: 529 } : { status: 200, answers: ANSWERS },
    );

    const answered = await decisions.decide({ message: "hi" }, ASKED);

    expect(seen).toHaveLength(2);
    expect(answered.probabilities).toEqual({ wants_answer: 0.9 });
  });

  test("moves to the next model when one refuses the request", async () => {
    const { decisions, seen } = decisionsReplying(
      (request) =>
        request.body.model === FALLBACK_MODEL ? { status: 200, answers: ANSWERS } : { status: 404 },
      { models: [OPENROUTER_DEFAULT_DECISIONS_MODEL, FALLBACK_MODEL] },
    );

    const answered = await decisions.decide({ message: "hi" }, ASKED);

    expect(seen.map((request) => request.body.model)).toEqual([
      OPENROUTER_DEFAULT_DECISIONS_MODEL,
      FALLBACK_MODEL,
    ]);
    expect(answered.usage.model).toBe(FALLBACK_MODEL);
  });

  test("moves to the next model once one spends its retry budget", async () => {
    let clock = Date.now();
    const { decisions, seen } = decisionsReplying(
      (request) => {
        clock += 2000;
        setSystemTime(clock);
        return request.body.model === FALLBACK_MODEL
          ? { status: 200, answers: ANSWERS }
          : { status: 529 };
      },
      { models: [OPENROUTER_DEFAULT_DECISIONS_MODEL, FALLBACK_MODEL] },
    );

    const answered = await decisions.decide({ message: "hi" }, ASKED);

    const firstModelAttempts = seen.filter(
      (request) => request.body.model === OPENROUTER_DEFAULT_DECISIONS_MODEL,
    );
    expect(firstModelAttempts.length).toBeGreaterThan(1);
    expect(firstModelAttempts.length).toBeLessThan(6);
    expect(answered.usage.model).toBe(FALLBACK_MODEL);
  });

  test("throws when every model fails", async () => {
    const { decisions, seen } = decisionsReplying(() => ({ status: 404 }), {
      models: [OPENROUTER_DEFAULT_DECISIONS_MODEL, FALLBACK_MODEL],
    });

    await expect(decisions.decide({ message: "hi" }, ASKED)).rejects.toThrow(
      "every decisions model failed",
    );
    expect(seen).toHaveLength(2);
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
      model: OPENROUTER_DEFAULT_DECISIONS_MODEL,
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
    expect(answered.usage).toEqual({
      model: OPENROUTER_DEFAULT_DECISIONS_MODEL,
      input_tokens: 40,
      output_tokens: 2,
      cost_usd: 0.000002,
    });
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
    expect(Object.keys(seen[0]!.body.questions)).toEqual(["wants_answer", "model"]);
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

describe("OpenRouterDecisions under an abort signal", () => {
  const ASKED = { yesNo: QUESTIONS, choices: {} };

  test("rejects with the reason and sends nothing when the signal already aborted", async () => {
    const { decisions, seen } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });
    const reason = new Error("deadline passed");

    const call = decisions.decide({ message: "hi" }, ASKED, AbortSignal.abort(reason));

    await expect(call).rejects.toBe(reason);
    expect(seen).toEqual([]);
  });

  test("aborts the request in flight", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline passed");
    const { fetch: hanging, sent } = hangingFetch();
    const decisions = new OpenRouterDecisions({
      apiKey: "key",
      serverUrl: "https://router.test",
      models: [OPENROUTER_DEFAULT_DECISIONS_MODEL],
      fetch: hanging,
    });

    const call = decisions.decide({ message: "hi" }, ASKED, controller.signal);
    const inFlight = await sent;
    controller.abort(reason);

    await expect(call).rejects.toBe(reason);
    expect(inFlight.aborted).toBe(true);
  });

  test("rejects at once while the SDK waits to retry an overloaded endpoint", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline passed");
    let requests = 0;
    const overloaded: typeof fetch = async () => {
      requests += 1;
      setTimeout(() => controller.abort(reason), 5);
      return Response.json(
        { error: { code: 529, message: "overloaded" } },
        { status: 529, headers: { "retry-after": "30" } },
      );
    };
    const decisions = new OpenRouterDecisions({
      apiKey: "key",
      serverUrl: "https://router.test",
      models: [OPENROUTER_DEFAULT_DECISIONS_MODEL],
      fetch: overloaded,
    });
    const started = Date.now();

    await expect(decisions.decide({ message: "hi" }, ASKED, controller.signal)).rejects.toBe(
      reason,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(requests).toBe(1);
  });
});
