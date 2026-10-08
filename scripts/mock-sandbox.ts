#!/usr/bin/env bun
/**
 * Mock sandbox host for `bun run dev` and the smoke run. On a start request it spawns the real
 * artfct-bridge, which dials back into the ingress Worker. With `--scripted-harness` it spawns the
 * bridge with the in-process mock harness instead, as the smoke run does. Every call that changes a
 * sandbox is recorded. Each sandbox gets a directory on this host that stands for its container
 * root. `GET /__state` returns the record, `POST /__reset` clears it, `POST /__kill` ends one bridge.
 * `POST /bridge` tells whether the bridge of one generation still runs.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type BridgeProcess = ReturnType<typeof Bun.spawn>;

/** Body of a `/start` request from the Workflow DO. */
type StartSpec = {
  sandbox_id: string;
  workflow_id: string;
  task_id: string;
  dial_url: string;
  token: string;
  harness: string;
  env: Record<string, string>;
  generation: number;
  workspace: string;
  model: string;
  repo: {
    clone_url: string;
    branch: string | null;
    author: { name: string; email: string } | null;
  } | null;
  github_token: string | null;
  files: Array<{ path: string; content: string }>;
  sleep_after_ms: number;
  startup_script: string;
  bridge_command: string;
  bridge_env: Record<string, string>;
};

/** A bridge exit. `killed` is true when this host killed the bridge on a destroy or replace. */
type BridgeExit = {
  at: string;
  sandbox_id: string;
  generation: number;
  code: number | null;
  signal: string | null;
  killed: boolean;
};

/** One running bridge and whether this host asked it to die. */
type BridgeEntry = { process: BridgeProcess; generation: number; killed: boolean };

const port = Number(process.env.MOCK_SANDBOX_PORT ?? "9797");
const controlUrl = `http://localhost:${port}`;
const bridgeCli = process.argv.includes("--scripted-harness")
  ? resolve(import.meta.dir, "mock-bridge.ts")
  : resolve(import.meta.dir, "../packages/sandbox-bridge/src/cli.ts");
const bridges = new Map<string, BridgeEntry>();
const containersRoot = mkdtempSync(join(tmpdir(), "artfct-mock-sandbox-"));

/** The directory on this host that stands for the root of a sandbox's container. */
function sandboxRoot(sandboxId: string): string {
  return join(containersRoot, sandboxId);
}

/** Where a container path of a sandbox lives on this host. */
function hostPath(sandboxId: string, containerPath: string): string {
  return join(sandboxRoot(sandboxId), containerPath);
}

/** A pull request review ends its turn only once the smoke posts `/__release`. */
let reviewHeld = true;

const state = {
  starts: [] as Array<StartSpec & { at: string }>,
  envs: [] as Array<{ at: string; sandbox_id: string; keys: string[] }>,
  destroys: [] as Array<{ at: string; sandbox_id: string }>,
  exits: [] as BridgeExit[],
};

function log(line: string): void {
  console.log(`[mock-sandbox] ${line}`);
}

function now(): string {
  return new Date().toISOString();
}

/** The spec as recorded. Tokens are masked in every field that carries one. */
function maskedSpec(spec: StartSpec): StartSpec & { at: string } {
  return {
    at: now(),
    ...spec,
    token: "***",
    github_token: spec.github_token === null ? null : "***",
    bridge_env: Object.fromEntries(Object.keys(spec.bridge_env).map((name) => [name, "***"])),
  };
}

/** Marks the bridge as killed by this host and sends SIGTERM. */
function killBridge(entry: BridgeEntry): void {
  entry.killed = true;
  entry.process.kill();
}

/** Spawns the bridge for a start spec and records its exit when it ends. */
function spawnBridge(spec: StartSpec): BridgeEntry {
  const root = sandboxRoot(spec.sandbox_id);
  mkdirSync(root, { recursive: true });
  const dialUrl = spec.dial_url.replace(/^wss:/, "ws:");
  const bridge = Bun.spawn(
    [
      "bun",
      bridgeCli,
      "--harness",
      spec.harness,
      "--dial",
      dialUrl,
      "--cwd",
      process.cwd(),
      "--model",
      spec.model,
      "--generation",
      String(spec.generation),
    ],
    {
      env: {
        ...process.env,
        ...spec.env,
        ...spec.bridge_env,
        ARTFCT_MOCK_CONTROL_URL: controlUrl,
        ARTFCT_MOCK_SANDBOX_ROOT: root,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const entry: BridgeEntry = { process: bridge, generation: spec.generation, killed: false };
  void bridge.exited.then(() => {
    const code = bridge.exitCode;
    const signal = bridge.signalCode ?? null;
    log(`bridge ${spec.sandbox_id} gen=${spec.generation} exited code=${code} signal=${signal}`);
    state.exits.push({
      at: now(),
      sandbox_id: spec.sandbox_id,
      generation: spec.generation,
      code,
      signal,
      killed: entry.killed,
    });
    if (bridges.get(spec.sandbox_id) === entry) bridges.delete(spec.sandbox_id);
  });
  return entry;
}

/** Records the start, replaces any bridge for the same sandbox, and spawns a new one. */
function handleStart(spec: StartSpec): Response {
  state.starts.push(maskedSpec(spec));
  const previous = bridges.get(spec.sandbox_id);
  if (previous) killBridge(previous);
  log(
    `start ${spec.sandbox_id} gen=${spec.generation} harness=${spec.harness} dial=${spec.dial_url}`,
  );
  bridges.set(spec.sandbox_id, spawnBridge(spec));
  return Response.json({ ok: true });
}

/** Records the env keys. The mock bridge takes its env at spawn time so nothing is applied. */
function handleEnv(body: Record<string, unknown>): Response {
  const sandboxId = String(body.sandbox_id);
  const keys = Object.keys(body.env as object);
  state.envs.push({ at: now(), sandbox_id: sandboxId, keys });
  log(`env ${sandboxId} ${keys.join(",")}`);
  return Response.json({ ok: true });
}

/** Records the destroy, then kills and forgets the bridge and the files of the sandbox. */
function handleDestroy(body: Record<string, unknown>): Response {
  const sandboxId = String(body.sandbox_id);
  state.destroys.push({ at: now(), sandbox_id: sandboxId });
  log(`destroy ${sandboxId}`);
  const entry = bridges.get(sandboxId);
  if (entry) killBridge(entry);
  bridges.delete(sandboxId);
  rmSync(sandboxRoot(sandboxId), { recursive: true, force: true });
  return Response.json({ ok: true });
}

/** Serves the text of a file at a container path of the sandbox. */
async function handleRead(body: Record<string, unknown>): Promise<Response> {
  const sandboxId = String(body.sandbox_id);
  const path = String(body.path);
  const file = Bun.file(hostPath(sandboxId, path));
  log(`read ${sandboxId} ${path}`);
  if (!(await file.exists())) return new Response(`no file at ${path}`, { status: 404 });
  return new Response(await file.text());
}

/** Kills the bridge of one sandbox and nothing else. The orchestrator is not told. */
function handleKill(body: Record<string, unknown>): Response {
  const sandboxId = String(body.sandbox_id);
  const entry = bridges.get(sandboxId);
  if (!entry) return new Response("no bridge", { status: 404 });
  log(`kill ${sandboxId} gen=${entry.generation}`);
  killBridge(entry);
  bridges.delete(sandboxId);
  return Response.json({ ok: true });
}

/** Whether the bridge of the named sandbox and generation still runs on this host. */
function handleBridge(body: Record<string, unknown>): Response {
  const entry = bridges.get(String(body.sandbox_id));
  return Response.json({ running: entry?.generation === Number(body.generation) });
}

/** Lets every held pull request review end its turn. */
function handleRelease(): Response {
  reviewHeld = false;
  log("review released");
  return Response.json({ ok: true });
}

/** Kills every bridge, clears the record and every sandbox's files, and holds reviews again. */
function handleReset(): Response {
  for (const entry of bridges.values()) killBridge(entry);
  bridges.clear();
  rmSync(containersRoot, { recursive: true, force: true });
  mkdirSync(containersRoot);
  state.starts.length = 0;
  state.envs.length = 0;
  state.destroys.length = 0;
  state.exits.length = 0;
  reviewHeld = true;
  log("reset");
  return Response.json({ ok: true });
}

/** Routes one request. GET routes read the record. POST routes drive bridges. */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/__state") return Response.json(state);
  if (request.method === "GET" && url.pathname === "/starts") return Response.json(state.starts);
  if (request.method === "GET" && url.pathname === "/__hold") {
    return Response.json({ held: reviewHeld });
  }
  if (request.method !== "POST") return new Response("mock sandbox", { status: 200 });
  if (url.pathname === "/__reset") return handleReset();
  if (url.pathname === "/__release") return handleRelease();
  const body = (await request.json()) as Record<string, unknown>;
  switch (url.pathname) {
    case "/__kill":
      return handleKill(body);
    case "/start":
      return handleStart(body as StartSpec);
    case "/env":
      return handleEnv(body);
    case "/read":
      return handleRead(body);
    case "/destroy":
      return handleDestroy(body);
    case "/bridge":
      return handleBridge(body);
    default:
      return new Response("not found", { status: 404 });
  }
}

/** Kills every bridge so none outlives this host, and removes the sandbox files. */
function shutdown(): void {
  for (const entry of bridges.values()) killBridge(entry);
  bridges.clear();
  rmSync(containersRoot, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

Bun.serve({ port, fetch: handleRequest });
log(`listening on http://localhost:${port}`);
