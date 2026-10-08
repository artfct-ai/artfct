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
  /** Read token for every other repository. Null unless `read_all_repos` is on. */
  github_read: GithubReadCredential | null;
  env: Record<string, string>;
  /** Files the harness reads, written before the startup script runs. */
  files: HarnessFile[];
  /** Shell commands of the harness. The startup script runs them after the files are written. */
  setup_commands: string[];
  sleep_after_ms: number;
  /** How long the startup script may run before the start fails. */
  startup_timeout_ms: number;
};

/**
 * A read-only GitHub token for every repository the installation reaches, written to
 * `GITHUB_READ_TOKEN_FILE`. Git uses it for every github.com repository except `task_repo`.
 */
export type GithubReadCredential = { token: string; task_repo: string };

/** Where the sandbox keeps the current GitHub tokens. Rewritten on every refresh. */
export const GITHUB_TOKEN_DIR = `${SANDBOX_HOME}/.config/artfct`;
export const GITHUB_TOKEN_FILE = `${GITHUB_TOKEN_DIR}/github-token`;
export const GITHUB_READ_TOKEN_FILE = `${GITHUB_TOKEN_DIR}/github-read-token`;

/**
 * Shell script the sandbox runs before starting the bridge. Runs the harness setup commands,
 * clones the repository, and checks out the task branch when the task has one. The clone skips
 * file contents. Git fetches the contents of a file version when a command first reads it.
 */
export function startupScript(spec: SandboxStartSpec): string {
  const lines = ["set -euo pipefail", `mkdir -p ${shellQuote(spec.workspace)}`];
  lines.push(...spec.setup_commands);
  if (spec.github_token) lines.push(...githubAuthLines(spec.github_read));
  if (spec.repo) lines.push(...checkoutLines(spec.workspace, spec.repo));
  return lines.join("\n");
}

/** Shell script that makes git and gh read the token files. Runs at start and on every refresh. */
export function githubAuthScript(read: GithubReadCredential | null): string {
  return ["set -euo pipefail", ...githubAuthLines(read)].join("\n");
}

/**
 * Point git at a credential helper that reads the token files, and log gh in with the task
 * token alone.
 */
function githubAuthLines(read: GithubReadCredential | null): string[] {
  const ghLogin = `if command -v gh >/dev/null 2>&1; then gh auth login --with-token < ${GITHUB_TOKEN_FILE}; fi`;
  if (!read) {
    const helper = `!f() { echo username=x-access-token; echo "password=$(cat ${GITHUB_TOKEN_FILE})"; }; f`;
    return [
      `chmod 600 ${GITHUB_TOKEN_FILE}`,
      `git config --global credential.https://github.com.helper '${helper}'`,
      ghLogin,
    ];
  }
  return [
    `chmod 600 ${GITHUB_TOKEN_FILE} ${GITHUB_READ_TOKEN_FILE}`,
    "git config --global credential.https://github.com.useHttpPath true",
    `git config --global credential.https://github.com.helper ${shellQuote(routingCredentialHelper(read.task_repo))}`,
    ghLogin,
  ];
}

/**
 * A git credential helper that answers with the task token for the task's repository and with
 * the read token for any other. Git passes it the repository path because of `useHttpPath`.
 */
function routingCredentialHelper(taskRepo: string): string {
  const taskPaths = `${shellQuote(taskRepo)}|${shellQuote(`${taskRepo}.git`)}`;
  return [
    "!f() {",
    "repo_path=;",
    'while IFS= read -r line; do case "$line" in path=*) repo_path="${line#path=}";; esac; done;',
    `case "$repo_path" in ${taskPaths}) token_file=${GITHUB_TOKEN_FILE};; *) token_file=${GITHUB_READ_TOKEN_FILE};; esac;`,
    "echo username=x-access-token;",
    'echo "password=$(cat "$token_file")";',
    "}; f",
  ].join(" ");
}

function checkoutLines(workspace: string, repo: NonNullable<SandboxStartSpec["repo"]>): string[] {
  const dir = shellQuote(workspace);
  const lines = [
    `if [ ! -d ${dir}/.git ]; then ${cloneCommands(workspace)}; fi`,
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
 * Clone into a scratch directory and move it into the empty workspace once the checkout is done.
 * A clone that dies part way leaves the workspace without a `.git`, so the next start clones again.
 */
function cloneCommands(workspace: string): string {
  const dir = shellQuote(workspace);
  const scratch = shellQuote(`${workspace}.clone`);
  return [
    `rm -rf ${scratch}`,
    `git clone --filter=blob:none "$ARTFCT_CLONE_URL" ${scratch}`,
    `rmdir ${dir}`,
    `mv ${scratch} ${dir}`,
  ].join("; ");
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
