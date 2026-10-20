import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  cliNeverShowsASecret,
  cliSendsNoSecret,
  cliWritesASecretOnlyToItsOwnDevVars,
  gitIgnoresEveryDevVars,
  loopbackServerAnswersOnlyItsOwnFlow,
  type DeploymentFile,
  type ForeignRequest,
  type OutboundRequest,
  type SecretMarker,
  type ShownText,
} from "../test/cli-secret-invariants";
import { parseGithubManifestForm } from "../test/github-browser";
import { packagedTemplate, TEMPLATE_DIR } from "../test/template";
import { formatChecksReport, runChecks } from "./check/check";
import { connectGithubApp } from "./connect/code/github/connect";
import { exchangeGithubManifestCode } from "./connect/code/github/exchange";
import { describeError } from "./describe-error";
import { runInit } from "./init/init";

const CONNECT_RUNS = 150;

const GITIGNORE_RUNS = 30;

const ORCHESTRATOR_DEV_VARS = "orchestrator/.dev.vars";

const INGRESS_DEV_VARS = "ingress/.dev.vars";

const SETTLE_GRACE_MS = 500;

const PROBE_TIMEOUT_MS = 300;

const FAILURES = [
  "orchestrator .dev.vars missing",
  "PUBLIC_URL unset",
  "PUBLIC_URL not a URL",
  "ingress config missing",
  "exchange network error",
  "exchange refused",
  "exchange body not JSON",
  "conversion unreadable",
  "ingress .dev.vars unwritable",
  "ingress config unwritable",
  "install without an installation id",
  "installation id unwritable",
  "browser opener fails",
  "none",
] as const;

type Failure = (typeof FAILURES)[number];

const FOREIGN_KINDS = [
  "another host",
  "without a state",
  "a wrong state",
  "the other path's state",
  "a replayed state",
  "an unknown path",
] as const;

type ForeignKind = (typeof FOREIGN_KINDS)[number];

type FlowPoint = "before the form" | "after the form" | "after created";

type ForeignHost =
  | "another domain"
  | "localhost with the port"
  | "loopback with another port"
  | "loopback without a port"
  | "ipv6 loopback with the port";

type ServedPath = "/" | "/created" | "/installed";

type ForeignPlan = {
  kind: ForeignKind;
  at: FlowPoint;
  path: ServedPath;
  host: ForeignHost;
  domain: string;
  wrongState: string;
  unknownPath: string;
};

type SecretShape = Array<[string, string]>;

type DevVarsEntry = { name: string; shape: SecretShape };

type DevVarsPlan = { mode: number; entries: DevVarsEntry[] } | null;

type BrokenField = "webhook_secret null" | "pem empty" | "id text" | "slug missing";

type MalformedBody = "bare secret" | "truncated";

type ConnectScenario = {
  nonce: string;
  org: string | undefined;
  publicUrl: string;
  publicUrlFirst: boolean;
  orchestratorDevVars: DevVarsPlan;
  ingressDevVars: DevVarsPlan;
  pem: SecretShape;
  webhookSecret: SecretShape;
  clientSecret: SecretShape;
  appId: number;
  slug: string;
  manifestCode: string;
  installationId: number;
  failure: Failure;
  refusedStatus: number;
  malformedBody: MalformedBody;
  brokenField: BrokenField;
  checkReadsUnreadableDevVars: boolean;
  foreign: ForeignPlan[];
};

type ConnectRun = {
  scenario: ConnectScenario;
  repoDir: string;
  markers: SecretMarker[];
  nextToken: () => string;
  pem: string;
  webhookSecret: string;
  clientSecret: string;
  shown: ShownText[];
  requests: OutboundRequest[];
  foreignRequests: ForeignRequest[];
  reachableAt: string[];
  probedAddresses: number;
  openedUrl: string | null;
  installState: string | null;
  createdConsumed: boolean;
};

type Answer = { status: number; location: string | null; body: string };

const SPECIAL_CHARACTERS = [
  '"',
  "'",
  "\\",
  "$",
  "#",
  "=",
  " ",
  "\t",
  "<",
  ">",
  "&",
  "é",
  "😀",
  "%",
  "{",
  "}",
  "`",
  "/",
  "+",
];

const specialText = fc.string({ unit: fc.constantFrom(...SPECIAL_CHARACTERS), maxLength: 6 });

const secretShape = (maxLines: number): fc.Arbitrary<SecretShape> =>
  fc.array(fc.tuple(specialText, specialText), { minLength: 1, maxLength: maxLines });

const ORCHESTRATOR_SECRET_NAMES = [
  "ADMIN_TOKEN",
  "NOTION_TOKEN",
  "SLACK_BOT_TOKEN",
  "OPENROUTER_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "LINEAR_CLIENT_SECRET",
];

const INGRESS_SECRET_NAMES = [
  "ADMIN_TOKEN",
  "SLACK_SIGNING_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "NOTION_VERIFICATION_TOKEN",
];

const devVarsPlan = (names: string[]): fc.Arbitrary<DevVarsPlan> =>
  fc.option(
    fc.record({
      mode: fc.constantFrom(0o600, 0o644, 0o640, 0o666, 0o604),
      entries: fc.uniqueArray(
        fc.record({ name: fc.constantFrom(...names), shape: secretShape(3) }),
        { selector: (entry) => entry.name, maxLength: names.length },
      ),
    }),
    { nil: null },
  );

const foreignPlan: fc.Arbitrary<ForeignPlan> = fc.record({
  kind: fc.constantFrom(...FOREIGN_KINDS),
  at: fc.constantFrom<FlowPoint>("before the form", "after the form", "after created"),
  path: fc.constantFrom<ServedPath>("/", "/created", "/installed"),
  host: fc.constantFrom<ForeignHost>(
    "another domain",
    "localhost with the port",
    "loopback with another port",
    "loopback without a port",
    "ipv6 loopback with the port",
  ),
  domain: fc.domain(),
  wrongState: fc.oneof(fc.uuid(), fc.string({ minLength: 1, maxLength: 40 })),
  unknownPath: fc.constantFrom(
    "/favicon.ico",
    "/admin",
    "/created/",
    "/installed/again",
    "/index.html",
  ),
});

const connectScenario: fc.Arbitrary<ConnectScenario> = fc.record({
  nonce: fc.stringMatching(/^[a-z0-9]{10}$/),
  org: fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), { nil: undefined }),
  publicUrl: fc.constantFrom(
    "https://ingress.acme.dev",
    "https://artfct-ingress.example.workers.dev",
    "http://localhost:8787",
  ),
  publicUrlFirst: fc.boolean(),
  orchestratorDevVars: devVarsPlan(ORCHESTRATOR_SECRET_NAMES),
  ingressDevVars: devVarsPlan(INGRESS_SECRET_NAMES),
  pem: secretShape(5),
  webhookSecret: secretShape(3),
  clientSecret: secretShape(1),
  appId: fc.integer({ min: 1, max: 100_000_000 }),
  slug: fc.stringMatching(/^artfct-[a-z]{1,8}$/),
  manifestCode: fc.stringMatching(/^[a-f0-9]{20}$/),
  installationId: fc.integer({ min: 1, max: 1_000_000_000 }),
  failure: fc.constantFrom(...FAILURES),
  refusedStatus: fc.constantFrom(400, 401, 404, 422, 500, 503),
  malformedBody: fc.constantFrom<MalformedBody>("bare secret", "truncated"),
  brokenField: fc.constantFrom<BrokenField>(
    "webhook_secret null",
    "pem empty",
    "id text",
    "slug missing",
  ),
  checkReadsUnreadableDevVars: fc.boolean(),
  foreign: fc.array(foreignPlan, { maxLength: 4 }),
});

const reached = new Map<string, number>(
  [
    ...FAILURES.map((failure) => `failure: ${failure}`),
    ...FOREIGN_KINDS.map((kind) => `foreign request: ${kind}`),
    "error page served",
    "secrets written",
    "wider .dev.vars narrowed",
    "new .dev.vars created",
    "manifest code exchanged",
    "address outside loopback probed",
    "check read a set NOTION_TOKEN",
    "check read an unreadable .dev.vars",
    "multi-line secret written",
  ].map((name) => [name, 0]),
);

function reach(name: string): void {
  reached.set(name, (reached.get(name) ?? 0) + 1);
}

function secretValue(
  run: Pick<ConnectRun, "markers" | "nextToken">,
  secret: { shape: SecretShape; home: string | null; issued: boolean },
): string {
  const { shape, home, issued } = secret;
  return shape
    .map(([prefix, suffix]) => {
      const token = run.nextToken();
      run.markers.push({ token, home, issued });
      return `${prefix}${token}${suffix}`;
    })
    .join("\n");
}

function devVarLine(name: string, value: string): string {
  return value.includes("\n") ? `${name}="${value}"` : `${name}=${value}`;
}

function publicUrlLine(scenario: ConnectScenario): string | null {
  switch (scenario.failure) {
    case "PUBLIC_URL unset":
      return "PUBLIC_URL=";
    case "PUBLIC_URL not a URL":
      return `PUBLIC_URL=${new URL(scenario.publicUrl).host}`;
    default:
      return `PUBLIC_URL=${scenario.publicUrl}`;
  }
}

function writeExistingDevVars(
  run: Pick<ConnectRun, "markers" | "nextToken" | "repoDir">,
  options: { path: string; plan: DevVarsPlan; firstLine: string | null; lastLine: string | null },
): void {
  const { path, plan, firstLine, lastLine } = options;
  if (plan === null && firstLine === null && lastLine === null) return;
  const entries = (plan?.entries ?? []).map((entry) =>
    devVarLine(entry.name, secretValue(run, { shape: entry.shape, home: path, issued: false })),
  );
  const lines = [firstLine, ...entries, lastLine].filter((line) => line !== null);
  writeFileSync(join(run.repoDir, path), `${lines.join("\n")}\n`);
  chmodSync(join(run.repoDir, path), plan?.mode ?? 0o644);
}

function prepareConnectRun(scenario: ConnectScenario): ConnectRun {
  const repoDir = mkdtempSync(join(tmpdir(), "artfct-secrets-"));
  cpSync(join(TEMPLATE_DIR, "ingress"), join(repoDir, "ingress"), { recursive: true });
  cpSync(join(TEMPLATE_DIR, "orchestrator"), join(repoDir, "orchestrator"), { recursive: true });
  let tokenCount = 0;
  const markers: SecretMarker[] = [];
  const nextToken = () => {
    tokenCount += 1;
    return `zq${scenario.nonce}k${tokenCount}q`;
  };
  const tokens = { markers, nextToken, repoDir };
  const orchestratorMissing = scenario.failure === "orchestrator .dev.vars missing";
  const urlLine = orchestratorMissing ? null : publicUrlLine(scenario);
  writeExistingDevVars(tokens, {
    path: ORCHESTRATOR_DEV_VARS,
    plan: orchestratorMissing ? null : scenario.orchestratorDevVars,
    firstLine: scenario.publicUrlFirst ? urlLine : null,
    lastLine: scenario.publicUrlFirst ? null : urlLine,
  });
  if (scenario.failure !== "ingress .dev.vars unwritable") {
    writeExistingDevVars(tokens, {
      path: INGRESS_DEV_VARS,
      plan: scenario.ingressDevVars,
      firstLine: null,
      lastLine: null,
    });
  }
  const pemBody = secretValue(tokens, {
    shape: scenario.pem,
    home: ORCHESTRATOR_DEV_VARS,
    issued: true,
  });
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----\n`;
  const webhookSecret = secretValue(tokens, {
    shape: scenario.webhookSecret,
    home: INGRESS_DEV_VARS,
    issued: true,
  });
  const clientSecret = secretValue(tokens, {
    shape: scenario.clientSecret,
    home: null,
    issued: true,
  });
  if (scenario.failure === "ingress config missing")
    unlinkSync(join(repoDir, "ingress/wrangler.jsonc"));
  if (scenario.failure === "ingress config unwritable")
    chmodSync(join(repoDir, "ingress/wrangler.jsonc"), 0o444);
  if (scenario.failure === "ingress .dev.vars unwritable")
    chmodSync(join(repoDir, "ingress"), 0o500);
  return {
    scenario,
    repoDir,
    markers,
    nextToken,
    pem,
    webhookSecret,
    clientSecret,
    shown: [],
    requests: [],
    foreignRequests: [],
    reachableAt: [],
    probedAddresses: 0,
    openedUrl: null,
    installState: null,
    createdConsumed: false,
  };
}

function restoreWritableDirs(repoDir: string): void {
  for (const dir of ["ingress", "orchestrator"]) chmodSync(join(repoDir, dir), 0o755);
}

function conversionAnswer(run: ConnectRun): object {
  const conversion: Record<string, unknown> = {
    id: run.scenario.appId,
    slug: run.scenario.slug,
    node_id: "A_kwDOAAxyzw",
    owner: { login: run.scenario.org ?? "octocat", id: 1, type: "User" },
    name: run.scenario.slug,
    html_url: `https://github.com/apps/${run.scenario.slug}`,
    client_id: "Iv23liAbCdEf",
    client_secret: run.clientSecret,
    webhook_secret: run.webhookSecret,
    pem: run.pem,
  };
  if (run.scenario.failure !== "conversion unreadable") return conversion;
  switch (run.scenario.brokenField) {
    case "webhook_secret null":
      return { ...conversion, webhook_secret: null };
    case "pem empty":
      return { ...conversion, pem: "" };
    case "id text":
      return { ...conversion, id: `app-${run.scenario.appId}` };
    case "slug missing":
      return Object.fromEntries(Object.entries(conversion).filter(([key]) => key !== "slug"));
    default: {
      const unreachable: never = run.scenario.brokenField;
      throw new Error(`unhandled case ${JSON.stringify(unreachable)}`);
    }
  }
}

function malformedConversion(run: ConnectRun): string {
  const [firstToken] = run.markers.filter((marker) => marker.issued);
  if (run.scenario.malformedBody === "bare secret") {
    return `{"client_id": "Iv23liAbCdEf", "pem": ${firstToken?.token ?? ""}}`;
  }
  return JSON.stringify(conversionAnswer(run)).slice(0, -12);
}

function headerLines(headers: RequestInit["headers"] | Iterable<[string, string]>): string[] {
  if (headers === undefined) return [];
  const pairs =
    Symbol.iterator in headers ? [...(headers as Iterable<string[]>)] : Object.entries(headers);
  return pairs.map((pair) => pair.join(": "));
}

async function outboundRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<OutboundRequest> {
  if (!(input instanceof Request)) {
    return {
      method: init?.method ?? "GET",
      url: input instanceof URL ? input.href : input,
      headers: headerLines(init?.headers),
      body: await new Response(init?.body).text(),
    };
  }
  const request = input.clone();
  return {
    method: init?.method ?? request.method,
    url: request.url,
    headers: [...headerLines(request.headers), ...headerLines(init?.headers)],
    body: await new Response(init?.body ?? request.body).text(),
  };
}

function fakeGithubApi(run: ConnectRun) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = await outboundRequest(input, init);
    run.requests.push(request);
    if (!request.url.startsWith("https://api.github.com/app-manifests/")) {
      return new Response("Not Found", { status: 404 });
    }
    reach("manifest code exchanged");
    switch (run.scenario.failure) {
      case "exchange network error":
        throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
      case "exchange refused":
        return new Response(JSON.stringify({ message: "Bad", ...conversionAnswer(run) }), {
          status: run.scenario.refusedStatus,
        });
      case "exchange body not JSON":
        return new Response(malformedConversion(run), { status: 201 });
      default:
        return Response.json(conversionAnswer(run), { status: 201 });
    }
  };
}

function httpGet(url: string, host?: string): Promise<Answer | null> {
  return new Promise((resolve) => {
    const headers = host === undefined ? {} : { host };
    const outgoing = httpRequest(url, { headers, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location ?? null,
          body,
        }),
      );
    });
    outgoing.on("error", () => resolve(null));
    outgoing.end();
  });
}

function showPage(run: ConnectRun, path: string, answer: Answer | null): void {
  if (answer === null) return;
  if (answer.status >= 500) reach("error page served");
  run.shown.push({ channel: `page ${path}`, text: `${answer.body}\n${answer.location ?? ""}` });
}

function foreignHost(plan: ForeignPlan, origin: URL): string {
  switch (plan.host) {
    case "another domain":
      return plan.domain;
    case "localhost with the port":
      return `localhost:${origin.port}`;
    case "loopback with another port":
      return `127.0.0.1:${Number(origin.port) + 1}`;
    case "loopback without a port":
      return "127.0.0.1";
    case "ipv6 loopback with the port":
      return `[::1]:${origin.port}`;
    default: {
      const unreachable: never = plan.host;
      throw new Error(`unhandled case ${JSON.stringify(unreachable)}`);
    }
  }
}

function awaitedState(run: ConnectRun, path: ServedPath, createdState: string): string | null {
  if (path === "/installed") return run.installState;
  return createdState;
}

function foreignTarget(
  run: ConnectRun,
  plan: ForeignPlan,
  createdState: string,
): { path: string; state: string | null; foreignHost: boolean } | null {
  switch (plan.kind) {
    case "another host":
      return {
        path: plan.path,
        state: awaitedState(run, plan.path, createdState),
        foreignHost: true,
      };
    case "without a state":
      return { path: plan.path, state: null, foreignHost: false };
    case "a wrong state":
      return plan.wrongState === createdState || plan.wrongState === run.installState
        ? null
        : { path: plan.path, state: plan.wrongState, foreignHost: false };
    case "the other path's state":
      if (plan.path === "/installed") {
        return { path: plan.path, state: createdState, foreignHost: false };
      }
      return run.installState === null
        ? null
        : { path: plan.path, state: run.installState, foreignHost: false };
    case "a replayed state":
      return run.createdConsumed
        ? { path: "/created", state: createdState, foreignHost: false }
        : null;
    case "an unknown path":
      return { path: plan.unknownPath, state: createdState, foreignHost: false };
    default: {
      const unreachable: never = plan.kind;
      throw new Error(`unhandled case ${JSON.stringify(unreachable)}`);
    }
  }
}

function foreignSentAt(plan: ForeignPlan): FlowPoint {
  return plan.kind === "a replayed state" ? "after created" : plan.at;
}

async function sendForeignRequests(run: ConnectRun, at: FlowPoint, opened: URL): Promise<void> {
  const createdState = opened.searchParams.get("state") ?? "";
  for (const plan of run.scenario.foreign.filter((foreign) => foreignSentAt(foreign) === at)) {
    const target = foreignTarget(run, plan, createdState);
    if (target === null) continue;
    const query = new URLSearchParams({ code: run.scenario.manifestCode });
    if (target.state !== null) query.set("state", target.state);
    const url = `${opened.origin}${target.path}?${query.toString()}`;
    const host = target.foreignHost ? foreignHost(plan, opened) : undefined;
    const exchangesBefore = run.requests.length;
    const answer = await httpGet(url, host);
    if (answer === null) continue;
    reach(`foreign request: ${plan.kind}`);
    showPage(run, target.path, answer);
    run.foreignRequests.push({
      request: `${plan.kind}: GET ${url}${host === undefined ? "" : ` under Host ${host}`}`,
      status: answer.status,
      advancedTheFlow: run.requests.length > exchangesBefore,
    });
  }
}

function outsideLoopbackAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => !address.internal && address.family === "IPv4")
    .map((address) => address.address);
}

function acceptsConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const finish = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

async function probeOutsideLoopback(run: ConnectRun, opened: URL): Promise<void> {
  for (const address of outsideLoopbackAddresses()) {
    run.probedAddresses += 1;
    reach("address outside loopback probed");
    if (await acceptsConnection(address, Number(opened.port))) run.reachableAt.push(address);
  }
}

function installQuery(run: ConnectRun): string {
  return run.scenario.failure === "install without an installation id"
    ? "setup_action=request"
    : `installation_id=${run.scenario.installationId}&setup_action=install`;
}

async function browse(run: ConnectRun, openedUrl: string): Promise<void> {
  const opened = new URL(openedUrl);
  await sendForeignRequests(run, "before the form", opened);
  await probeOutsideLoopback(run, opened);
  const formPage = await httpGet(openedUrl);
  showPage(run, "/", formPage);
  if (formPage?.status !== 200) return;
  const form = parseGithubManifestForm(formPage.body);
  await sendForeignRequests(run, "after the form", opened);
  const created = await httpGet(
    `${form.manifest.redirect_url}?code=${run.scenario.manifestCode}&state=${form.state}`,
  );
  showPage(run, "/created", created);
  run.createdConsumed = true;
  if (created?.status !== 302 || created.location === null) return;
  run.installState = new URL(created.location).searchParams.get("state");
  if (run.scenario.failure === "installation id unwritable") {
    unlinkSync(join(run.repoDir, ORCHESTRATOR_DEV_VARS));
    chmodSync(join(run.repoDir, "orchestrator"), 0o500);
  }
  await sendForeignRequests(run, "after created", opened);
  const installed = await httpGet(
    `${form.manifest.setup_url}?${installQuery(run)}&state=${run.installState ?? ""}`,
  );
  showPage(run, "/installed", installed);
}

function captureOutput(run: ConnectRun): () => void {
  const record =
    (channel: string) =>
    (...parts: unknown[]) => {
      run.shown.push({ channel, text: parts.map((part) => describeError(part)).join(" ") });
      return true;
    };
  const spies = [
    spyOn(console, "log").mockImplementation(record("console.log")),
    spyOn(console, "info").mockImplementation(record("console.info")),
    spyOn(console, "warn").mockImplementation(record("console.warn")),
    spyOn(console, "error").mockImplementation(record("console.error")),
    spyOn(console, "debug").mockImplementation(record("console.debug")),
    spyOn(process.stdout, "write").mockImplementation(record("stdout")),
    spyOn(process.stderr, "write").mockImplementation(record("stderr")),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

async function connectUntilSettled(run: ConnectRun): Promise<"settled" | "hung"> {
  const browsed = Promise.withResolvers<void>();
  const connected = connectGithubApp({
    repoDir: run.repoDir,
    org: run.scenario.org,
    openBrowser: async (url) => {
      run.openedUrl = url;
      browse(run, url).then(browsed.resolve, browsed.reject);
      if (run.scenario.failure === "browser opener fails") throw new Error("spawn xdg-open ENOENT");
    },
    exchangeManifestCode: exchangeGithubManifestCode,
    log: (line) => run.shown.push({ channel: "stdout", text: line }),
  }).then(
    () => "settled" as const,
    (error: unknown) => {
      run.shown.push({ channel: "stderr", text: describeError(error) });
      return "settled" as const;
    },
  );
  const hung = browsed.promise.then(() => Bun.sleep(SETTLE_GRACE_MS)).then(() => "hung" as const);
  return Promise.race([connected, hung]);
}

async function checkDeployment(run: ConnectRun): Promise<void> {
  const devVarsPath = join(run.repoDir, ORCHESTRATOR_DEV_VARS);
  const devVarsMode = statSync(devVarsPath, { throwIfNoEntry: false })?.mode;
  const unreadable = devVarsMode !== undefined && run.scenario.checkReadsUnreadableDevVars;
  if (unreadable) {
    reach("check read an unreadable .dev.vars");
    chmodSync(devVarsPath, 0);
  } else if (/^NOTION_TOKEN=.+/m.test(readDeploymentFile(run.repoDir, ORCHESTRATOR_DEV_VARS))) {
    reach("check read a set NOTION_TOKEN");
  }
  const reports = await runChecks({ repoDir: run.repoDir, runWrangler: null });
  if (unreadable) chmodSync(devVarsPath, devVarsMode & 0o777);
  run.shown.push({ channel: "artfct check", text: formatChecksReport(reports) });
}

function readDeploymentFile(repoDir: string, path: string): string {
  try {
    return readFileSync(join(repoDir, path), "utf8");
  } catch {
    return "";
  }
}

function deploymentFileTexts(repoDir: string): Map<string, string> {
  const paths = readdirSync(repoDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoDir, join(entry.parentPath, entry.name)));
  return new Map(paths.map((path) => [path, readDeploymentFile(repoDir, path)]));
}

function deploymentFiles(repoDir: string, before: Map<string, string>): DeploymentFile[] {
  return [...deploymentFileTexts(repoDir)].map(([path, text]) => ({
    path,
    text,
    mode: statSync(join(repoDir, path)).mode & 0o777,
    changed: before.get(path) !== text,
  }));
}

function reachWrites(run: ConnectRun, files: DeploymentFile[], before: Map<string, string>): void {
  const orchestrator = files.find((file) => file.path === ORCHESTRATOR_DEV_VARS);
  if (!orchestrator?.text.includes('GITHUB_PRIVATE_KEY="-----BEGIN')) return;
  reach("secrets written");
  if (run.scenario.pem.length > 1) reach("multi-line secret written");
  const widerBefore = (run.scenario.orchestratorDevVars?.mode ?? 0o644) !== 0o600;
  if (before.has(ORCHESTRATOR_DEV_VARS) && widerBefore) reach("wider .dev.vars narrowed");
  if (!before.has(INGRESS_DEV_VARS) && files.some((file) => file.path === INGRESS_DEV_VARS)) {
    reach("new .dev.vars created");
  }
}

describe("CLI secret invariants", () => {
  it(
    "artfct connect code and artfct check never show, scatter, or send a secret, and the loopback server answers only its own flow",
    async () => {
      await fc.assert(
        fc.asyncProperty(connectScenario, async (scenario) => {
          reach(`failure: ${scenario.failure}`);
          const run = prepareConnectRun(scenario);
          try {
            const before = deploymentFileTexts(run.repoDir);
            const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
              Object.assign(fakeGithubApi(run), { preconnect: fetch.preconnect }),
            );
            const restoreOutput = captureOutput(run);
            let outcome: "settled" | "hung";
            try {
              outcome = await connectUntilSettled(run);
            } finally {
              restoreOutput();
              fetchSpy.mockRestore();
            }
            restoreWritableDirs(run.repoDir);
            await checkDeployment(run);
            const files = deploymentFiles(run.repoDir, before);
            reachWrites(run, files, before);
            cliNeverShowsASecret({ shown: run.shown, markers: run.markers });
            cliWritesASecretOnlyToItsOwnDevVars({ files, markers: run.markers });
            cliSendsNoSecret({ requests: run.requests, markers: run.markers });
            if (run.openedUrl !== null) {
              loopbackServerAnswersOnlyItsOwnFlow({
                openedUrl: run.openedUrl,
                reachableAt: run.reachableAt,
                foreignRequests: run.foreignRequests,
              });
            }
            expect(outcome).toBe("settled");
          } finally {
            restoreWritableDirs(run.repoDir);
            rmSync(run.repoDir, { recursive: true, force: true });
          }
        }),
        propertyRuns("cli secrets", CONNECT_RUNS),
      );
      expect([...reached].filter(([, count]) => count === 0)).toEqual([]);
    },
    propertyTimeoutMs(60_000, CONNECT_RUNS),
  );
});

const PACKAGED_TEMPLATE = packagedTemplate();

afterAll(() => {
  rmSync(PACKAGED_TEMPLATE, { recursive: true, force: true });
});

const DEV_VARS_PLACEMENTS = ["root", "a Worker", "nested", "an environment file"] as const;

type DevVarsPlacement = { dir: string[]; name: string };

const dirSegment = fc
  .stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,8}$/)
  .filter((segment) => !segment.endsWith(" ") && !segment.endsWith("."));

const devVarsPlacement: fc.Arbitrary<DevVarsPlacement> = fc.record({
  dir: fc.oneof(
    fc.constantFrom<string[]>([], ["orchestrator"], ["ingress"]),
    fc.array(dirSegment, { minLength: 1, maxLength: 3 }),
  ),
  name: fc.oneof(
    fc.constant(".dev.vars"),
    fc
      .stringMatching(/^[a-z][a-z0-9-]{0,8}$/)
      .filter((environment) => environment !== "example")
      .map((environment) => `.dev.vars.${environment}`),
  ),
});

function placementKinds(placement: DevVarsPlacement): (typeof DEV_VARS_PLACEMENTS)[number][] {
  const kinds: (typeof DEV_VARS_PLACEMENTS)[number][] = [];
  if (placement.dir.length === 0) kinds.push("root");
  if (placement.dir.length === 1 && ["orchestrator", "ingress"].includes(placement.dir[0] ?? "")) {
    kinds.push("a Worker");
  }
  if (placement.dir.length > 1) kinds.push("nested");
  if (placement.name !== ".dev.vars") kinds.push("an environment file");
  return kinds;
}

function gitIgnoredPaths(repoDir: string, paths: string[]): string[] {
  const listed = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: repoDir,
    input: paths.join("\0"),
    encoding: "utf8",
  });
  return listed.stdout.split("\0").filter(Boolean);
}

describe("the deployment repo's git ignores", () => {
  it(
    "ignore every .dev.vars wherever it lies in a repo artfct init made",
    async () => {
      const placementsReached = new Map<string, number>();
      await fc.assert(
        fc.asyncProperty(
          fc.array(devVarsPlacement, { minLength: 1, maxLength: 5 }),
          async (placements) => {
            const repoDir = mkdtempSync(join(tmpdir(), "artfct-ignores-"));
            try {
              const report = await runInit({
                repoDir,
                templateDir: PACKAGED_TEMPLATE,
                runWrangler: async () => 0,
                announceStep: () => {},
              });
              expect(report.outcome).toBe("done");
              spawnSync("git", ["init", "-q"], { cwd: repoDir });
              const devVarsPaths = [
                ...new Set(placements.map((placement) => join(...placement.dir, placement.name))),
              ];
              for (const path of devVarsPaths) {
                mkdirSync(join(repoDir, dirname(path)), { recursive: true });
                writeFileSync(join(repoDir, path), "GITHUB_WEBHOOK_SECRET=zqsecretq\n");
              }
              for (const kind of placements.flatMap(placementKinds)) {
                placementsReached.set(kind, (placementsReached.get(kind) ?? 0) + 1);
              }
              gitIgnoresEveryDevVars({
                devVarsPaths,
                ignoredPaths: gitIgnoredPaths(repoDir, devVarsPaths),
              });
            } finally {
              rmSync(repoDir, { recursive: true, force: true });
            }
          },
        ),
        propertyRuns("deployment git ignores", GITIGNORE_RUNS),
      );
      expect(DEV_VARS_PLACEMENTS.filter((kind) => !placementsReached.get(kind))).toEqual([]);
    },
    propertyTimeoutMs(30_000, GITIGNORE_RUNS),
  );
});
