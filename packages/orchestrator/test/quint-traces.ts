import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/** Sample traces of one spec setup with `quint run --mbt`. Each trace is its ITF JSON. */
export function quintTraces({ spec, setup, count, steps, seed }: QuintTraceRequest): unknown[] {
  const directory = mkdtempSync(join(tmpdir(), `${spec}-`));
  try {
    const quint = spawnSync(
      process.execPath,
      [
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
      ],
      { encoding: "utf8" },
    );
    if (quint.status !== 0) {
      throw new Error(`quint run failed for ${spec} ${setup}:\n${quint.stdout}\n${quint.stderr}`);
    }
    return readdirSync(directory)
      .toSorted((left, right) => traceNumber(left) - traceNumber(right))
      .map((file): unknown => JSON.parse(readFileSync(join(directory, file), "utf8")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Answer a replay test in workerd, which cannot run quint, with the traces its request names. */
export async function quintTracesService(request: Request): Promise<Response> {
  const sample: QuintTraceRequest = await request.json();
  return Response.json(quintTraces(sample));
}

function traceNumber(file: string): number {
  return Number(file.replace(/\D/g, ""));
}
