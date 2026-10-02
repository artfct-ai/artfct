import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { describeError } from "../../../describe-error";
import { readDevVar, writeDevVarsFile } from "../../dev-vars";
import {
  consumeGithubCallbackState,
  parseGithubAppConversion,
  parseGithubInstallRedirect,
} from "./callback";
import { writeIngressAppLogin } from "./ingress-config";
import { githubAppManifest } from "./manifest";

/** Everything `artfct connect code` reaches outside the process. */
export type ConnectGithubEnvironment = {
  repoDir: string;
  org: string | undefined;
  openBrowser: (url: string) => Promise<void>;
  exchangeManifestCode: (code: string) => Promise<unknown>;
  log: (line: string) => void;
};

type DeploymentPaths = {
  orchestratorDevVars: string;
  ingressDevVars: string;
  ingressConfig: string;
};

function deploymentPaths(repoDir: string): DeploymentPaths {
  return {
    orchestratorDevVars: join(repoDir, "orchestrator/.dev.vars"),
    ingressDevVars: join(repoDir, "ingress/.dev.vars"),
    ingressConfig: join(repoDir, "ingress/wrangler.jsonc"),
  };
}

function readIngressUrl(orchestratorDevVars: string): string {
  const text = existsSync(orchestratorDevVars) ? readFileSync(orchestratorDevVars, "utf8") : "";
  const publicUrl = readDevVar(text, "PUBLIC_URL");
  if (publicUrl === undefined || !URL.canParse(publicUrl)) {
    throw new Error(
      `Set PUBLIC_URL in ${orchestratorDevVars} to the ingress origin, such as https://artfct-ingress.example.workers.dev.`,
    );
  }
  return publicUrl;
}

function githubNewAppUrl(org: string | undefined, state: string): string {
  const path = org
    ? `/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "/settings/apps/new";
  return `https://github.com${path}?state=${state}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function manifestFormPage(action: string, manifest: object): string {
  return `<!doctype html>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Create the GitHub App</button>
</form>
<script>document.forms[0].submit()</script>
`;
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
  response.end(body);
}

function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * Create a GitHub App from a manifest in the browser, install it, and write its credentials into
 * the deployment repo's `.dev.vars` files and its login into the ingress config.
 */
export async function connectGithubApp(environment: ConnectGithubEnvironment): Promise<void> {
  const paths = deploymentPaths(environment.repoDir);
  const ingressUrl = readIngressUrl(paths.orchestratorDevVars);
  if (!existsSync(paths.ingressConfig)) {
    throw new Error(`${paths.ingressConfig} is missing. Run the command in a deployment repo.`);
  }

  const createdState = randomUUID();
  const awaitedStates = new Map([["/created", createdState]]);
  const setupFinished = Promise.withResolvers<void>();
  const server = createServer();
  const origin = await listenOnLoopback(server);
  const manifest = githubAppManifest(`artfct-${basename(environment.repoDir)}`, {
    ingressUrl,
    redirectUrl: `${origin}/created`,
    setupUrl: `${origin}/installed`,
  });

  async function storeCreatedApp(url: URL): Promise<string> {
    try {
      const credentials = parseGithubAppConversion(
        await environment.exchangeManifestCode(url.searchParams.get("code") ?? ""),
      );
      writeDevVarsFile(paths.orchestratorDevVars, {
        GITHUB_APP_ID: credentials.appId,
        GITHUB_PRIVATE_KEY: credentials.privateKey,
      });
      writeDevVarsFile(paths.ingressDevVars, { GITHUB_WEBHOOK_SECRET: credentials.webhookSecret });
      writeIngressAppLogin(paths.ingressConfig, credentials.slug);
      return credentials.slug;
    } catch (error) {
      throw new Error(
        "artfct could not store the GitHub App's credentials. Run `artfct connect code` again.",
        { cause: error },
      );
    }
  }

  async function handleCreated(url: URL, response: ServerResponse): Promise<void> {
    const slug = await storeCreatedApp(url);
    environment.log(`Created the GitHub App ${slug}. Install it on the repositories it works in.`);
    const installState = randomUUID();
    awaitedStates.set("/installed", installState);
    response.writeHead(302, {
      location: `https://github.com/apps/${slug}/installations/new?state=${installState}`,
      connection: "close",
    });
    response.end();
  }

  function handleInstalled(url: URL, response: ServerResponse): void {
    const redirect = parseGithubInstallRedirect(url);
    if (redirect.outcome === "failed") throw new Error(redirect.problem);
    writeDevVarsFile(paths.orchestratorDevVars, {
      GITHUB_INSTALLATION_ID: redirect.installationId,
    });
    respond(response, 200, "<!doctype html><p>artfct is connected. Close this tab.</p>\n");
    environment.log("Installed the GitHub App.");
    setupFinished.resolve();
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    if (request.headers.host !== url.host) {
      respond(response, 400, "This address is not the one artfct opened.\n");
      return;
    }
    if (url.pathname === "/") {
      respond(
        response,
        200,
        manifestFormPage(githubNewAppUrl(environment.org, createdState), manifest),
      );
      return;
    }
    if (url.pathname !== "/created" && url.pathname !== "/installed") {
      respond(response, 404, "Not found\n");
      return;
    }
    if (!consumeGithubCallbackState(awaitedStates, url.pathname, url.searchParams.get("state"))) {
      respond(response, 400, "The state does not match this run.\n");
      return;
    }
    try {
      if (url.pathname === "/created") await handleCreated(url, response);
      else handleInstalled(url, response);
    } catch (error) {
      const problem = describeError(error);
      respond(response, 500, `<!doctype html><p>${escapeHtml(problem)}</p>\n`);
      setupFinished.reject(new Error(problem));
    }
  }

  server.on("request", (request, response) => void handleRequest(request, response));
  environment.log(`Opening ${origin}/ in the browser. Open it yourself if no browser appears.`);
  environment.openBrowser(`${origin}/`).catch(() => {});
  try {
    await setupFinished.promise;
  } finally {
    server.close();
  }
}
