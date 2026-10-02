import { APP_USER, FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { LinearTokens } from "@artfct-ai/adapters/tracker/linear/oauth";
import type { LinearInstallResult } from "@artfct-ai/contracts/types";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { installRow, TOKENS } from "../../test/linear-install";
import { createDb } from "../db/client";
import { readLinearInstall, saveLinearInstall } from "../db/linear-installs";
import type { Env } from "../env";
import { completeLinearInstall, linearInstallUrl, STATE_LIFETIME_MS } from "./install";
import type { TokenOptions } from "./token";

const db = createDb(env.DB);
const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const oauth: Env = { ...env, LINEAR_CLIENT_ID: "cid", LINEAR_CLIENT_SECRET: "sec" };
const nothing: Env = { ...oauth, LINEAR_CLIENT_ID: "", LINEAR_CLIENT_SECRET: "" };

const REDIRECT = "https://ingress.test/linear/oauth/callback";
const callback = { redirect_uri: REDIRECT };
const clock = { now: () => NOW };

type TokenRequest = { url: string; form: Record<string, string> };
type TokenEndpoint = { fetch: typeof fetch; calls: TokenRequest[] };
type Seams = { options: TokenOptions; endpoint: TokenEndpoint; tokens: string[] };

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

function seams(answer: LinearTokens | Response = TOKENS): Seams {
  const endpoint = tokenEndpoint(answer);
  const tokens: string[] = [];
  const options: TokenOptions = {
    ...clock,
    fetch: endpoint.fetch,
    tracker: (token) => {
      tokens.push(token);
      return new FakeTracker({ appUser: APP_USER });
    },
  };
  return { options, endpoint, tokens };
}

async function installLink(): Promise<URL> {
  const link = await linearInstallUrl(oauth, db, callback, clock);
  if (!("url" in link)) throw new Error(link.error);
  return new URL(link.url);
}

async function freshState(): Promise<string> {
  return (await installLink()).searchParams.get("state") ?? "";
}

describe("linearInstallUrl", () => {
  describe("without the OAuth app", () => {
    it("explains the missing secrets", async () => {
      expect(await linearInstallUrl(nothing, db, callback)).toEqual({
        error: "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are not set",
      });
    });
  });

  describe("with the OAuth app", () => {
    let url: URL;
    beforeEach(async () => {
      url = await installLink();
    });

    it("points at the Linear authorize endpoint", () => {
      expect(`${url.origin}${url.pathname}`).toBe("https://linear.app/oauth/authorize");
    });

    it("carries exactly the documented parameters", () => {
      expect([...url.searchParams.keys()].toSorted()).toEqual([
        "actor",
        "client_id",
        "prompt",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ]);
    });

    it("asks for an authorization code", () => {
      expect(url.searchParams.get("response_type")).toBe("code");
    });

    it("asks for the agent scopes", () => {
      expect(url.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable");
    });

    it("asks the admin for consent", () => {
      expect(url.searchParams.get("prompt")).toBe("consent");
    });

    it("names the OAuth client", () => {
      expect(url.searchParams.get("client_id")).toBe("cid");
    });

    it("names the callback ingress passed", () => {
      expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    });

    it("asks to act as the app", () => {
      expect(url.searchParams.get("actor")).toBe("app");
    });

    it("carries a state of 32 characters", () => {
      expect(url.searchParams.get("state")).toHaveLength(32);
    });

    it("mints a new state for the next link", async () => {
      expect(await freshState()).not.toBe(url.searchParams.get("state"));
    });
  });
});

describe("completeLinearInstall", () => {
  describe("a callback with a fresh state", () => {
    let seam: Seams;
    let state: string;
    let result: LinearInstallResult;
    beforeEach(async () => {
      seam = seams();
      state = await freshState();
      result = await completeLinearInstall(
        oauth,
        db,
        { code: "c1", state, ...callback },
        seam.options,
      );
    });

    it("reports the workspace it installed in", () => {
      expect(result).toEqual({ installed: true, organization: "Acme", app_user_id: "app1" });
    });

    it("exchanges the code at the token endpoint", () => {
      expect(seam.endpoint.calls.map((request) => request.url)).toEqual([
        "https://api.linear.app/oauth/token",
      ]);
    });

    it("sends the authorization code grant with the callback", () => {
      expect(seam.endpoint.calls[0]?.form).toMatchObject({
        grant_type: "authorization_code",
        code: "c1",
        redirect_uri: REDIRECT,
      });
    });

    it("reads the app user with the new token", () => {
      expect(seam.tokens).toEqual(["lin_oauth_a"]);
    });

    it("stores the install with its expiry", async () => {
      expect(await readLinearInstall(db)).toMatchObject({
        organization_id: "org1",
        app_user_id: "app1",
        access_token: "lin_oauth_a",
        refresh_token: "r1",
        expires_at: new Date(NOW + 86399 * 1000).toISOString(),
      });
    });

    describe("a second callback with the same state", () => {
      let second: LinearInstallResult;
      beforeEach(async () => {
        second = await completeLinearInstall(
          oauth,
          db,
          { code: "c2", state, ...callback },
          seam.options,
        );
      });

      it("refuses the spent state", () => {
        expect(second).toEqual({
          installed: false,
          error: "state is invalid, expired, or already used. Request a new install link.",
        });
      });

      it("does not exchange the second code", () => {
        expect(seam.endpoint.calls).toHaveLength(1);
      });

      it("does not read the app user again", () => {
        expect(seam.tokens).toHaveLength(1);
      });
    });
  });

  describe("callbacks the install refuses", () => {
    let seam: Seams;
    let noApp: LinearInstallResult;
    let unknownState: LinearInstallResult;
    let staleState: LinearInstallResult;
    beforeEach(async () => {
      seam = seams();
      const state = await freshState();
      noApp = await completeLinearInstall(nothing, db, { code: "c1", state, ...callback });
      unknownState = await completeLinearInstall(
        oauth,
        db,
        { code: "c1", state: "never-minted", ...callback },
        seam.options,
      );
      staleState = await completeLinearInstall(
        oauth,
        db,
        { code: "c1", state, ...callback },
        { ...seam.options, now: () => NOW + STATE_LIFETIME_MS + 1 },
      );
    });

    it("refuses a callback without the OAuth app", () => {
      expect(noApp).toMatchObject({ installed: false });
    });

    it("refuses a state nobody minted", () => {
      expect(unknownState.installed).toBe(false);
    });

    it("refuses a state that expired", () => {
      expect(staleState.installed).toBe(false);
    });

    it("exchanges no code", () => {
      expect(seam.endpoint.calls).toEqual([]);
    });

    it("reads no app user", () => {
      expect(seam.tokens).toEqual([]);
    });

    it("stores no install", async () => {
      expect(await readLinearInstall(db)).toBeNull();
    });
  });

  describe("a callback whose code the token endpoint refuses", () => {
    let seam: Seams;
    let result: LinearInstallResult;
    beforeEach(async () => {
      seam = seams(Response.json({ error: "invalid_grant" }, { status: 400 }));
      const state = await freshState();
      result = await completeLinearInstall(
        oauth,
        db,
        { code: "bad", state, ...callback },
        seam.options,
      );
    });

    it("reports the refusal as an error", () => {
      expect(result).toEqual({
        installed: false,
        error: "Error: linear oauth authorization_code: invalid_grant",
      });
    });

    it("reads no app user", () => {
      expect(seam.tokens).toEqual([]);
    });
  });

  describe("a callback from a second workspace", () => {
    let result: LinearInstallResult;
    beforeEach(async () => {
      await saveLinearInstall(
        db,
        installRow({ organization_id: "org-first", organization_name: "First" }),
      );
      const state = await freshState();
      result = await completeLinearInstall(
        oauth,
        db,
        { code: "c1", state, ...callback },
        seams().options,
      );
    });

    it("refuses it and names the workspace already installed", () => {
      expect(result).toEqual({
        installed: false,
        error: "already installed in workspace First. One deployment serves one workspace.",
      });
    });

    it("keeps the first install", async () => {
      expect(await readLinearInstall(db)).toMatchObject({ organization_id: "org-first" });
    });
  });

  describe("a callback from the workspace already installed", () => {
    let result: LinearInstallResult;
    beforeEach(async () => {
      await saveLinearInstall(db, installRow({ access_token: "lin_oauth_stale" }));
      const state = await freshState();
      result = await completeLinearInstall(
        oauth,
        db,
        { code: "c1", state, ...callback },
        seams().options,
      );
    });

    it("installs again", () => {
      expect(result.installed).toBe(true);
    });

    it("replaces the stale token", async () => {
      expect(await readLinearInstall(db)).toMatchObject({ access_token: "lin_oauth_a" });
    });
  });
});
