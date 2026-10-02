import { z } from "zod";

const conversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  pem: z.string().min(1),
  webhook_secret: z.string().min(1),
});

/** The credentials of a GitHub App that the manifest flow created. */
export type GithubAppCredentials = {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
};

/** Read the app credentials from GitHub's answer to the manifest code conversion. */
export function parseGithubAppConversion(body: unknown): GithubAppCredentials {
  const conversion = conversionSchema.parse(body);
  return {
    appId: String(conversion.id),
    slug: conversion.slug,
    privateKey: conversion.pem,
    webhookSecret: conversion.webhook_secret,
  };
}

/** What the browser brought back to the setup URL after the install page. */
export type GithubInstallRedirect =
  | { outcome: "installed"; installationId: string }
  | { outcome: "failed"; problem: string };

/** Read the installation id GitHub puts on the setup URL once the app is installed. */
export function parseGithubInstallRedirect(url: URL): GithubInstallRedirect {
  const installationId = url.searchParams.get("installation_id");
  if (installationId === null || !/^\d+$/.test(installationId)) {
    return {
      outcome: "failed",
      problem:
        "GitHub returned no installation id. When an organization owner must approve the install, set GITHUB_INSTALLATION_ID in orchestrator/.dev.vars after the approval.",
    };
  }
  return { outcome: "installed", installationId };
}

/** Accept the state a callback path awaits and forget it, so a replay of that state is refused. */
export function consumeGithubCallbackState(
  awaitedStates: Map<string, string>,
  path: string,
  state: string | null,
): boolean {
  if (awaitedStates.get(path) !== state) return false;
  awaitedStates.delete(path);
  return true;
}
