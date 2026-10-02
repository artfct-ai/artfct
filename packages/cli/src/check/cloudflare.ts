import type { CheckOutcome, RunWrangler } from "./types";

function readWranglerLoggedIn(stdout: string): boolean | undefined {
  try {
    const whoami: { loggedIn?: unknown } = JSON.parse(stdout);
    return typeof whoami.loggedIn === "boolean" ? whoami.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

/** Ask wrangler whether its Cloudflare credential works. The check never reads the credential. */
export async function checkCloudflareCredential(runWrangler: RunWrangler): Promise<CheckOutcome> {
  const result = await runWrangler(["whoami", "--json"]);
  const loggedIn = readWranglerLoggedIn(result.stdout);
  if (loggedIn === false) {
    return {
      outcome: "failed",
      problems: [
        "wrangler has no Cloudflare credential. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or run `wrangler login`.",
      ],
    };
  }
  if (result.exitCode !== 0 || loggedIn !== true) {
    return {
      outcome: "failed",
      problems: [`wrangler whoami exited with ${result.exitCode}. ${result.stderr.trim()}`.trim()],
    };
  }
  return { outcome: "passed", detail: "wrangler is authenticated" };
}
