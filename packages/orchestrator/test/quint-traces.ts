import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One sample of a spec setup: the spec folder, the setup module, and how many traces of how many steps. */
export type QuintTraceRequest = {
  spec: string;
  setup: string;
  count: number;
  steps: number;
  seed: number;
};

const SPEC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../spec");
const QUINT_CLI = createRequire(import.meta.url).resolve("@informalsystems/quint/dist/src/cli.js");

/**
 * The most traces one quint run samples. A quint run holds every trace it samples in memory, about
 * 3 MB each for the harness session, so a larger count runs as several seeded batches.
 */
const TRACES_PER_QUINT_RUN = 250;

/**
 * Sample traces of one spec setup with `quint run --mbt`, and read each trace's ITF JSON with
 * `readTrace`. Traces are read one at a time, so only one ITF document is in memory at once. The
 * run never blocks the event loop, so the vitest process keeps serving workerd while quint samples.
 */
export async function quintTraces<Trace>(
  request: QuintTraceRequest,
  readTrace: (itf: unknown) => Trace,
): Promise<Trace[]> {
  const traces: Trace[] = [];
  for (let batch = 0; batch * TRACES_PER_QUINT_RUN < request.count; batch++) {
    const count = Math.min(TRACES_PER_QUINT_RUN, request.count - batch * TRACES_PER_QUINT_RUN);
    traces.push(
      ...(await quintTraceBatch({ ...request, count, seed: request.seed + batch }, readTrace)),
    );
  }
  return traces;
}

async function quintTraceBatch<Trace>(
  request: QuintTraceRequest,
  readTrace: (itf: unknown) => Trace,
): Promise<Trace[]> {
  const directory = await mkdtemp(join(tmpdir(), `${request.spec}-`));
  try {
    await runQuint(request, directory);
    const files = (await readdir(directory)).toSorted(
      (left, right) => traceNumber(left) - traceNumber(right),
    );
    const traces: Trace[] = [];
    for (const file of files) {
      traces.push(readTrace(JSON.parse(await readFile(join(directory, file), "utf8"))));
    }
    return traces;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runQuint(
  { spec, setup, count, steps, seed }: QuintTraceRequest,
  directory: string,
): Promise<void> {
  const args = [
    QUINT_CLI,
    "run",
    join(SPEC_ROOT, spec, `${setup}.qnt`),
    `--main=${setup}`,
    "--backend=typescript",
    "--mbt",
    `--max-steps=${steps}`,
    `--max-samples=${count}`,
    `--n-traces=${count}`,
    `--seed=${seed}`,
    `--out-itf=${join(directory, "trace_{seq}.itf.json")}`,
  ];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`quint run failed for ${spec} ${setup}:\n${stdout}\n${stderr}`));
      else resolve();
    });
  });
}

/** Answer a replay test in workerd, which cannot run quint, with the traces its request names. */
export async function quintTracesService(request: Request): Promise<Response> {
  const sample: QuintTraceRequest = await request.json();
  return Response.json(await quintTraces(sample, (itf) => itf));
}

function traceNumber(file: string): number {
  return Number(file.replace(/\D/g, ""));
}
