import { describe, expect, test } from "bun:test";
import { fetchHeader, fetchUrl } from "../../../test/fetch";
import type { DecisionsModels } from "../types";
import { CloudflareDecisions, decisionsRoute } from "./decisions";

await Promise.all([
  import("cloudflare/client"),
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
  gateway: string | null;
  body: { model: string; state: Record<string, unknown>; questions: Record<string, unknown> };
};

type Reply = { status: number; answers?: unknown };

const CLEF = "workers-ai/@cf/cloudflare/clef";

const FLASH_MODEL = "workers-ai/@cf/cloudflare/clef-flash";

function decisionsReplying(
  reply: (seen: Seen, index: number) => Reply,
  models: DecisionsModels = [CLEF],
) {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const current: Seen = {
      url: fetchUrl(request),
      authorization: fetchHeader(request, "authorization"),
      gateway: fetchHeader(request, "cf-aig-gateway-id"),
      body: JSON.parse(await request.text()),
    };
    seen.push(current);
    const { status, answers } = reply(current, seen.length - 1);
    const payload =
      status === 200
        ? {
            result: {
              model: current.body.model,
              answers,
              usage: { input_tokens: 40, output_tokens: 2 },
            },
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
    return Response.json(payload, { status, headers: { "retry-after-ms": "0" } });
  };
  const decisions = new CloudflareDecisions({
    accountId: "acct",
    gatewayId: "gw",
    token: "t",
    models,
    fetch: fake,
  });
  return { decisions, seen };
}

function decisionsAnswering(answers: unknown, status = 200) {
  return decisionsReplying(() => ({ status, answers }));
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
    expect(answered.usage).toEqual({
      model: "@cf/cloudflare/clef",
      input_tokens: 40,
      output_tokens: 2,
      cost_usd: 0,
    });
  });

  test("throws when an asked question has no answer", async () => {
    const { decisions } = decisionsAnswering({});

    expect(decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} })).rejects.toThrow(
      "wants_answer",
    );
  });

  test("throws when the endpoint refuses the request, without a retry", async () => {
    const { decisions, seen } = decisionsAnswering({}, 400);

    await expect(
      decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  test("gives up on a failing endpoint after three attempts", async () => {
    const { decisions, seen } = decisionsAnswering({}, 500);

    await expect(
      decisions.decide({ message: "hi" }, { yesNo: QUESTIONS, choices: {} }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(3);
  });
});

describe("CloudflareDecisions over several decisions models", () => {
  const ASKED = { yesNo: QUESTIONS, choices: {} };
  const ANSWERS = { wants_answer: { type: "noul", noul: 0.9 } };

  test("runs the first model it names, with its own selector", async () => {
    const { decisions, seen } = decisionsReplying(
      () => ({ status: 200, answers: ANSWERS }),
      [FLASH_MODEL, CLEF],
    );

    await decisions.decide({ message: "hi" }, ASKED);

    expect(seen.map((request) => [request.url, request.body.model])).toEqual([
      [
        "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash",
        "clef-flash",
      ],
    ]);
  });

  test("retries an overloaded model and takes its answer", async () => {
    const { decisions, seen } = decisionsReplying((_seen, index) =>
      index === 0 ? { status: 529 } : { status: 200, answers: ANSWERS },
    );

    const answered = await decisions.decide({ message: "hi" }, ASKED);

    expect(seen).toHaveLength(2);
    expect(answered.probabilities).toEqual({ wants_answer: 0.9 });
  });

  test("moves to the next model once one fails every attempt", async () => {
    const { decisions, seen } = decisionsReplying(
      (request) =>
        request.body.model === "clef-flash" ? { status: 200, answers: ANSWERS } : { status: 503 },
      [CLEF, FLASH_MODEL],
    );

    const answered = await decisions.decide({ message: "hi" }, ASKED);

    expect(seen.map((request) => request.body.model)).toEqual([
      "clef",
      "clef",
      "clef",
      "clef-flash",
    ]);
    expect(answered.usage.model).toBe("@cf/cloudflare/clef-flash");
  });

  test("throws when every model fails", async () => {
    const { decisions, seen } = decisionsReplying(() => ({ status: 404 }), [CLEF, FLASH_MODEL]);

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
    expect(Object.keys(seen[0]!.body.questions)).toEqual(["wants_answer", "model"]);
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

describe("CloudflareDecisions under an abort signal", () => {
  test("rejects and sends nothing when the signal already aborted", async () => {
    const { decisions, seen } = decisionsAnswering({ wants_answer: { type: "noul", noul: 0.9 } });

    const call = decisions.decide(
      { message: "hi" },
      { yesNo: QUESTIONS, choices: {} },
      AbortSignal.abort(new Error("deadline passed")),
    );

    await expect(call).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  test("aborts the request in flight", async () => {
    const controller = new AbortController();
    const { fetch: hanging, sent } = hangingFetch();
    const decisions = new CloudflareDecisions({
      accountId: "acct",
      gatewayId: "gw",
      token: "t",
      models: [CLEF],
      fetch: hanging,
    });

    const call = decisions.decide(
      { message: "hi" },
      { yesNo: QUESTIONS, choices: {} },
      controller.signal,
    );
    const inFlight = await sent;
    controller.abort(new Error("deadline passed"));

    await expect(call).rejects.toThrow();
    expect(inFlight.aborted).toBe(true);
  });
});

function openRouterReplying(
  status: number,
  options: { openRouterKey?: string; openRouterRegion?: "eu" | "us" } = {},
) {
  const seen: Array<{ url: string; authorization: string | null; model: string }> = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text());
    seen.push({
      url: fetchUrl(request),
      authorization: fetchHeader(request, "authorization"),
      model: body.model,
    });
    const payload =
      status === 200
        ? {
            model: body.model,
            answers: { wants_answer: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 40, output_tokens: 2, cost: 0.000002 },
          }
        : { error: { code: status, message: "no" } };
    return Response.json(payload, { status, headers: { "retry-after-ms": "1" } });
  };
  const decisions = new CloudflareDecisions({
    accountId: "acct",
    gatewayId: "gw",
    token: "t",
    models: ["openrouter/typesafe/jev-1.13", CLEF],
    fetch: fake,
    ...options,
  });
  return { decisions, seen };
}

describe("CloudflareDecisions on an OpenRouter model", () => {
  const ASKED = { yesNo: QUESTIONS, choices: {} };

  test("asks OpenRouter's decisions endpoint on the OpenRouter key, by the name OpenRouter knows", async () => {
    const { decisions, seen } = openRouterReplying(200, { openRouterKey: "sk-or" });

    const answered = await decisions.decide({ message: "hi" }, ASKED);

    expect(seen).toEqual([
      {
        url: "https://openrouter.ai/api/alpha/decisions",
        authorization: "Bearer sk-or",
        model: "typesafe/jev-1.13",
      },
    ]);
    expect(answered.probabilities).toEqual({ wants_answer: 0.9 });
    expect(answered.usage).toEqual({
      model: "typesafe/jev-1.13",
      input_tokens: 40,
      output_tokens: 2,
      cost_usd: 0.000002,
    });
  });

  test("keeps the request inside the OpenRouter region", async () => {
    const { decisions, seen } = openRouterReplying(200, {
      openRouterKey: "sk-or",
      openRouterRegion: "eu",
    });

    await decisions.decide({ message: "hi" }, ASKED);

    expect(seen[0]!.url).toBe("https://eu.openrouter.ai/api/alpha/decisions");
  });

  test("moves to the next model without an OpenRouter key", async () => {
    const { decisions, seen } = openRouterReplying(200);

    await decisions.decide({ message: "hi" }, ASKED).catch(() => null);

    expect(seen.map((request) => request.url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef",
    ]);
  });
});

describe("decisionsRoute", () => {
  test("runs a workers-ai model on Workers AI by its own id", () => {
    expect(decisionsRoute("workers-ai/@cf/cloudflare/clef")).toEqual({
      kind: "workers_ai",
      model: "@cf/cloudflare/clef",
    });
  });

  test("runs an openrouter model on OpenRouter by the name OpenRouter knows", () => {
    expect(decisionsRoute("openrouter/cloudflare/clef-flash")).toEqual({
      kind: "openrouter",
      model: "cloudflare/clef-flash",
    });
  });

  test("refuses a model on any other provider", () => {
    expect(() => decisionsRoute("openai/gpt-5")).toThrow("openai/gpt-5");
  });
});
