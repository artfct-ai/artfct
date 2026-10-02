import { describe, expect, it } from "bun:test";
import {
  consumeGithubCallbackState,
  parseGithubAppConversion,
  parseGithubInstallRedirect,
} from "./callback";

const PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumFhu\n-----END RSA PRIVATE KEY-----\n";

const CONVERSION = {
  id: 1234567,
  slug: "artfct-acme",
  node_id: "A_kwDOAAxyzw",
  owner: { login: "acme", id: 1, type: "Organization" },
  name: "artfct-acme",
  html_url: "https://github.com/apps/artfct-acme",
  client_id: "Iv23liAbCdEf",
  client_secret: "client-secret-value",
  webhook_secret: "webhook-secret-value",
  pem: PRIVATE_KEY,
};

describe("parseGithubAppConversion", () => {
  it("reads the app id, slug, private key, and webhook secret", () => {
    expect(parseGithubAppConversion(CONVERSION)).toEqual({
      appId: "1234567",
      slug: "artfct-acme",
      privateKey: PRIVATE_KEY,
      webhookSecret: "webhook-secret-value",
    });
  });

  it("rejects an answer without a webhook secret", () => {
    expect(() => parseGithubAppConversion({ ...CONVERSION, webhook_secret: null })).toThrow();
  });
});

describe("parseGithubInstallRedirect", () => {
  it("reads the installation id", () => {
    const url = new URL(
      "http://127.0.0.1:4000/installed?installation_id=987654&setup_action=install&state=abc",
    );
    expect(parseGithubInstallRedirect(url)).toEqual({
      outcome: "installed",
      installationId: "987654",
    });
  });

  it("fails when an install request waits for an organization owner", () => {
    const url = new URL("http://127.0.0.1:4000/installed?setup_action=request&state=abc");
    expect(parseGithubInstallRedirect(url).outcome).toBe("failed");
  });

  it("fails on an installation id that is not a number", () => {
    const url = new URL("http://127.0.0.1:4000/installed?installation_id=abc&setup_action=install");
    expect(parseGithubInstallRedirect(url).outcome).toBe("failed");
  });
});

describe("consumeGithubCallbackState", () => {
  it("accepts the state a callback path awaits", () => {
    const awaitedStates = new Map([["/created", "created-state"]]);
    expect(consumeGithubCallbackState(awaitedStates, "/created", "created-state")).toBe(true);
  });

  it("refuses a replayed /created state", () => {
    const awaitedStates = new Map([["/created", "created-state"]]);
    consumeGithubCallbackState(awaitedStates, "/created", "created-state");
    expect(consumeGithubCallbackState(awaitedStates, "/created", "created-state")).toBe(false);
  });

  it("refuses a replayed /installed state", () => {
    const awaitedStates = new Map([["/installed", "install-state"]]);
    consumeGithubCallbackState(awaitedStates, "/installed", "install-state");
    expect(consumeGithubCallbackState(awaitedStates, "/installed", "install-state")).toBe(false);
  });

  it("refuses the /created state on /installed", () => {
    const awaitedStates = new Map([
      ["/created", "created-state"],
      ["/installed", "install-state"],
    ]);
    expect(consumeGithubCallbackState(awaitedStates, "/installed", "created-state")).toBe(false);
  });

  it("keeps the awaited state when another state is refused", () => {
    const awaitedStates = new Map([["/installed", "install-state"]]);
    consumeGithubCallbackState(awaitedStates, "/installed", "created-state");
    expect(consumeGithubCallbackState(awaitedStates, "/installed", "install-state")).toBe(true);
  });

  it("refuses a request without a state on a path that awaits none", () => {
    const awaitedStates = new Map([["/created", "created-state"]]);
    expect(consumeGithubCallbackState(awaitedStates, "/installed", null)).toBe(false);
  });
});
