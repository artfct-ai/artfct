/** Trade the temporary code from the manifest flow for the new app's credentials. The call takes no token. */
export async function exchangeGithubManifestCode(code: string): Promise<unknown> {
  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub rejected the manifest code with ${response.status}.`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub answered the manifest code with a body that is not JSON.");
  }
}
