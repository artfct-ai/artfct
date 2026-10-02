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
  return response.json();
}
