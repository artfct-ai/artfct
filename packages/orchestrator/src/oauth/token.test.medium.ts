import type { LinearTokens } from "@artfct-ai/adapters/tracker/linear/oauth";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRow, TOKENS } from "../../test/linear-install";
import { createDb } from "../db/client";
import { readLinearInstall, saveLinearInstall } from "../db/linear-installs";
import type { Env } from "../env";
import { InstallToken, REFRESH_MARGIN_MS } from "./token";

const db = createDb(env.DB);
const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const oauth: Env = { ...env, LINEAR_CLIENT_ID: "cid", LINEAR_CLIENT_SECRET: "sec" };
const noApp: Env = { ...env, LINEAR_CLIENT_ID: "", LINEAR_CLIENT_SECRET: "" };

type TokenRequest = { url: string; form: Record<string, string> };
type TokenEndpoint = { fetch: typeof fetch; calls: TokenRequest[] };

function tokenEndpoint(answer: LinearTokens | Response = TOKENS): TokenEndpoint {
  const calls: TokenRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url,
      form: Object.fromEntries(
        new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      ),
    });
    return answer instanceof Response ? answer.clone() : Response.json(answer);
  };
  return { fetch: fetchImpl, calls };
}

async function seeded(
  expiresInMs: number,
  patch: { refresh_token?: string | null; env?: Env; fetch?: typeof fetch } = {},
): Promise<InstallToken> {
  const row = installRow({
    access_token: "lin_oauth_old",
    refresh_token: patch.refresh_token === undefined ? "r1" : patch.refresh_token,
    expires_at: new Date(NOW + expiresInMs).toISOString(),
  });
  await saveLinearInstall(db, row);
  const stored = await readLinearInstall(db);
  if (!stored) throw new Error("no install");
  const options = { now: () => NOW, ...(patch.fetch ? { fetch: patch.fetch } : {}) };
  return new InstallToken(stored, patch.env ?? oauth, db, options);
}

const refreshed = { access_token: "lin_oauth_new", refresh_token: "r2", expires_in: 86399 };

describe("InstallToken", () => {
  describe("a token that is still fresh", () => {
    let endpoint: TokenEndpoint;
    let served: string[];
    beforeEach(async () => {
      endpoint = tokenEndpoint();
      const token = await seeded(REFRESH_MARGIN_MS + 60_000, { fetch: endpoint.fetch });
      served = [await token.current(), await token.current()];
    });

    it("serves the stored token from memory every time", () => {
      expect(served).toEqual(["lin_oauth_old", "lin_oauth_old"]);
    });

    it("never calls the token endpoint", () => {
      expect(endpoint.calls).toEqual([]);
    });
  });

  describe("a token close to its expiry, asked for twice at once", () => {
    let endpoint: TokenEndpoint;
    let token: InstallToken;
    let served: string[];
    beforeEach(async () => {
      endpoint = tokenEndpoint(refreshed);
      token = await seeded(REFRESH_MARGIN_MS - 1000, { fetch: endpoint.fetch });
      served = await Promise.all([token.current(), token.current()]);
    });

    it("serves the new token to both callers", () => {
      expect(served).toEqual(["lin_oauth_new", "lin_oauth_new"]);
    });

    it("refreshes once", () => {
      expect(endpoint.calls).toHaveLength(1);
    });

    it("spends the stored refresh token at the token endpoint", () => {
      expect(endpoint.calls[0]).toMatchObject({
        url: "https://api.linear.app/oauth/token",
        form: { grant_type: "refresh_token", refresh_token: "r1" },
      });
    });

    it("stores the new pair with its expiry", async () => {
      expect(await readLinearInstall(db)).toMatchObject({
        access_token: "lin_oauth_new",
        refresh_token: "r2",
        expires_at: new Date(NOW + 86399 * 1000).toISOString(),
      });
    });

    describe("asked again after the refresh", () => {
      let later: string;
      beforeEach(async () => {
        later = await token.current();
      });

      it("serves the new token", () => {
        expect(later).toBe("lin_oauth_new");
      });

      it("does not refresh again", () => {
        expect(endpoint.calls).toHaveLength(1);
      });
    });
  });

  describe("a token another isolate already refreshed", () => {
    let endpoint: TokenEndpoint;
    let served: string;
    beforeEach(async () => {
      endpoint = tokenEndpoint(refreshed);
      const token = await seeded(REFRESH_MARGIN_MS - 1000, { fetch: endpoint.fetch });
      await saveLinearInstall(
        db,
        installRow({
          access_token: "lin_oauth_theirs",
          refresh_token: "r5",
          expires_at: new Date(NOW + 86_000_000).toISOString(),
        }),
      );
      served = await token.current();
    });

    it("adopts the stored token", () => {
      expect(served).toBe("lin_oauth_theirs");
    });

    it("does not repeat the refresh", () => {
      expect(endpoint.calls).toEqual([]);
    });
  });

  describe("an expired token with no refresh token", () => {
    let endpoint: TokenEndpoint;
    let served: string;
    beforeEach(async () => {
      endpoint = tokenEndpoint(refreshed);
      const token = await seeded(0, { refresh_token: null, fetch: endpoint.fetch });
      served = await token.current();
    });

    it("keeps the token it has", () => {
      expect(served).toBe("lin_oauth_old");
    });

    it("never calls the token endpoint", () => {
      expect(endpoint.calls).toEqual([]);
    });
  });

  describe("an expired token without the OAuth app", () => {
    let endpoint: TokenEndpoint;
    let served: string;
    beforeEach(async () => {
      endpoint = tokenEndpoint(refreshed);
      const token = await seeded(0, { env: noApp, fetch: endpoint.fetch });
      served = await token.current();
    });

    it("keeps the token it has", () => {
      expect(served).toBe("lin_oauth_old");
    });

    it("never calls the token endpoint", () => {
      expect(endpoint.calls).toEqual([]);
    });
  });

  describe("a refresh the endpoint refuses on a still valid token", () => {
    const warnings: string[] = [];
    let endpoint: TokenEndpoint;
    let token: InstallToken;
    let served: string;
    beforeEach(async () => {
      warnings.length = 0;
      vi.spyOn(console, "warn").mockImplementation((...data: unknown[]) => {
        warnings.push(String(data[0]));
      });
      endpoint = tokenEndpoint(Response.json({ error: "server_error" }, { status: 500 }));
      token = await seeded(REFRESH_MARGIN_MS - 1000, { fetch: endpoint.fetch });
      served = await token.current();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("keeps the token it has", () => {
      expect(served).toBe("lin_oauth_old");
    });

    it("warns that it kept the token", () => {
      expect(warnings).toContainEqual(expect.stringMatching(/refresh failed, keeping/));
    });

    it("leaves the stored token alone", async () => {
      expect(await readLinearInstall(db)).toMatchObject({ access_token: "lin_oauth_old" });
    });

    describe("asked again", () => {
      let later: string;
      beforeEach(async () => {
        later = await token.current();
      });

      it("keeps the token again", () => {
        expect(later).toBe("lin_oauth_old");
      });

      it("retries the refresh", () => {
        expect(endpoint.calls).toHaveLength(2);
      });
    });
  });

  describe("a refresh the endpoint refuses on a dead token", () => {
    it("surfaces the error", async () => {
      const endpoint = tokenEndpoint(Response.json({ error: "invalid_grant" }, { status: 400 }));
      const token = await seeded(-1000, { fetch: endpoint.fetch });
      await expect(token.current()).rejects.toThrow("linear oauth refresh_token: invalid_grant");
    });
  });
});
