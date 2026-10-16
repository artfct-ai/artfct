import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The programs that turn a Quint setup into a TLC model and check it. */
export type TlcTools = { tlaToolsJar: string; apalacheMc: string; tlaLibrary: string };

type PinnedDownload = { url: string; sha256: string; file: string };

const TOOLS_DIR = join(homedir(), ".quint", "tlc");

const TLA_TOOLS: PinnedDownload = {
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  file: "tla2tools-1.7.4.jar",
};

const APALACHE: PinnedDownload = {
  url: "https://github.com/apalache-mc/apalache/releases/download/v0.62.1/apalache.tgz",
  sha256: "38202a8c4ebeb3ab73e0fe5a7e4bb948442d46ad5de8a7fb45c9e5cac2beb2a6",
  file: "apalache-0.62.1.tgz",
};

const APALACHE_DIR = join(TOOLS_DIR, "apalache-0.62.1");

async function downloadPinned(download: PinnedDownload): Promise<string> {
  const path = join(TOOLS_DIR, download.file);
  if (existsSync(path)) return path;
  const response = await fetch(download.url);
  if (!response.ok) throw new Error(`Downloading ${download.url} failed with ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sha256 !== download.sha256) {
    throw new Error(`${download.url} has sha256 ${sha256}, not the pinned ${download.sha256}.`);
  }
  await Bun.write(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  return path;
}

async function runQuietly(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed.`);
}

async function unpackApalache(archive: string): Promise<void> {
  const unpacking = `${APALACHE_DIR}.part`;
  rmSync(unpacking, { recursive: true, force: true });
  mkdirSync(join(unpacking, "library"), { recursive: true });
  await runQuietly(["tar", "-xzf", archive, "-C", unpacking], TOOLS_DIR);
  const modules = ["Apalache.tla", "Variants.tla"].map(
    (name) => `tla2sany/StandardModules/${name}`,
  );
  await runQuietly(
    ["unzip", "-o", "-j", "apalache/lib/apalache.jar", ...modules, "-d", "library"],
    unpacking,
  );
  renameSync(unpacking, APALACHE_DIR);
}

/** Downloads the pinned TLA+ tools and Apalache once, checks their sha256, and returns their paths. */
export async function installTlcTools(): Promise<TlcTools> {
  mkdirSync(TOOLS_DIR, { recursive: true });
  const tlaToolsJar = await downloadPinned(TLA_TOOLS);
  if (!existsSync(APALACHE_DIR)) await unpackApalache(await downloadPinned(APALACHE));
  return {
    tlaToolsJar,
    apalacheMc: join(APALACHE_DIR, "apalache", "bin", "apalache-mc"),
    tlaLibrary: join(APALACHE_DIR, "library"),
  };
}
