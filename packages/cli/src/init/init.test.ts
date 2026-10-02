import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_DIR, packagedTemplate } from "../../test/template";
import { formatInitReport, runInit } from "./init";
import type { InitEnvironment } from "./types";

const COPY_STEP = "Copy the template into the deployment repo";
const DATABASE_STEP = "Create the D1 database and write its id into the orchestrator config";
const CREATE_DATABASE =
  "d1 create artfct --binding DB --update-config --config orchestrator/wrangler.jsonc";

const PACKAGED_TEMPLATE = packagedTemplate();
const repoDirs: string[] = [];

afterEach(() => {
  for (const repoDir of repoDirs.splice(0)) rmSync(repoDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(PACKAGED_TEMPLATE, { recursive: true, force: true });
});

function emptyRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "artfct-init-"));
  repoDirs.push(repoDir);
  return repoDir;
}

function environment(repoDir: string, wranglerExitCode = 0) {
  const steps: string[] = [];
  const wranglerCalls: string[] = [];
  const init: InitEnvironment = {
    repoDir,
    templateDir: PACKAGED_TEMPLATE,
    runWrangler: async (args) => {
      wranglerCalls.push(args.join(" "));
      return wranglerExitCode;
    },
    announceStep: (step) => steps.push(step),
  };
  return { init, steps, wranglerCalls };
}

describe("the packaged template", () => {
  it("leaves out what git ignores in the template", () => {
    expect(readdirSync(PACKAGED_TEMPLATE).toSorted()).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "gitignore",
      "ingress",
      "orchestrator",
      "package.json",
    ]);
  });
});

describe("runInit", () => {
  describe("in an empty directory", () => {
    it("reports done", async () => {
      expect(await runInit(environment(emptyRepo()).init)).toEqual({ outcome: "done" });
    });

    it("copies the template", async () => {
      const repoDir = emptyRepo();
      await runInit(environment(repoDir).init);
      const copied = [
        "package.json",
        "AGENTS.md",
        "orchestrator/artfct.yaml",
        "orchestrator/workflows/development.yaml",
        "orchestrator/skills/implement/SKILL.md",
        "orchestrator/.dev.vars.example",
        "ingress/wrangler.jsonc",
      ].filter((entry) => existsSync(join(repoDir, entry)));
      expect(copied).toHaveLength(7);
    });

    it("writes the template's ignore rules to .gitignore", async () => {
      const repoDir = emptyRepo();
      await runInit(environment(repoDir).init);
      expect(readFileSync(join(repoDir, ".gitignore"), "utf8")).toBe(
        readFileSync(join(TEMPLATE_DIR, ".gitignore"), "utf8"),
      );
    });

    it("creates the database with wrangler and nothing else", async () => {
      const run = environment(emptyRepo());
      await runInit(run.init);
      expect(run.wranglerCalls).toEqual([CREATE_DATABASE]);
    });

    it("announces each step before it runs", async () => {
      const run = environment(emptyRepo());
      await runInit(run.init);
      expect(run.steps).toEqual([COPY_STEP, DATABASE_STEP]);
    });

    it("installs nothing", async () => {
      const repoDir = emptyRepo();
      await runInit(environment(repoDir).init);
      expect(existsSync(join(repoDir, "node_modules"))).toBe(false);
    });

    it("leaves the directory outside git", async () => {
      const repoDir = emptyRepo();
      await runInit(environment(repoDir).init);
      expect(existsSync(join(repoDir, ".git"))).toBe(false);
    });
  });

  describe("in a directory that already has a template file", () => {
    it("fails at the copy and names the file", async () => {
      const repoDir = emptyRepo();
      writeFileSync(join(repoDir, "package.json"), "{}");
      expect(await runInit(environment(repoDir).init)).toEqual({
        outcome: "failed",
        step: COPY_STEP,
        problem: "The deployment repo already has package.json.",
        recovery: "Run artfct init again in a directory without those entries.",
      });
    });

    it("keeps the file", async () => {
      const repoDir = emptyRepo();
      writeFileSync(join(repoDir, "package.json"), "{}");
      await runInit(environment(repoDir).init);
      expect(readFileSync(join(repoDir, "package.json"), "utf8")).toBe("{}");
    });

    it("copies nothing next to it", async () => {
      const repoDir = emptyRepo();
      writeFileSync(join(repoDir, "package.json"), "{}");
      await runInit(environment(repoDir).init);
      expect(readdirSync(repoDir)).toEqual(["package.json"]);
    });

    it("does not run wrangler", async () => {
      const repoDir = emptyRepo();
      writeFileSync(join(repoDir, "package.json"), "{}");
      const run = environment(repoDir);
      await runInit(run.init);
      expect(run.wranglerCalls).toEqual([]);
    });
  });

  describe("in a directory that already has a .gitignore", () => {
    it("names it as .gitignore", async () => {
      const repoDir = emptyRepo();
      writeFileSync(join(repoDir, ".gitignore"), "dist\n");
      expect(await runInit(environment(repoDir).init)).toMatchObject({
        problem: "The deployment repo already has .gitignore.",
      });
    });
  });

  describe("when wrangler fails to create the database", () => {
    it("reports the command to run by hand", async () => {
      expect(await runInit(environment(emptyRepo(), 1).init)).toEqual({
        outcome: "failed",
        step: DATABASE_STEP,
        problem: "wrangler d1 create exited with 1.",
        recovery: `Fix the problem, then create the database by hand:\nwrangler ${CREATE_DATABASE}`,
      });
    });
  });
});

describe("formatInitReport", () => {
  it("prints the failed step with its problem and recovery indented under it", () => {
    expect(
      formatInitReport({
        outcome: "failed",
        step: DATABASE_STEP,
        problem: "wrangler d1 create exited with 1.",
        recovery: "Fix the problem, then create the database by hand:\nwrangler d1 create",
      }),
    ).toBe(
      `FAIL  ${DATABASE_STEP}\n      wrangler d1 create exited with 1.\n      Fix the problem, then create the database by hand:\n      wrangler d1 create\n`,
    );
  });

  it("points at the install guide when init is done", () => {
    expect(formatInitReport({ outcome: "done" })).toContain("docs/index.md");
  });

  it("leaves the install and the commit to the person", () => {
    expect(formatInitReport({ outcome: "done" })).toContain("with your package manager");
  });
});
