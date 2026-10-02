import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { WebPage } from "@artfct-ai/adapters/web/types";
import { env } from "cloudflare:workers";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRow } from "../test/linear-install";
import { stubValidatingFetch } from "../test/validating-fetch";
import { CloudflareGateway } from "@artfct-ai/adapters/gateway/cloudflare/gateway";
import { OpenRouterGateway } from "@artfct-ai/adapters/gateway/openrouter/gateway";
import {
  artifact,
  chat,
  codeHost,
  documents,
  gateway,
  mcpCredential,
  tracker,
  trackerForToken,
  web,
} from "./clients";
import type { ArtifactClients } from "./clients";
import { Providers } from "./config/providers";
import { createDb } from "./db/client";
import { saveLinearInstall } from "./db/linear-installs";
import { linearInstalls } from "./db/schema";
import type { Env } from "./env";

const db = createDb(env.DB);
const providers = Providers.parse({});
const oauth: Env = { ...env, LINEAR_CLIENT_ID: "cid", LINEAR_CLIENT_SECRET: "sec" };
const metadata = { workflow_id: "wf_1" };

describe("tracker", () => {
  beforeEach(async () => {
    await db.delete(linearInstalls);
  });

  describe("with the OAuth app set but nothing installed", () => {
    it("is null", async () => {
      expect(await tracker(oauth)).toBeNull();
    });
  });

  describe("with the app installed", () => {
    const row = installRow({ expires_at: "2099-01-01T00:00:00.000Z" });
    let installed: Tracker | null;
    beforeEach(async () => {
      await saveLinearInstall(db, row);
      installed = await tracker({ ...oauth, LINEAR_API_URL: "https://linear.test" });
    });

    it("builds a tracker on the install", () => {
      expect(installed).not.toBeNull();
    });

    it("acts as the install's app user", () => {
      expect(installed?.appUserId).toBe(row.app_user_id);
    });
  });
});

describe("codeHost", () => {
  describe("without credentials", () => {
    it("is null", () => {
      const bare: Env = {
        ...env,
        GITHUB_APP_ID: "",
        GITHUB_PRIVATE_KEY: "",
        GITHUB_INSTALLATION_ID: "",
      };
      expect(codeHost(bare, "github")).toBeNull();
    });
  });
});

describe("gateway", () => {
  const GLOBAL = { openrouter: {} };
  const IN_EU = { openrouter: { region: "eu" as const } };
  const bare: Env = {
    ...env,
    CF_ACCOUNT_ID: "",
    AI_GATEWAY_ID: "",
    AI_GATEWAY_TOKEN: "",
    OPEN_ROUTER_API_KEY: "",
  };

  describe("without credentials", () => {
    it("has no Cloudflare gateway", () => {
      expect(gateway(bare, "cloudflare", GLOBAL)).toBeNull();
    });

    it("has no OpenRouter gateway", () => {
      expect(gateway(bare, "openrouter", GLOBAL)).toBeNull();
    });
  });

  describe("with an OpenRouter key", () => {
    const routed: Env = { ...env, OPEN_ROUTER_API_KEY: "sk-or" };

    it("builds the OpenRouter gateway", () => {
      expect(gateway(routed, "openrouter", GLOBAL)).toBeInstanceOf(OpenRouterGateway);
    });

    it("routes a prefixed model to its bare name", () => {
      expect(
        gateway(routed, "openrouter", GLOBAL)?.compatRoute("openrouter/m", metadata).model,
      ).toBe("m");
    });

    it("routes to the global host without a region", () => {
      expect(
        gateway(routed, "openrouter", GLOBAL)?.compatRoute("openrouter/m", metadata).baseUrl,
      ).toBe("https://openrouter.ai/api/v1");
    });

    it("routes to the host of the configured region", () => {
      expect(
        gateway(routed, "openrouter", IN_EU)?.compatRoute("openrouter/m", metadata).baseUrl,
      ).toBe("https://eu.openrouter.ai/api/v1");
    });
  });

  describe("with the Cloudflare gateway and an OpenRouter key", () => {
    const full: Env = {
      ...env,
      OPEN_ROUTER_API_KEY: "sk-or",
      CF_ACCOUNT_ID: "a",
      AI_GATEWAY_ID: "g",
      AI_GATEWAY_TOKEN: "t",
    };

    it("builds the Cloudflare gateway", () => {
      expect(gateway(full, "cloudflare", GLOBAL)).toBeInstanceOf(CloudflareGateway);
    });

    it("routes with the key of the named provider", () => {
      expect(
        gateway(full, "cloudflare", GLOBAL)?.compatRoute("openrouter/m", metadata).apiKey,
      ).toBe("sk-or");
    });

    it("refuses an OpenRouter model while a region is configured", () => {
      expect(() =>
        gateway(full, "cloudflare", IN_EU)?.compatRoute("openrouter/m", metadata),
      ).toThrow(/outside the eu region/);
    });
  });
});

describe("SDK adapters under workerd's fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("a Slack chat", () => {
    let requests: Request[];
    let reply: { ts: string } | undefined;
    beforeEach(async () => {
      requests = stubValidatingFetch(() => Response.json({ ok: true, ts: "1.2" }));
      const slack = chat({ ...env, SLACK_BOT_TOKEN: "xoxb-test" }, "slack");
      reply = await slack?.postThreadReply("C1", "1.0", "hello");
    });

    it("reads the reply", () => {
      expect(reply).toEqual({ ts: "1.2" });
    });

    it("posts one request workerd accepts", () => {
      expect(requests.map((request) => request.url)).toEqual([
        "https://slack.com/api/chat.postMessage",
      ]);
    });
  });

  describe("a GitHub code host", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const installed: Env = {
      ...env,
      GITHUB_APP_ID: "1234",
      GITHUB_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_INSTALLATION_ID: "77",
    };
    const mintUrl = "https://api.github.com/app/installations/77/access_tokens";
    let requests: Request[];
    let comment: { id: number } | undefined;
    beforeEach(async () => {
      requests = stubValidatingFetch((request) =>
        request.url === mintUrl
          ? Response.json({ token: "ghs_1", expires_at: "2099-01-01T00:00:00Z" }, { status: 201 })
          : Response.json({ id: 7 }, { status: 201 }),
      );
      comment = await codeHost(installed, "github")?.commentOnPull("o/r", 1, "hello");
    });

    it("reads the reply", () => {
      expect(comment).toEqual({ id: 7 });
    });

    it("mints a token and posts, in requests workerd accepts", () => {
      expect(requests.map((request) => request.url)).toEqual([
        mintUrl,
        "https://api.github.com/repos/o/r/issues/1/comments",
      ]);
    });
  });

  describe("Notion documents", () => {
    const person = { object: "user", id: "u1", type: "person", person: { email: "ada@test" } };
    let requests: Request[];
    let email: string | null | undefined;
    beforeEach(async () => {
      requests = stubValidatingFetch(() => Response.json(person));
      const docs = await documents({ ...env, NOTION_TOKEN: "secret_test" }, "notion");
      email = await docs?.userEmail("u1");
    });

    it("reads the reply", () => {
      expect(email).toBe("ada@test");
    });

    it("posts one request workerd accepts", () => {
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.notion.com/v1/users/u1",
      ]);
    });
  });

  describe("a Linear tracker", () => {
    const comment = { commentCreate: { success: true, lastSyncId: 1, comment: { id: "cm1" } } };
    let requests: Request[];
    let created: { id: string } | undefined;
    beforeEach(async () => {
      requests = stubValidatingFetch(() => Response.json({ data: comment }));
      created = await trackerForToken(env, "lin_api_test").commentOnIssue("i1", "hello");
    });

    it("reads the reply", () => {
      expect(created).toEqual({ id: "cm1" });
    });

    it("posts one request workerd accepts", () => {
      expect(requests.map((request) => request.url)).toEqual(["https://api.linear.app/graphql"]);
    });
  });

  describe("a web page read", () => {
    let requests: Request[];
    let page: WebPage | undefined;
    beforeEach(async () => {
      requests = stubValidatingFetch(
        () => new Response("# Node", { headers: { "content-type": "text/markdown" } }),
      );
      page = await web().readPage("https://nodejs.org/en/about/previous-releases");
    });

    it("reads the page", () => {
      expect(page).toEqual({ contentType: "text/markdown", body: "# Node", truncated: false });
    });

    it("sends one request workerd accepts, asking for markdown first", () => {
      expect(
        requests.map((request) => [request.url, request.headers.get("accept")?.split(",")[0]]),
      ).toEqual([["https://nodejs.org/en/about/previous-releases", "text/markdown"]]);
    });
  });
});

function artifactClients(kinds: Providers): ArtifactClients {
  return {
    providers: kinds,
    code: () => null,
    docs: async () => null,
    repo: () => null,
    log: () => {},
  };
}

describe("artifact", () => {
  describe("a pull request link with a trailing path", () => {
    it("detects the canonical url", async () => {
      const text = "Opened https://github.com/acme/app/pull/3/files";
      const target = await artifact("pull", artifactClients(providers)).detect(text);
      expect(target).toEqual({
        url: "https://github.com/acme/app/pull/3",
        ref: { kind: "pull", repo: "acme/app", number: 3 },
      });
    });
  });

  describe("a link of another host", () => {
    const text = "Done: https://example.com/x";

    it("is no pull request", async () => {
      const kind = artifact("pull", artifactClients(providers));
      expect(await kind.detect(text)).toBeNull();
    });

    it("is no issue list", async () => {
      const kind = artifact("issues", artifactClients(providers));
      expect(await kind.detect(text)).toBeNull();
    });
  });

  describe("a tracker issue link", () => {
    it("is an issue list", async () => {
      const kind = artifact("issues", artifactClients(providers));
      const text = "Filed https://linear.app/acme/issue/ENG-1/title";
      expect(await kind.detect(text)).toEqual({
        url: "https://linear.app/acme/issue/ENG-1/title",
        ref: { kind: "issues" },
      });
    });
  });

  describe("a page on the configured docs provider", () => {
    it("asks the document host when it is Linear", async () => {
      const kind = artifact("page", artifactClients(providers));
      const text = "Wrote https://linear.app/acme/document/design-abc";
      expect(await kind.detect(text)).toBeNull();
    });

    it("reads a Notion url without a credential", async () => {
      const kind = artifact("page", artifactClients(Providers.parse({ docs: "notion" })));
      const url = "https://www.notion.so/acme/Design-0123456789abcdef0123456789abcdef";
      expect(await kind.detect(`Wrote ${url}`)).toEqual({
        url,
        ref: { kind: "page", page_id: "0123456789abcdef0123456789abcdef" },
      });
    });
  });
});

describe("mcpCredential", () => {
  const installed = installRow({ expires_at: "2099-01-01T00:00:00.000Z" });

  beforeEach(async () => {
    await db.delete(linearInstalls);
  });

  describe("with the app installed", () => {
    beforeEach(async () => {
      await saveLinearInstall(db, installed);
    });

    it("gives the tracker capability the app's access token", async () => {
      const capability = "tracker" as const;
      expect(await mcpCredential({ env: oauth, capability, providers })).toBe(
        installed.access_token,
      );
    });

    it("gives the docs capability on Linear the same token", async () => {
      const capability = "docs" as const;
      expect(await mcpCredential({ env: oauth, capability, providers })).toBe(
        installed.access_token,
      );
    });
  });

  describe("with no install", () => {
    it("is null", async () => {
      const capability = "tracker" as const;
      expect(await mcpCredential({ env: oauth, capability, providers })).toBeNull();
    });
  });

  describe("the docs capability on Notion", () => {
    it("is the Notion token", async () => {
      const notion = Providers.parse({ docs: "notion" });
      const withToken: Env = { ...env, NOTION_TOKEN: "secret_t" };
      expect(await mcpCredential({ env: withToken, capability: "docs", providers: notion })).toBe(
        "secret_t",
      );
    });
  });

  describe("the code capability", () => {
    it("holds none, because every task mints its own", async () => {
      expect(await mcpCredential({ env, capability: "code", providers })).toBeNull();
    });
  });
});
