import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Config } from "drizzle-kit";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const DRIZZLE_KIT_BIN = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const CONFIG_FILES = readdirSync(PACKAGE_DIR).filter((file) => /^drizzle\..+\.config\.ts$/.test(file));

async function migrationsDirOf(configFile: string): Promise<string> {
  const config: Config = (await import(join(PACKAGE_DIR, configFile))).default;
  if (config.out === undefined) throw new Error(`${configFile} does not set out`);
  return join(PACKAGE_DIR, config.out);
}

function journalEntriesOf(migrationsDir: string): JournalEntry[] {
  return JSON.parse(readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8")).entries;
}

test.each(CONFIG_FILES)(
  "%s journal lists its migrations in index and timestamp order",
  async (configFile) => {
    const entries = journalEntriesOf(await migrationsDirOf(configFile));
    const outOfOrder = entries.filter((entry, position) => {
      const previous = entries[position - 1];
      return entry.idx !== position || (previous !== undefined && entry.when <= previous.when);
    });
    expect(outOfOrder).toEqual([]);
  },
);

test.each(CONFIG_FILES)("%s schema matches its migrations", async (configFile) => {
  const migrationsDir = await migrationsDirOf(configFile);
  const scratchDir = mkdtempSync(join(tmpdir(), "drizzle-drift-"));
  try {
    const scratchMigrationsDir = join(scratchDir, "migrations");
    cpSync(migrationsDir, scratchMigrationsDir, { recursive: true });
    const scratchConfig = join(scratchDir, "drizzle.config.ts");
    writeFileSync(
      scratchConfig,
      `import config from ${JSON.stringify(join(PACKAGE_DIR, configFile))};\n` +
        `export default { ...config, out: ${JSON.stringify(relative(PACKAGE_DIR, scratchMigrationsDir))} };\n`,
    );
    const generate = spawnSync(
      process.execPath,
      [DRIZZLE_KIT_BIN, "generate", "--config", scratchConfig],
      { cwd: PACKAGE_DIR, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    expect({ status: generate.status, stderr: generate.stderr }).toEqual({ status: 0, stderr: "" });
    const committedFiles = new Set(readdirSync(migrationsDir, { recursive: true, encoding: "utf8" }));
    const generatedFiles = readdirSync(scratchMigrationsDir, { recursive: true, encoding: "utf8" })
      .filter((file) => !committedFiles.has(file));
    expect(generatedFiles).toEqual([]);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
