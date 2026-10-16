#!/usr/bin/env bun
/**
 * Runs the checks that each spec folder's `checks.json` declares, for CI and the nightly run.
 * Usage, from the orchestrator package:
 *   bun scripts/spec/check-spec.ts setups
 *   bun scripts/spec/check-spec.ts witnesses <spec> <setup>
 *   bun scripts/spec/check-spec.ts simulate <spec> <setup> <samples>
 *   bun scripts/spec/check-spec.ts tlc <spec> <setup> <pr|nightly>
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSpecSetups, readSpecChecks, specDir, type TlcDepth } from "./checks";
import {
  boundedSetupSource,
  readTypecheckedModule,
  TLC_BOUND_VAL,
  TLC_MODEL_MODULE,
  tlcModel,
} from "./tlc-model";
import { installTlcTools } from "./tlc-tools";

const ORCHESTRATOR_DIR = join(import.meta.dirname, "../..");
const MAX_STEPS = 25;
const USAGE = [
  "usage: bun scripts/spec/check-spec.ts setups",
  "       bun scripts/spec/check-spec.ts witnesses <spec> <setup>",
  "       bun scripts/spec/check-spec.ts simulate <spec> <setup> <samples>",
  "       bun scripts/spec/check-spec.ts tlc <spec> <setup> <pr|nightly>",
].join("\n");

async function run(command: string[], options: { cwd?: string; stdout?: string } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? ORCHESTRATOR_DIR,
    stdout: options.stdout ? Bun.file(options.stdout) : "pipe",
    stderr: "inherit",
  });
  let output = "";
  if (child.stdout instanceof ReadableStream) {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      process.stdout.write(chunk);
      output += decoder.decode(chunk, { stream: true });
    }
  }
  return { exitCode: await child.exited, output };
}

function setupFile(spec: string, setup: string): string {
  return join(specDir(spec), `${setup}.qnt`);
}

function listSetups(): void {
  const setups = listSpecSetups().map(({ spec, setup }) => {
    const replay = [
      ...new Bun.Glob(`src/**/${spec}-replay.test{,.medium}.ts`).scanSync(ORCHESTRATOR_DIR),
    ];
    return {
      spec,
      setup,
      replay: replay[0] ?? "",
      tlc: Boolean(readSpecChecks(spec).tlc?.bounds[setup]),
    };
  });
  console.log(JSON.stringify(setups));
}

async function checkWitnesses(spec: string, setup: string): Promise<number> {
  const witnesses = readSpecChecks(spec).witnesses[setup] ?? [];
  const { exitCode, output } = await run([
    "bunx",
    "quint",
    "run",
    setupFile(spec, setup),
    `--main=${setup}`,
    "--max-samples=10000",
    `--max-steps=${MAX_STEPS}`,
    "--witnesses",
    ...witnesses,
  ]);
  if (exitCode !== 0) return exitCode;
  if (!output.includes("witnessed in 0 trace")) return 0;
  console.error(
    `\nA witness of ${setup} was never reached. Each one above with 0 traces needs a step that reaches it.`,
  );
  return 1;
}

async function simulate(spec: string, setup: string, samples: string): Promise<number> {
  const { exitCode } = await run([
    "bunx",
    "quint",
    "run",
    setupFile(spec, setup),
    `--main=${setup}`,
    "--backend=rust",
    `--max-samples=${samples}`,
    `--max-steps=${MAX_STEPS}`,
    "--invariants",
    ...readSpecChecks(spec).invariants,
  ]);
  return exitCode;
}

async function checkModel(spec: string, setup: string, depth: TlcDepth): Promise<number> {
  const checks = readSpecChecks(spec);
  const bounds = checks.tlc?.bounds[setup]?.[depth];
  if (!checks.tlc || !bounds)
    throw new Error(`${spec}/checks.json does not bound ${setup} for ${depth}.`);
  const tools = await installTlcTools();
  const work = mkdtempSync(join(tmpdir(), `tlc-${setup}-`));
  try {
    cpSync(specDir(spec), work, { recursive: true });
    const source = readFileSync(setupFile(spec, setup), "utf8");
    writeFileSync(join(work, `${setup}.qnt`), boundedSetupSource(source, bounds));
    const compiled = join(work, `${setup}.qnt.json`);
    const invariants = [...checks.invariants, TLC_BOUND_VAL].join(",");
    const compile = await run(
      [
        "bunx",
        "quint",
        "compile",
        join(work, `${setup}.qnt`),
        `--main=${setup}`,
        "--target=json",
        `--invariant=${invariants}`,
      ],
      { stdout: compiled },
    );
    if (compile.exitCode !== 0) return compile.exitCode;
    const typechecked = join(work, `${setup}_tc.tla`);
    const typecheck = await run(
      [tools.apalacheMc, "typecheck", `--output=${typechecked}`, compiled],
      { cwd: work, stdout: join(work, "typecheck.log") },
    );
    if (typecheck.exitCode !== 0) {
      console.error(readFileSync(join(work, "typecheck.log"), "utf8"));
      return typecheck.exitCode;
    }
    const model = tlcModel(
      readTypecheckedModule(readFileSync(typechecked, "utf8")),
      checks.tlc.ignoredVariables,
    );
    writeFileSync(join(work, `${TLC_MODEL_MODULE}.tla`), model.module);
    writeFileSync(join(work, `${TLC_MODEL_MODULE}.cfg`), model.config);
    console.log(`TLC checks ${setup} of ${spec} within ${JSON.stringify(bounds)}.`);
    const tlc = await run(
      [
        "java",
        "-XX:+UseParallelGC",
        `-DTLA-Library=${tools.tlaLibrary}`,
        "-cp",
        tools.tlaToolsJar,
        "tlc2.TLC",
        "-workers",
        "auto",
        "-deadlock",
        "-cleanup",
        "-metadir",
        join(work, "states"),
        TLC_MODEL_MODULE,
      ],
      { cwd: work },
    );
    if (tlc.exitCode === 0) return 0;
    console.error(
      [
        "",
        `TLC found a state of ${setup} that breaks an invariant, or it could not finish. The trace above is the shortest path to it.`,
        `Reproduce it from the orchestrator package: bun scripts/spec/check-spec.ts tlc ${spec} ${setup} ${depth}`,
      ].join("\n"),
    );
    return tlc.exitCode;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function isTlcDepth(value: string | undefined): value is TlcDepth {
  return value === "pr" || value === "nightly";
}

async function main(args: string[]): Promise<number> {
  const [command, spec, setup, detail] = args;
  if (command === "setups") {
    listSetups();
    return 0;
  }
  if (command === "witnesses" && spec && setup) return checkWitnesses(spec, setup);
  if (command === "simulate" && spec && setup && detail) return simulate(spec, setup, detail);
  if (command === "tlc" && spec && setup && isTlcDepth(detail))
    return checkModel(spec, setup, detail);
  console.error(USAGE);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
