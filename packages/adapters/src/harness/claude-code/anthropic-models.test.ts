import { describe, expect, test } from "bun:test";
import { fetchUrl } from "../../../test/fetch";
import { anthropicModels } from "./anthropic-models";

const CATALOG = {
  anthropic: {
    models: {
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5 (latest)",
        release_date: "2025-11-24",
      },
      "claude-opus-4-5-20251101": {
        id: "claude-opus-4-5-20251101",
        name: "Claude Opus 4.5",
        release_date: "2025-11-24",
      },
      "claude-opus-5-5": {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        release_date: "2026-09-22",
      },
    },
  },
  openai: { models: {} },
};

function catalogAnswering(status = 200) {
  const seen: string[] = [];
  const fake: typeof fetch = async (input) => {
    seen.push(fetchUrl(input));
    return status === 200 ? Response.json(CATALOG) : new Response("no", { status });
  };
  return { fetch: fake, seen };
}

describe("anthropicModels", () => {
  test("reads the models.dev catalog", async () => {
    const { fetch, seen } = catalogAnswering();

    await anthropicModels(fetch);

    expect(seen).toEqual(["https://models.dev/api.json"]);
  });

  test("lists each model once by its plain id, newest first", async () => {
    const { fetch } = catalogAnswering();

    expect(await anthropicModels(fetch)).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", released: "2026-09-22" },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", released: "2025-11-24" },
    ]);
  });

  test("throws when the catalog does not answer", async () => {
    const { fetch } = catalogAnswering(503);

    expect(anthropicModels(fetch)).rejects.toThrow("503");
  });
});
