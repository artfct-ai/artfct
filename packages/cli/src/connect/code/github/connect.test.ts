import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGithubBrowser, readGithubManifestForm } from "../../../../test/github-browser";
import { TEMPLATE_DIR } from "../../../../test/template";
import { readDevVar } from "../../dev-vars";
import { connectGithubApp } from "./connect";

const PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumFhu\n-----END RSA PRIVATE KEY-----\n";

const CONVERSION = {
  id: 1234567,
  slug: "artfct-acme",
  node_id: "A_kwDOAAxyzw",
  owner: { login: "acme", id: 1, type: "Organization" },
  name: "artfct-acme",
  description: "The artfct orchestrator's agent.",
  external_url: "https://ingress.acme.dev",
  html_url: "https://github.com/apps/artfct-acme",
  created_at: "2026-09-30T12:00:00Z",
  updated_at: "2026-09-30T12:00:00Z",
  permissions: { contents: "write", metadata: "read" },
  events: ["push"],
  client_id: "Iv23liAbCdEf",
  client_secret: "client-secret-value",
  webhook_secret: "webhook-secret-value",
  pem: PRIVATE_KEY,
};

const repoDirs: string[] = [];

function deploymentRepo(publicUrl: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), "artfct-connect-"));
  repoDirs.push(repoDir);
  cpSync(join(TEMPLATE_DIR, "ingress"), join(repoDir, "ingress"), { recursive: true });
  cpSync(join(TEMPLATE_DIR, "orchestrator"), join(repoDir, "orchestrator"), { recursive: true });
  writeFileSync(join(repoDir, "orchestrator/.dev.vars"), `PUBLIC_URL=${publicUrl}\n`, {
    mode: 0o644,
  });
  return repoDir;
}

function readRepoFile(repoDir: string, path: string): string {
  return readFileSync(join(repoDir, path), "utf8");
}

function fileMode(repoDir: string, path: string): number {
  return statSync(join(repoDir, path)).mode & 0o777;
}

function statusUnderHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request(url, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

afterEach(() => {
  for (const repoDir of repoDirs.splice(0)) rmSync(repoDir, { recursive: true, force: true });
});

describe("connectGithubApp", () => {
  it("creates the app from a manifest and writes its credentials and login", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    const codes: string[] = [];
    const lines: string[] = [];
    await connectGithubApp({
      repoDir,
      org: "acme",
      openBrowser: browser.openBrowser,
      exchangeManifestCode: async (code) => {
        codes.push(code);
        return CONVERSION;
      },
      log: (line) => lines.push(line),
    });
    const visit = await browser.visit;

    expect(visit.formAction).toStartWith(
      "https://github.com/organizations/acme/settings/apps/new?state=",
    );
    expect(visit.manifest.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
      actions: "read",
      metadata: "read",
    });
    expect(visit.manifest.default_events.toSorted()).toEqual([
      "check_run",
      "check_suite",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "push",
    ]);
    expect(visit.manifest.hook_attributes.url).toBe("https://ingress.acme.dev/webhooks/github");
    expect(visit.installLocation).toStartWith(
      "https://github.com/apps/artfct-acme/installations/new?state=",
    );
    expect(visit.installedStatus).toBe(200);
    expect(codes).toEqual(["manifest-code"]);

    const orchestratorVars = readRepoFile(repoDir, "orchestrator/.dev.vars");
    expect(readDevVar(orchestratorVars, "PUBLIC_URL")).toBe("https://ingress.acme.dev");
    expect(readDevVar(orchestratorVars, "GITHUB_APP_ID")).toBe("1234567");
    expect(readDevVar(orchestratorVars, "GITHUB_INSTALLATION_ID")).toBe("987654");
    expect(orchestratorVars).toContain(`GITHUB_PRIVATE_KEY="${PRIVATE_KEY.trim()}"\n`);
    const ingressVars = readRepoFile(repoDir, "ingress/.dev.vars");
    expect(readDevVar(ingressVars, "GITHUB_WEBHOOK_SECRET")).toBe("webhook-secret-value");
    expect(ingressVars).toContain("ADMIN_TOKEN=\n");
    expect(fileMode(repoDir, "orchestrator/.dev.vars")).toBe(0o600);
    expect(fileMode(repoDir, "ingress/.dev.vars")).toBe(0o600);

    const ingressConfig = readRepoFile(repoDir, "ingress/wrangler.jsonc");
    expect(ingressConfig).toContain('"vars": { "GITHUB_APP_LOGIN": "artfct-acme" }');
    expect(ingressConfig).toContain("// The slug of your GitHub App.");

    const printed = lines.join("\n");
    for (const secret of [
      PRIVATE_KEY.split("\n")[1] ?? "",
      "webhook-secret-value",
      "client-secret-value",
    ]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("keeps the app credentials and fails when the install brings back no installation id", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("setup_action=request");
    const connected = connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: browser.openBrowser,
      exchangeManifestCode: async () => CONVERSION,
      log: () => {},
    });

    await expect(connected).rejects.toThrow("GitHub returned no installation id.");
    const visit = await browser.visit;
    expect(visit.formAction).toStartWith("https://github.com/settings/apps/new?state=");
    expect(visit.installedStatus).toBe(500);
    const orchestratorVars = readRepoFile(repoDir, "orchestrator/.dev.vars");
    expect(readDevVar(orchestratorVars, "GITHUB_APP_ID")).toBe("1234567");
    expect(readDevVar(orchestratorVars, "GITHUB_INSTALLATION_ID")).toBeUndefined();
  });

  it("refuses a request addressed to another host", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    const reboundStatus = Promise.withResolvers<number>();
    await connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: async (url) => {
        reboundStatus.resolve(await statusUnderHost(url, "attacker.test"));
        await browser.openBrowser(url);
      },
      exchangeManifestCode: async () => CONVERSION,
      log: () => {},
    });

    expect(await reboundStatus.promise).toBe(400);
  });

  it("refuses a replayed /created", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    const opened = Promise.withResolvers<string>();
    const replayedStatuses: number[] = [];
    let exchanges = 0;
    await connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: async (url) => {
        opened.resolve(url);
        await browser.openBrowser(url);
      },
      exchangeManifestCode: async () => {
        exchanges += 1;
        if (exchanges === 1) {
          const form = await readGithubManifestForm(await opened.promise);
          const replayed = await fetch(
            `${form.manifest.redirect_url}?code=manifest-code&state=${form.state}`,
            { redirect: "manual" },
          );
          replayedStatuses.push(replayed.status);
        }
        return CONVERSION;
      },
      log: () => {},
    });

    expect(replayedStatuses).toEqual([400]);
  });

  it("refuses the /created state on /installed", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    const crossedStatus = Promise.withResolvers<number>();
    await connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: async (url) => {
        const form = await readGithubManifestForm(url);
        const crossed = await fetch(
          `${form.manifest.setup_url}?installation_id=111111&state=${form.state}`,
        );
        crossedStatus.resolve(crossed.status);
        await browser.openBrowser(url);
      },
      exchangeManifestCode: async () => CONVERSION,
      log: () => {},
    });

    expect(await crossedStatus.promise).toBe(400);
  });

  it("sends the install redirect with a state of its own", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    await connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: browser.openBrowser,
      exchangeManifestCode: async () => CONVERSION,
      log: () => {},
    });
    const visit = await browser.visit;

    expect(new URL(visit.installLocation ?? "").searchParams.get("state")).not.toBe(
      new URL(visit.formAction).searchParams.get("state"),
    );
  });

  it("completes the setup when each callback brings its own state", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    await connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: browser.openBrowser,
      exchangeManifestCode: async () => CONVERSION,
      log: () => {},
    });

    expect((await browser.visit).installedStatus).toBe(200);
  });

  it("tells the person to run the command again when /created fails", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    const connected = connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: browser.openBrowser,
      exchangeManifestCode: async () => {
        throw new Error("GitHub rejected the manifest code with 404.");
      },
      log: () => {},
    });

    await expect(connected).rejects.toThrow("Run `artfct connect code` again.");
  });

  it("writes nothing when GitHub rejects the manifest code", async () => {
    const repoDir = deploymentRepo("https://ingress.acme.dev");
    const browser = fakeGithubBrowser("installation_id=987654&setup_action=install");
    const connected = connectGithubApp({
      repoDir,
      org: undefined,
      openBrowser: browser.openBrowser,
      exchangeManifestCode: async () => {
        throw new Error("GitHub rejected the manifest code with 404.");
      },
      log: () => {},
    });

    await expect(connected).rejects.toThrow("GitHub rejected the manifest code with 404.");
    expect((await browser.visit).createdStatus).toBe(500);
    expect(readRepoFile(repoDir, "orchestrator/.dev.vars")).toBe(
      "PUBLIC_URL=https://ingress.acme.dev\n",
    );
    expect(existsSync(join(repoDir, "ingress/.dev.vars"))).toBe(false);
    expect(readRepoFile(repoDir, "ingress/wrangler.jsonc")).toBe(
      readFileSync(join(TEMPLATE_DIR, "ingress/wrangler.jsonc"), "utf8"),
    );
  });

  it("stops before the browser when PUBLIC_URL is unset", async () => {
    const repoDir = deploymentRepo("");
    const opened: string[] = [];
    await expect(
      connectGithubApp({
        repoDir,
        org: undefined,
        openBrowser: async (url) => {
          opened.push(url);
        },
        exchangeManifestCode: async () => CONVERSION,
        log: () => {},
      }),
    ).rejects.toThrow("Set PUBLIC_URL");
    expect(opened).toEqual([]);
  });
});
