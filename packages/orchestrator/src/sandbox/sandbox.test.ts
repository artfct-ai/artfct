import { describe, expect, it } from "bun:test";
import {
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
  env: {},
  files: [],
  setup_commands: ["harness-tool init"],
  sleep_after_ms: 1_800_000,
};

const CLONE_LINE =
  "if [ ! -d '/workspace/repo'/.git ]; then git clone \"$ARTFCT_CLONE_URL\" '/workspace/repo'; fi";

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
});

describe("githubAuthScript", () => {
  const [shebang, ...auth] = lines(githubAuthScript());

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
