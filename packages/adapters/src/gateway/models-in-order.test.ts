import { afterEach, describe, expect, jest, test } from "bun:test";
import { askModelsInOrder, DECISIONS_MODEL_BUDGET_MS } from "./models-in-order";

const neverSettles = () => new Promise<string>(() => {});

describe("askModelsInOrder", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("takes the answer of the first model that answers", async () => {
    const asked: string[] = [];
    const answer = await askModelsInOrder(["first", "second"], undefined, async (model) => {
      asked.push(model);
      if (model === "first") throw new Error("overloaded");
      return `${model} answered`;
    });

    expect(answer).toBe("second answered");
    expect(asked).toEqual(["first", "second"]);
  });

  test("moves to the next model once one runs past its budget", async () => {
    jest.useFakeTimers();
    const asked: string[] = [];
    const call = askModelsInOrder(["slow", "fast"], undefined, async (model) => {
      asked.push(model);
      return model === "slow" ? neverSettles() : `${model} answered`;
    });

    jest.advanceTimersByTime(DECISIONS_MODEL_BUDGET_MS);

    expect(await call).toBe("fast answered");
    expect(asked).toEqual(["slow", "fast"]);
  });

  test("stops at the abort reason without asking the next model", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline passed");
    const asked: string[] = [];
    const call = askModelsInOrder(["hangs", "next"], controller.signal, async (model) => {
      asked.push(model);
      return neverSettles();
    });

    controller.abort(reason);

    await expect(call).rejects.toBe(reason);
    expect(asked).toEqual(["hangs"]);
  });

  test("names every failure when every model fails", async () => {
    const call = askModelsInOrder(["first", "second"], undefined, async (model) => {
      throw new Error(`${model} is down`);
    });

    await expect(call).rejects.toThrow(
      "every decisions model failed. first failed: Error: first is down. second failed: Error: second is down",
    );
  });
});
