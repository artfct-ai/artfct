import { beforeEach, describe, expect, it } from "bun:test";
import { fetchBody, fetchUrl } from "../../../test/fetch";
import {
  linearAuthorizeUrl,
  linearExchangeCode,
  linearTokenExpiryIso,
  linearRefreshTokens,
} from "./oauth";
import type { LinearTokens } from "./oauth";

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const APP = { clientId: "cid", clientSecret: "sec" };

function tokenEndpoint(answer: Record<string, unknown> | Response) {
  const forms: Record<string, string>[] = [];
  const urls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(fetchUrl(input));
    forms.push(Object.fromEntries(new URLSearchParams(fetchBody(init))));
    return answer instanceof Response ? answer : Response.json(answer);
  };
  return { app: APP, fetch: fetchImpl, forms, urls };
}

type TokenEndpoint = ReturnType<typeof tokenEndpoint>;

describe("linearAuthorizeUrl", () => {
  const url = new URL(
    linearAuthorizeUrl({ clientId: "cid", redirectUri: "https://in/cb", state: "st" }),
  );

  it("points at the Linear authorize page", () => {
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
  });

  it("asks for an app actor with the agent scopes", () => {
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "https://in/cb",
      response_type: "code",
      scope: "read,write,app:assignable,app:mentionable",
      actor: "app",
      prompt: "consent",
      state: "st",
    });
  });
});

describe("token requests", () => {
  describe("an authorization code exchange", () => {
    let endpoint: TokenEndpoint;
    let tokens: LinearTokens;

    beforeEach(async () => {
      endpoint = tokenEndpoint({ access_token: "lin_oauth_a", expires_in: 86399 });
      tokens = await linearExchangeCode(
        endpoint.app,
        { code: "c1", redirectUri: "https://in/cb" },
        { fetch: endpoint.fetch },
      );
    });

    it("returns the access token", () => {
      expect(tokens.access_token).toBe("lin_oauth_a");
    });

    it("posts to the Linear token endpoint", () => {
      expect(endpoint.urls).toEqual(["https://api.linear.app/oauth/token"]);
    });

    it("sends the grant as a form with the client credentials", () => {
      expect(endpoint.forms[0]).toEqual({
        grant_type: "authorization_code",
        code: "c1",
        redirect_uri: "https://in/cb",
        client_id: "cid",
        client_secret: "sec",
      });
    });
  });

  describe("a refresh against a custom base URL", () => {
    let endpoint: TokenEndpoint;
    let tokens: LinearTokens;

    beforeEach(async () => {
      endpoint = tokenEndpoint({ access_token: "lin_oauth_b", refresh_token: "r2" });
      tokens = await linearRefreshTokens(APP, "r1", {
        fetch: endpoint.fetch,
        baseUrl: "https://linear.test",
      });
    });

    it("returns the new refresh token", () => {
      expect(tokens.refresh_token).toBe("r2");
    });

    it("posts to the given base URL", () => {
      expect(endpoint.urls).toEqual(["https://linear.test/oauth/token"]);
    });

    it("sends the refresh token grant", () => {
      expect(endpoint.forms[0]).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "r1",
      });
    });
  });

  describe("a grant Linear refuses", () => {
    const refused = Response.json(
      { error: "invalid_grant", error_description: "code used" },
      { status: 400 },
    );

    it("throws with Linear's description", async () => {
      await expect(
        linearExchangeCode(
          APP,
          { code: "c", redirectUri: "u" },
          { fetch: tokenEndpoint(refused).fetch },
        ),
      ).rejects.toThrow("linear oauth authorization_code: code used");
    });
  });

  describe("a failure that carries no JSON", () => {
    const down = new Response("<html>bad gateway</html>", { status: 502 });

    it("throws with the status and the body", async () => {
      await expect(
        linearRefreshTokens(APP, "r1", { fetch: tokenEndpoint(down).fetch }),
      ).rejects.toThrow("linear oauth refresh_token: HTTP 502 <html>bad gateway</html>");
    });
  });
});

describe("linearTokenExpiryIso", () => {
  it("computes the expiry from expires_in", () => {
    expect(linearTokenExpiryIso({ access_token: "a", expires_in: 60 }, NOW)).toBe(
      "2026-09-03T10:01:00.000Z",
    );
  });

  it("assumes a day when the tokens carry no lifetime", () => {
    expect(linearTokenExpiryIso({ access_token: "a" }, NOW)).toBe("2026-09-04T10:00:00.000Z");
  });
});
