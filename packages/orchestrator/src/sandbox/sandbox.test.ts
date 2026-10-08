import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_READ_TOKEN_FILE,
  GITHUB_TOKEN_FILE,
  bridgeCommand,
  bridgeEnv,
  githubAuthScript,
  startupScript,
  type SandboxStartSpec,
} from "./spec";

function lines(script: string): string[] {
  return script.split("\n");
}

const spec: SandboxStartSpec = {
  sandbox_id: "wf_x.1",
  size: "large",
  workflow_id: "wf_x",
  task_id: "wf_x.1",
  harness: "claude-code",
  model: "claude-sonnet-5",
  dial_url: "wss://ao.example.com/bridge/wf_x/wf_x.1",
  token: "tok",
  generation: 2,
  workspace: "/workspace/repo",
  repo: {
    clone_url: "https://github.com/acme/app.git",
    branch: "artfct/wf_x-1-fix",
    author: { name: "acme-agent[bot]", email: "4242+acme-agent[bot]@users.noreply.github.com" },
  },
  github_token: "ghs_1",
  github_read: null,
  env: {},
  files: [],
  setup_commands: ["harness-tool init"],
  sleep_after_ms: 1_800_000,
  startup_timeout_ms: 600_000,
};

const CLONE_LINE =
  "if [ ! -d '/workspace/repo'/.git ]; then rm -rf '/workspace/repo.clone'; git clone --filter=blob:none \"$ARTFCT_CLONE_URL\" '/workspace/repo.clone'; rmdir '/workspace/repo'; mv '/workspace/repo.clone' '/workspace/repo'; fi";

describe("startupScript", () => {
  describe("a task on a branch of a repo, with a token", () => {
    const script = lines(startupScript(spec));

    it("starts with the strict shell options", () => {
      expect(script[0]).toBe("set -euo pipefail");
    });

    it("runs the harness setup commands before the clone", () => {
      expect(script.indexOf("harness-tool init")).toBeLessThan(script.indexOf(CLONE_LINE));
      expect(script).toContain("harness-tool init");
    });

    it("clones the repo from the env url", () => {
      expect(script).toContain(CLONE_LINE);
    });

    it("points the remote at the env url", () => {
      expect(script).toContain('git remote set-url origin "$ARTFCT_CLONE_URL"');
    });

    it("commits as the code host's account", () => {
      expect(script).toContain("git config user.name 'acme-agent[bot]'");
      expect(script).toContain(
        "git config user.email '4242+acme-agent[bot]@users.noreply.github.com'",
      );
    });

    it("checks the task branch out last", () => {
      expect(script.at(-1)).toMatch(/else git checkout -b 'artfct\/wf_x-1-fix'; fi$/);
    });

    it("checks out a branch the checkout already holds before it creates one", () => {
      expect(script.at(-1)).toContain(
        "elif git show-ref --verify --quiet 'refs/heads/artfct/wf_x-1-fix'; then git checkout 'artfct/wf_x-1-fix';",
      );
    });

    it("never embeds the token", () => {
      expect(script.some((line) => line.includes("ghs_1"))).toBe(false);
    });

    it("locks the token file down", () => {
      expect(script).toContain(`chmod 600 ${GITHUB_TOKEN_FILE}`);
    });

    it("logs gh in from the token file", () => {
      expect(script).toContain(
        `if command -v gh >/dev/null 2>&1; then gh auth login --with-token < ${GITHUB_TOKEN_FILE}; fi`,
      );
    });

    it("gives git a credential helper that reads the token file", () => {
      const helper = script.find((line) => line.startsWith("git config --global credential."));
      expect(helper).toContain(`cat ${GITHUB_TOKEN_FILE}`);
    });

    it("offers the token to github.com only", () => {
      expect(script.filter((line) => line.startsWith("git config --global credential."))).toEqual([
        expect.stringMatching(/^git config --global credential\.https:\/\/github\.com\.helper /),
      ]);
    });
  });

  describe("a branch whose name holds shell syntax", () => {
    const branch = "artfct/x;touch${IFS}/tmp/pwned";
    const script = lines(startupScript({ ...spec, repo: { ...spec.repo!, branch } }));

    it("passes the name to git as one quoted word", () => {
      expect(script.at(-1)).toContain("git checkout -b 'artfct/x;touch${IFS}/tmp/pwned'; fi");
    });

    it("never leaves the name bare", () => {
      expect(script.at(-1)).not.toContain(` ${branch}`);
    });
  });

  describe("a branch whose name holds a single quote", () => {
    it("closes the quote around it", () => {
      const script = lines(
        startupScript({ ...spec, repo: { ...spec.repo!, branch: "artfct/it's" } }),
      );
      expect(script.at(-1)).toContain("git checkout -b 'artfct/it'\\''s'; fi");
    });
  });

  describe("a repo without a branch", () => {
    const script = lines(startupScript({ ...spec, repo: { ...spec.repo!, branch: null } }));

    it("clones the repo", () => {
      expect(script).toContain(CLONE_LINE);
    });

    it("ends with the fetch", () => {
      expect(script.at(-1)).toBe("git fetch origin");
    });

    it("checks nothing out", () => {
      expect(script.some((line) => line.includes("git checkout"))).toBe(false);
    });
  });

  describe("a repo without a commit author", () => {
    it("leaves the git identity unset", () => {
      const script = lines(startupScript({ ...spec, repo: { ...spec.repo!, author: null } }));
      expect(script.some((line) => line.startsWith("git config user."))).toBe(false);
    });
  });

  describe("a repo without a token", () => {
    const script = lines(startupScript({ ...spec, github_token: null }));

    it("gives git no credential helper", () => {
      expect(script.some((line) => line.startsWith("git config --global credential."))).toBe(false);
    });

    it("never logs gh in", () => {
      expect(script.some((line) => line.includes("gh auth login"))).toBe(false);
    });
  });

  describe("a task with no repo", () => {
    it("only creates the workspace and runs the harness setup commands", () => {
      const script = lines(startupScript({ ...spec, repo: null, github_token: null }));
      expect(script).toEqual([
        "set -euo pipefail",
        "mkdir -p '/workspace/repo'",
        "harness-tool init",
      ]);
    });
  });

  describe("the script run against a local repository", () => {
    const root = mkdtempSync(join(tmpdir(), "artfct-startup-"));
    const origin = join(root, "origin");
    const workspace = join(root, "workspace", "repo");
    const scratch = `${workspace}.clone`;

    function git(args: string[], cwd: string): string {
      const result = spawnSync("git", args, { cwd, env: { PATH: process.env.PATH, HOME: root } });
      if (result.status !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    }

    function runStartup(cloneUrl: string) {
      const script = startupScript({
        ...spec,
        workspace,
        github_token: null,
        setup_commands: [],
        repo: { clone_url: cloneUrl, branch: null, author: null },
      });
      return spawnSync("bash", ["-c", script], {
        env: { PATH: process.env.PATH, HOME: root, ARTFCT_CLONE_URL: cloneUrl },
      });
    }

    beforeAll(() => {
      mkdirSync(origin);
      git(["init", "--quiet", "--initial-branch=main"], origin);
      git(["config", "uploadpack.allowFilter", "true"], origin);
      writeFileSync(join(origin, "README.md"), "hello\n");
      git(["add", "README.md"], origin);
      git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"], origin);
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    describe("a clone that fails", () => {
      it("leaves the workspace without a .git", () => {
        const result = runStartup(`file://${join(root, "missing")}`);
        expect(result.status).not.toBe(0);
        expect(existsSync(join(workspace, ".git"))).toBe(false);
      });
    });

    describe("a start after a clone that was killed part way", () => {
      beforeAll(() => {
        mkdirSync(join(scratch, ".git"), { recursive: true });
        writeFileSync(join(scratch, ".git", "HEAD"), "ref: refs/heads/partial\n");
      });

      it("clones again and checks out the files", () => {
        const result = runStartup(`file://${origin}`);
        expect(result.stderr.toString()).not.toContain("fatal");
        expect(result.status).toBe(0);
        expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("hello\n");
      });

      it("leaves no scratch clone behind", () => {
        expect(existsSync(scratch)).toBe(false);
      });

      it("keeps a blobless clone that fetches contents from origin", () => {
        expect(git(["config", "remote.origin.promisor"], workspace)).toBe("true");
        expect(git(["config", "remote.origin.partialclonefilter"], workspace)).toBe("blob:none");
      });
    });
  });
});

const READ = { token: "ghs_read", task_repo: "acme/app" };

describe("startupScript for a task that may read every repository", () => {
  const script = lines(startupScript({ ...spec, github_read: READ }));
  const credentialLines = script.filter((line) =>
    line.startsWith("git config --global credential."),
  );

  it("never embeds either token", () => {
    expect(script.some((line) => line.includes("ghs_1") || line.includes("ghs_read"))).toBe(false);
  });

  it("locks both token files down", () => {
    expect(script).toContain(`chmod 600 ${GITHUB_TOKEN_FILE} ${GITHUB_READ_TOKEN_FILE}`);
  });

  it("logs gh in from the task token file alone", () => {
    expect(script.filter((line) => line.includes("gh auth login"))).toEqual([
      `if command -v gh >/dev/null 2>&1; then gh auth login --with-token < ${GITHUB_TOKEN_FILE}; fi`,
    ]);
  });

  it("hands git the repository path and one helper, for github.com only", () => {
    expect(credentialLines).toEqual([
      "git config --global credential.https://github.com.useHttpPath true",
      expect.stringMatching(/^git config --global credential\.https:\/\/github\.com\.helper /),
    ]);
  });
});

describe("the git credential helper of a task that may read every repository", () => {
  let home: string;
  let configured: boolean;

  function fill(path: string): string {
    const input = `protocol=https\nhost=github.com\npath=${path}\n\n`;
    const result = spawnSync("git", ["credential", "fill"], {
      input,
      encoding: "utf8",
      env: gitEnv(),
    });
    expect(result.stderr).toBe("");
    return result.stdout;
  }

  function gitEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "artfct-credential-"));
    const taskFile = join(home, "github-token");
    const readFile = join(home, "github-read-token");
    writeFileSync(taskFile, "ghs_task");
    writeFileSync(readFile, "ghs_read");
    const configLines = lines(githubAuthScript(READ))
      .filter((line) => line.startsWith("git config --global credential."))
      .map((line) =>
        line.replaceAll(GITHUB_READ_TOKEN_FILE, readFile).replaceAll(GITHUB_TOKEN_FILE, taskFile),
      );
    const setup = spawnSync("sh", ["-c", ["set -e", ...configLines].join("\n")], {
      encoding: "utf8",
      env: gitEnv(),
    });
    configured = setup.status === 0;
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("configures git", () => {
    expect(configured).toBe(true);
  });

  it("answers the task token for the task's repository", () => {
    expect(fill("acme/app.git")).toContain("password=ghs_task\n");
  });

  it("answers the task token for the task's repository without the .git suffix", () => {
    expect(fill("acme/app")).toContain("password=ghs_task\n");
  });

  it("answers the read token for another repository of the owner", () => {
    expect(fill("acme/infra.git")).toContain("password=ghs_read\n");
  });

  it("answers the read token for a repository whose name extends the task's", () => {
    expect(fill("acme/app-docs.git")).toContain("password=ghs_read\n");
  });

  it("names the installation token user", () => {
    expect(fill("acme/infra.git")).toContain("username=x-access-token\n");
  });
});

describe("githubAuthScript", () => {
  const [shebang, ...auth] = lines(githubAuthScript(null));

  it("starts with the strict shell options", () => {
    expect(shebang).toBe("set -euo pipefail");
  });

  it("carries auth lines", () => {
    expect(auth.length).toBeGreaterThan(0);
  });

  it("runs the same auth lines the startup script runs", () => {
    const startup = lines(startupScript(spec));
    for (const line of auth) expect(startup).toContain(line);
  });
});

describe("bridgeCommand", () => {
  const command = bridgeCommand(spec);

  it("passes the harness", () => {
    expect(command).toContain("--harness 'claude-code'");
  });

  it("passes the dial url", () => {
    expect(command).toContain("--dial 'wss://ao.example.com/bridge/wf_x/wf_x.1'");
  });

  it("passes the workspace", () => {
    expect(command).toContain("--cwd '/workspace/repo'");
  });

  it("never carries the bridge token", () => {
    expect(command).not.toContain("tok");
  });

  it("passes the generation", () => {
    expect(command).toContain("--generation 2");
  });
});

describe("bridgeEnv", () => {
  it("hands the bridge its token through the environment", () => {
    expect(bridgeEnv(spec)).toEqual({ ARTFCT_TOKEN: "tok" });
  });
});
