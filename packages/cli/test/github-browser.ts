/** The manifest fields the fake browser read from the form page. */
export type GithubAppManifestSeen = {
  hook_attributes: { url: string };
  redirect_url: string;
  setup_url: string;
  default_permissions: Record<string, string>;
  default_events: string[];
};

/** The manifest form page as the fake browser read it, with the state GitHub brings back. */
export type GithubManifestFormSeen = {
  formAction: string;
  manifest: GithubAppManifestSeen;
  state: string;
};

/** What the fake browser saw and got back at each step of the setup. */
export type FakeGithubBrowserVisit = {
  formAction: string;
  manifest: GithubAppManifestSeen;
  createdStatus: number;
  installLocation: string | null;
  installedStatus: number | null;
};

function unescapeHtml(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function matchOrThrow(text: string, pattern: RegExp): string {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) throw new Error(`no match for ${pattern}`);
  return unescapeHtml(value);
}

/** Load the manifest form page as a browser would, without submitting it. */
export async function readGithubManifestForm(url: string): Promise<GithubManifestFormSeen> {
  const page = await (await fetch(url)).text();
  const formAction = matchOrThrow(page, /action="([^"]*)"/);
  const manifest: GithubAppManifestSeen = JSON.parse(matchOrThrow(page, /value="([^"]*)"/));
  const state = new URL(formAction).searchParams.get("state") ?? "";
  return { formAction, manifest, state };
}

/** A browser stand-in that submits the manifest form, then follows the install redirect with the given query. */
export function fakeGithubBrowser(installQuery: string) {
  const visit = Promise.withResolvers<FakeGithubBrowserVisit>();

  async function browse(url: string): Promise<FakeGithubBrowserVisit> {
    const { formAction, manifest, state } = await readGithubManifestForm(url);
    const created = await fetch(`${manifest.redirect_url}?code=manifest-code&state=${state}`, {
      redirect: "manual",
    });
    const installLocation = created.headers.get("location");
    if (created.status !== 302 || installLocation === null) {
      return {
        formAction,
        manifest,
        createdStatus: created.status,
        installLocation,
        installedStatus: null,
      };
    }
    const installState = new URL(installLocation).searchParams.get("state") ?? "";
    const installed = await fetch(`${manifest.setup_url}?${installQuery}&state=${installState}`);
    return {
      formAction,
      manifest,
      createdStatus: created.status,
      installLocation,
      installedStatus: installed.status,
    };
  }

  const openBrowser = async (url: string) => {
    browse(url).then(visit.resolve, visit.reject);
  };
  return { openBrowser, visit: visit.promise };
}
