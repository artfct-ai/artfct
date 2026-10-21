/** A secret value the test planted, by a token unique to one of its parts. */
export type SecretMarker = {
  token: string;
  /** The `.dev.vars` file the secret belongs in, relative to the deployment repo. Null when it belongs in none. */
  home: string | null;
  /** Whether the secret came from GitHub during the run, so the CLI wrote it. */
  issued: boolean;
};

/** One piece of text the CLI showed a person, and where it showed it. */
export type ShownText = { channel: string; text: string };

/** Everything a CLI run showed, and the secrets it held. */
export type ShownTexts = { shown: ShownText[]; markers: SecretMarker[] };

/** One file of the deployment repo after a CLI run. */
export type DeploymentFile = { path: string; mode: number; text: string; changed: boolean };

/** Every file of the deployment repo after a CLI run, and the secrets the run held. */
export type DeploymentFiles = { files: DeploymentFile[]; markers: SecretMarker[] };

/** One request that left the CLI process. */
export type OutboundRequest = { method: string; url: string; headers: string[]; body: string };

/**
 * Every request that left the CLI process during a run, each GitHub CLI command it ran by its
 * arguments, and the secrets the run held.
 */
export type OutboundRequests = {
  requests: OutboundRequest[];
  ghCalls: string[][];
  markers: SecretMarker[];
};

/** One request that did not come from the browser flow, and how the loopback server answered it. */
export type ForeignRequest = { request: string; status: number; advancedTheFlow: boolean };

/** The loopback server of one `artfct connect code` run, as a client on the machine saw it. */
export type LoopbackServer = {
  openedUrl: string;
  /** Each address outside loopback where the server accepted a connection. */
  reachableAt: string[];
  foreignRequests: ForeignRequest[];
};

/** The `.dev.vars` files a deployment repo holds, and the ones git ignores. */
export type IgnoredDevVars = { devVarsPaths: string[]; ignoredPaths: string[] };

const OWNER_ONLY = 0o600;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const GITHUB_MANIFEST_EXCHANGE =
  /^https:\/\/api\.github\.com\/app-manifests\/[^/?#]+\/conversions$/;

const GITHUB_APP_READ = /^apps\/[^/?#\s]+$/;

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

function markersIn(text: string, markers: SecretMarker[]): SecretMarker[] {
  return markers.filter((marker) => text.includes(marker.token));
}

/** The CLI never shows a secret value: not in its output, its errors and their causes, or a page its loopback server serves. */
export function cliNeverShowsASecret(record: ShownTexts): void {
  for (const shown of record.shown) {
    const [marker] = markersIn(shown.text, record.markers);
    if (marker === undefined) continue;
    violated(
      "cliNeverShowsASecret",
      `${shown.channel} showed the secret part ${marker.token}: ${JSON.stringify(shown.text)}`,
    );
  }
}

/**
 * The CLI writes a secret value only to its own `.dev.vars` file, readable only by its owner. A
 * `.dev.vars` the CLI wrote has mode 0600, also when it existed before with wider permissions.
 */
export function cliWritesASecretOnlyToItsOwnDevVars(record: DeploymentFiles): void {
  for (const file of record.files) {
    const held = markersIn(file.text, record.markers);
    const stray = held.find((marker) => marker.home !== file.path);
    if (stray) {
      violated(
        "cliWritesASecretOnlyToItsOwnDevVars",
        `${file.path} holds the secret part ${stray.token}, which belongs in ${stray.home ?? "no file"}`,
      );
    }
    const writtenByTheCli = file.changed || held.some((marker) => marker.issued);
    if (held.length === 0 || !writtenByTheCli || file.mode === OWNER_ONLY) continue;
    violated(
      "cliWritesASecretOnlyToItsOwnDevVars",
      `the CLI wrote secrets to ${file.path} and left its mode ${file.mode.toString(8)}`,
    );
  }
}

/**
 * The CLI sends a secret to nobody. Only the GitHub manifest code exchange leaves it, and the
 * GitHub CLI runs only the read of the GitHub App. Neither carries a secret.
 */
export function cliSendsNoSecret(record: OutboundRequests): void {
  for (const args of record.ghCalls) {
    const [command, path, ...rest] = args;
    if (command !== "api" || path === undefined || !GITHUB_APP_READ.test(path) || rest.length) {
      violated("cliSendsNoSecret", `the CLI ran gh ${args.join(" ")}, which is not the App read`);
    }
    const [marker] = markersIn(args.join("\n"), record.markers);
    if (marker === undefined) continue;
    violated("cliSendsNoSecret", `gh ${path} carried the secret part ${marker.token}`);
  }
  for (const request of record.requests) {
    if (request.method !== "POST" || !GITHUB_MANIFEST_EXCHANGE.test(request.url)) {
      violated(
        "cliSendsNoSecret",
        `the CLI sent ${request.method} ${request.url}, which is not the manifest code exchange`,
      );
    }
    const [marker] = markersIn(
      [request.url, ...request.headers, request.body].join("\n"),
      record.markers,
    );
    if (marker === undefined) continue;
    violated("cliSendsNoSecret", `${request.url} carried the secret part ${marker.token}`);
  }
}

/**
 * The loopback server answers only the browser flow it started. It listens on loopback only,
 * and refuses a request under another Host header or without the state the run expects.
 */
export function loopbackServerAnswersOnlyItsOwnFlow(record: LoopbackServer): void {
  const openedHost = new URL(record.openedUrl).hostname;
  if (!LOOPBACK_HOSTS.has(openedHost)) {
    violated("loopbackServerAnswersOnlyItsOwnFlow", `the CLI opened ${record.openedUrl}`);
  }
  const [reachable] = record.reachableAt;
  if (reachable !== undefined) {
    violated(
      "loopbackServerAnswersOnlyItsOwnFlow",
      `the server accepted a connection at ${reachable}`,
    );
  }
  for (const foreign of record.foreignRequests) {
    const refused = foreign.status >= 400 && foreign.status < 500;
    if (refused && !foreign.advancedTheFlow) continue;
    violated(
      "loopbackServerAnswersOnlyItsOwnFlow",
      `${foreign.request} got ${foreign.status}${foreign.advancedTheFlow ? " and advanced the flow" : ""}`,
    );
  }
}

/** Git ignores every `.dev.vars` in a deployment repo. */
export function gitIgnoresEveryDevVars(record: IgnoredDevVars): void {
  const ignored = new Set(record.ignoredPaths);
  const tracked = record.devVarsPaths.find((path) => !ignored.has(path));
  if (tracked === undefined) return;
  violated("gitIgnoresEveryDevVars", `git does not ignore ${tracked}`);
}
