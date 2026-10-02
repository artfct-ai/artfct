import type { CommitAuthor } from "@artfct-ai/adapters/code/types";
import { SANDBOX_HOME, type HarnessFile } from "@artfct-ai/adapters/harness/types";

/** How much compute a sandbox has. `small` has 2 vCPU and `large` has 4. */
export type SandboxSize = "small" | "large";

/** One sandbox as a provider addresses it. */
export type SandboxRef = { id: string; size: SandboxSize };

/** Everything a sandbox needs to clone the repo and start the bridge. */
export type SandboxStartSpec = {
  sandbox_id: string;
  size: SandboxSize;
  workflow_id: string;
  task_id: string;
  harness: string;
  model: string;
  dial_url: string;
  token: string;
  generation: number;
  workspace: string;
  /**
   * The clone URL carries no credentials. A null branch leaves the checkout on the default
   * branch. A null author leaves git without an identity, which happens only without a code host.
   */
  repo: { clone_url: string; branch: string | null; author: CommitAuthor | null } | null;
  /** GitHub installation token, written to `GITHUB_TOKEN_FILE`. Null without GitHub credentials. */
  github_token: string | null;
  env: Record<string, string>;
  /** Files the harness reads, written before the startup script runs. */
  files: HarnessFile[];
  /** Shell commands of the harness. The startup script runs them after the files are written. */
  setup_commands: string[];
  sleep_after_ms: number;
};

/** Where the sandbox keeps the current GitHub token. Rewritten on every refresh. */
export const GITHUB_TOKEN_DIR = `${SANDBOX_HOME}/.config/artfct`;
export const GITHUB_TOKEN_FILE = `${GITHUB_TOKEN_DIR}/github-token`;

/**
 * Shell script the sandbox runs before starting the bridge. Runs the harness setup commands,
 * clones the repository, and checks out the task branch when the task has one.
 */
export function startupScript(spec: SandboxStartSpec): string {
  const lines = ["set -euo pipefail", `mkdir -p ${shellQuote(spec.workspace)}`];
  lines.push(...spec.setup_commands);
  if (spec.github_token) lines.push(...githubAuthLines());
  if (spec.repo) lines.push(...checkoutLines(spec.workspace, spec.repo));
  return lines.join("\n");
}

/** Shell script that makes git and gh read the token file. Runs at start and on every refresh. */
export function githubAuthScript(): string {
  return ["set -euo pipefail", ...githubAuthLines()].join("\n");
}

/** Point git at a credential helper that reads the token file, and log gh in with it. */
function githubAuthLines(): string[] {
  const helper = `!f() { echo username=x-access-token; echo "password=$(cat ${GITHUB_TOKEN_FILE})"; }; f`;
  return [
    `chmod 600 ${GITHUB_TOKEN_FILE}`,
    `git config --global credential.https://github.com.helper '${helper}'`,
    `if command -v gh >/dev/null 2>&1; then gh auth login --with-token < ${GITHUB_TOKEN_FILE}; fi`,
  ];
}

function checkoutLines(workspace: string, repo: NonNullable<SandboxStartSpec["repo"]>): string[] {
  const dir = shellQuote(workspace);
  const lines = [
    `if [ ! -d ${dir}/.git ]; then git clone "$ARTFCT_CLONE_URL" ${dir}; fi`,
    `cd ${dir}`,
    `git remote set-url origin "$ARTFCT_CLONE_URL"`,
  ];
  if (repo.author) {
    lines.push(`git config user.name ${shellQuote(repo.author.name)}`);
    lines.push(`git config user.email ${shellQuote(repo.author.email)}`);
  }
  lines.push(`git fetch origin`);
  if (repo.branch) lines.push(branchLine(repo.branch));
  return lines;
}

/**
 * Check out the task branch. A container that restarts may already hold it locally. Create it
 * from the default branch when neither the remote nor the checkout has it.
 */
function branchLine(branch: string): string {
  const name = shellQuote(branch);
  const ref = shellQuote(`refs/heads/${branch}`);
  return `if git ls-remote --exit-code --heads origin ${name} >/dev/null 2>&1; then git checkout ${name}; git pull --ff-only origin ${name}; elif git show-ref --verify --quiet ${ref}; then git checkout ${name}; else git checkout -b ${name}; fi`;
}

/** Command line that starts the bridge inside the sandbox. The token goes in `bridgeEnv`. */
export function bridgeCommand(spec: SandboxStartSpec): string {
  return [
    "artfct-bridge",
    `--harness ${shellQuote(spec.harness)}`,
    `--dial ${shellQuote(spec.dial_url)}`,
    `--cwd ${shellQuote(spec.workspace)}`,
    `--model ${shellQuote(spec.model)}`,
    `--generation ${spec.generation}`,
  ].join(" ");
}

/** Environment of the bridge process alone. It keeps the token off the command line. */
export function bridgeEnv(spec: SandboxStartSpec): Record<string, string> {
  return { ARTFCT_TOKEN: spec.token };
}

/** One shell word that holds the value as is. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
