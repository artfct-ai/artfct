import { ARTIFACT_KINDS } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { testEnv } from "../test/test-env";
import { artifact, artifactCapability, cliEnv, cloneUrl, codeHost, mcpServer } from "./clients";
import { Adapters } from "./config/adapters";

const env = testEnv();
const adapters = Adapters.parse({});

describe("codeHost", () => {
  it("is null without GitHub credentials", () => {
    expect(codeHost(env, "github")).toBeNull();
  });

  it("exists with the credentials of an App installation", () => {
    const installed = {
      ...env,
      GITHUB_APP_ID: "1234",
      GITHUB_PRIVATE_KEY: "key",
      GITHUB_INSTALLATION_ID: "77",
    };
    expect(codeHost(installed, "github")).not.toBeNull();
  });
});

describe("cloneUrl", () => {
  it("clones over https from the configured code host", () => {
    expect(cloneUrl(adapters, "acme/app")).toBe("https://github.com/acme/app.git");
  });
});

describe("artifactCapability", () => {
  it("serves a pull request from the code host", () => {
    expect(artifactCapability("pull")).toBe("code");
  });

  it("serves a page from the document host", () => {
    expect(artifactCapability("page")).toBe("docs");
  });

  it("serves issues from the tracker", () => {
    expect(artifactCapability("issues")).toBe("tracker");
  });
});

describe("the instructions of a kind", () => {
  const clients = {
    adapters,
    code: () => null,
    docs: async () => null,
    repo: () => null,
    log: () => {},
  };

  it("names every action on every kind, so any role runs on any kind", () => {
    for (const kind of ARTIFACT_KINDS) {
      const { create, read, change, report } = artifact(kind, clients).instructions;
      expect([create, read, change, report].every((text) => text.trim() !== "")).toBe(true);
    }
  });

  it("changes a pull request on its branch", () => {
    expect(artifact("pull", clients).instructions.change).toContain(
      "Change the files on your branch and push to that branch.",
    );
  });

  it("carries no heading, because the prompt of each role adds its own", () => {
    for (const kind of ARTIFACT_KINDS) {
      const { create, read, change } = artifact(kind, clients).instructions;
      expect([create, read, change].join("\n")).not.toContain("## ");
    }
  });
});

describe("mcpServer", () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  describe("the tracker capability with a credential", () => {
    it("is the Linear server on that credential", () => {
      const server = mcpServer({
        capability: "tracker",
        adapters,
        credential: "lin_oauth_a",
        log,
      });
      expect(server).toEqual({
        name: "linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_oauth_a" },
      });
    });
  });

  describe("the docs capability on Linear without a credential", () => {
    it("is null and names what is missing", () => {
      const server = mcpServer({ capability: "docs", adapters, credential: null, log });
      expect(server).toBeNull();
      expect(lines.at(-1)).toBe("mcp linear skipped: the Linear app is not installed");
    });
  });

  describe("the docs capability on Notion", () => {
    it("is null, because the Notion CLI reaches the page", () => {
      const notion = Adapters.parse({ documents: { provider: "notion" } });
      const credential = "ntn_secret";
      expect(mcpServer({ capability: "docs", adapters: notion, credential, log })).toBeNull();
    });
  });

  describe("the code capability with a task token", () => {
    it("is the GitHub server on that token", () => {
      const server = mcpServer({ capability: "code", adapters, credential: "ghs_task", log });
      expect(server?.headers).toEqual({ Authorization: "Bearer ghs_task" });
    });
  });

  describe("the code capability without a task token", () => {
    it("is null", () => {
      expect(mcpServer({ capability: "code", adapters, credential: null, log })).toBeNull();
    });
  });
});

describe("cliEnv", () => {
  const notion = Adapters.parse({ documents: { provider: "notion" } });
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  describe("the docs capability on Notion with a token", () => {
    it("gives the Notion CLI the token and keeps it off the keychain", () => {
      const given = cliEnv({
        capability: "docs",
        adapters: notion,
        credential: "ntn_secret",
        log,
      });
      expect(given).toEqual({ NOTION_API_TOKEN: "ntn_secret", NOTION_KEYRING: "0" });
    });
  });

  describe("the docs capability on Notion without a token", () => {
    it("is empty and names the missing variable", () => {
      expect(cliEnv({ capability: "docs", adapters: notion, credential: null, log })).toEqual({});
      expect(lines.at(-1)).toBe("notion cli skipped: NOTION_TOKEN is unset");
    });
  });

  describe("a capability whose host has no CLI credential", () => {
    it("is empty for the docs capability on Linear", () => {
      expect(cliEnv({ capability: "docs", adapters, credential: "lin_oauth_a", log })).toEqual({});
    });

    it("is empty for the code capability, whose token goes to a file", () => {
      expect(cliEnv({ capability: "code", adapters, credential: "ghs_task", log })).toEqual({});
    });
  });
});
