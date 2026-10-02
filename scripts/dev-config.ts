/** Writes dev and smoke configs for wrangler from each Worker's test config. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type WorkerName = "orchestrator" | "ingress";
type Mode = "dev" | "smoke";
type Config = Record<string, unknown> & { vars?: Record<string, string> };

const PACKAGES_DIR = resolve(import.meta.dir, "../packages");

/** The orchestrator Worker entry each mode runs, in place of the one its test config names. */
const ORCHESTRATOR_ENTRY: Record<Mode, string> = {
  dev: "test/dev-worker.ts",
  smoke: "test/smoke-worker.ts",
};

/** Converts JSONC text to JSON by removing line comments and trailing commas. */
function jsoncToJson(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

function readConfig(worker: WorkerName): Config {
  const text = readFileSync(resolve(PACKAGES_DIR, worker, "wrangler.test.jsonc"), "utf8");
  return JSON.parse(jsoncToJson(text)) as Config;
}

/** Points the paths wrangler resolves against the config file back at the Worker's package directory. */
function relocate(config: Config): void {
  config.main = `../../${config.main as string}`;
  for (const database of (config.d1_databases as Array<Record<string, unknown>>) ?? []) {
    database.migrations_dir = `../../${database.migrations_dir as string}`;
  }
}

/** Copies `.dev.vars` beside the generated config without the keys that `vars` overrides. */
function copyDevVars(worker: WorkerName, targetDir: string, vars: Record<string, string>): void {
  const source = resolve(PACKAGES_DIR, worker, ".dev.vars");
  if (!existsSync(source)) return;
  const kept = readFileSync(source, "utf8")
    .split("\n")
    .filter((line) => {
      const key = line.match(/^([A-Z_]+)=/)?.[1];
      return key === undefined || !(key in vars);
    });
  writeFileSync(resolve(targetDir, ".dev.vars"), kept.join("\n"));
}

/** Writes the config for `worker` with `vars` as its vars and returns the path. Mode `dev` also copies `.dev.vars`. */
export function writeDevConfig(
  worker: WorkerName,
  vars: Record<string, string>,
  mode: Mode,
): string {
  const config = readConfig(worker);
  config.vars = { ...config.vars, ...vars };
  if (worker === "orchestrator") config.main = ORCHESTRATOR_ENTRY[mode];
  relocate(config);
  const target = resolve(PACKAGES_DIR, worker, `.wrangler/${mode}/wrangler.jsonc`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(config, null, 2));
  if (mode === "dev") copyDevVars(worker, dirname(target), vars);
  return target;
}

/** Parses `KEY=value` arguments. Values may contain `=`. Arguments without a key are skipped. */
function parseVarArgs(args: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const arg of args) {
    const [key, ...valueParts] = arg.split("=");
    if (key) vars[key] = valueParts.join("=");
  }
  return vars;
}

if (import.meta.main) {
  console.log(writeDevConfig("orchestrator", parseVarArgs(process.argv.slice(2)), "dev"));
}
