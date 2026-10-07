import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTemplate, TEMPLATE_DIR } from "../../test/template";
import { formatChecksReport, runChecks } from "./check";
import type { RunWrangler } from "./types";

const loggedIn: RunWrangler = async () => ({
  exitCode: 0,
  stdout: '{"loggedIn":true}',
  stderr: "",
});

const repoDirs: string[] = [];

function templateCopy(): string {
  const repoDir = copyTemplate();
  repoDirs.push(repoDir);
  return repoDir;
}

const ACCESS_BLOCK = /^access:\n(?: .*\n)+/m;

function templateCopyWithAccess(access: string): string {
  const repoDir = templateCopy();
  const configFile = join(repoDir, "orchestrator/artfct.yaml");
  writeFileSync(configFile, readFileSync(configFile, "utf8").replace(ACCESS_BLOCK, access));
  return repoDir;
}

async function accessReport(repoDir: string) {
  const reports = await runChecks({ repoDir, runWrangler: loggedIn });
  return reports.find((report) => report.check === "access");
}

async function documentsReport(repoDir: string) {
  const reports = await runChecks({ repoDir, runWrangler: loggedIn });
  return reports.find((report) => report.check === "documents credential");
}

function templateCopyWithDevVars(devVars: string): string {
  const repoDir = templateCopy();
  writeFileSync(join(repoDir, "orchestrator/.dev.vars"), devVars);
  return repoDir;
}

afterEach(() => {
  for (const repoDir of repoDirs.splice(0)) rmSync(repoDir, { recursive: true, force: true });
});

describe("runChecks", () => {
  it("passes every check on the template but its access placeholders", async () => {
    const reports = await runChecks({
      repoDir: TEMPLATE_DIR,
      runWrangler: loggedIn,
    });
    expect(reports.map((report) => [report.check, report.outcome])).toEqual([
      ["Cloudflare credential", "passed"],
      ["config", "passed"],
      ["documents credential", "skipped"],
      ["access", "failed"],
      ["skills", "passed"],
      ["sandbox image", "passed"],
    ]);
  });

  it("names each access placeholder the template ships", async () => {
    expect(await accessReport(TEMPLATE_DIR)).toEqual({
      check: "access",
      outcome: "failed",
      problems: [
        'access.tracker_team is "<team key>", which is not a team key or id. Set it to your team, or delete the line',
        'access.chat_team is "<team id>", which is not a team key or id. Set it to your team, or delete the line',
        "Delete the whole access block to let in everyone who reaches the bot",
      ],
    });
  });

  it("passes a tracker team beside a deleted chat team line", async () => {
    const repoDir = templateCopyWithAccess("access:\n  tracker_team: ENG\n");
    expect(await accessReport(repoDir)).toEqual({
      check: "access",
      outcome: "passed",
      detail: "limited to tracker_team ENG",
    });
  });

  it("passes both teams", async () => {
    const repoDir = templateCopyWithAccess(
      "access:\n  tracker_team: 9cfb482a-81e3-4154-b5b9-2c805e70a02d\n  chat_team: T0123ABCD\n",
    );
    expect((await accessReport(repoDir))?.outcome).toBe("passed");
  });

  it("fails a chat team placeholder left beside a set tracker team", async () => {
    const repoDir = templateCopyWithAccess(
      "access:\n  tracker_team: ENG\n  chat_team: <your Slack workspace id>\n",
    );
    expect((await accessReport(repoDir))?.outcome).toBe("failed");
  });

  it("passes a deleted access block and says nobody is kept out", async () => {
    const repoDir = templateCopyWithAccess("");
    expect(await accessReport(repoDir)).toEqual({
      check: "access",
      outcome: "passed",
      detail: "not limited to a team. Everyone who reaches the bot is let in",
    });
  });

  it("reports an access key the schema does not know", async () => {
    const repoDir = templateCopyWithAccess("access:\n  slack_team: T0123ABCD\n");
    const reports = await runChecks({ repoDir, runWrangler: loggedIn });
    expect(formatChecksReport(reports)).toContain("artfct.yaml breaks the config schema");
  });

  it("names the workflow definition and its stage count on the template", async () => {
    const reports = await runChecks({
      repoDir: TEMPLATE_DIR,
      runWrangler: loggedIn,
    });
    expect(reports.find((report) => report.check === "config")).toEqual({
      check: "config",
      outcome: "passed",
      detail: "workflow definition development with 5 stages",
    });
  });

  it("reports a workflow definition the schema rejects, and names its file", async () => {
    const repoDir = templateCopy();
    writeFileSync(join(repoDir, "orchestrator/workflows/development.yaml"), "stages: []\n");
    const reports = await runChecks({
      repoDir,
      runWrangler: loggedIn,
    });
    const config = reports.find((report) => report.check === "config");
    expect(config?.outcome).toBe("failed");
    const report = formatChecksReport(reports);
    expect(report).toContain("workflows/development.yaml breaks the config schema");
    expect(report).toContain("description");
  });

  it("reports an artfct.yaml that still lists stages", async () => {
    const repoDir = templateCopy();
    writeFileSync(
      join(repoDir, "orchestrator/artfct.yaml"),
      "stages:\n  - { name: implement, artifact: pull, author: { produce: { execution: harness, skill: implement } } }\n",
    );
    const reports = await runChecks({
      repoDir,
      runWrangler: loggedIn,
    });
    const report = formatChecksReport(reports);
    expect(report).toContain("artfct.yaml breaks the config schema");
    expect(report).toContain("stages");
  });

  it("reports a second workflow definition as not supported yet", async () => {
    const repoDir = templateCopy();
    copyFileSync(
      join(repoDir, "orchestrator/workflows/development.yaml"),
      join(repoDir, "orchestrator/workflows/incident.yaml"),
    );
    const reports = await runChecks({
      repoDir,
      runWrangler: loggedIn,
    });
    expect(formatChecksReport(reports)).toContain(
      "Multiple workflow definitions are not supported yet",
    );
  });

  it("reports each skill that breaks the frontmatter rules", async () => {
    const repoDir = templateCopy();
    writeFileSync(
      join(repoDir, "orchestrator/skills/design/SKILL.md"),
      "---\nname: design\ndescription: Write a design.\nversion: 2\n---\nWrite it.\n",
    );
    writeFileSync(
      join(repoDir, "orchestrator/skills/plan/SKILL.md"),
      "---\nname: planner\ndescription: Write a plan.\n---\nWrite it.\n",
    );
    mkdirSync(join(repoDir, "orchestrator/skills/empty"));
    writeFileSync(
      join(repoDir, "orchestrator/skills/research/logo.png"),
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
    writeFileSync(join(repoDir, "orchestrator/skills/README.md"), "Our skills.\n");
    const reports = await runChecks({
      repoDir,
      runWrangler: loggedIn,
    });
    const skills = reports.find((report) => report.check === "skills");
    expect(skills?.outcome).toBe("failed");
    const problems = skills?.outcome === "failed" ? skills.problems : [];
    expect(problems).toHaveLength(5);
    expect(problems[0]).toStartWith(
      `${join(repoDir, "orchestrator/skills/design/SKILL.md")} breaks the Agent Skills frontmatter rules\n`,
    );
    expect(problems[0]).toContain("version");
    expect(problems[1]).toBe(`${join(repoDir, "orchestrator/skills/empty")} has no SKILL.md`);
    expect(problems[2]).toBe(
      `${join(repoDir, "orchestrator/skills/plan/SKILL.md")} names itself planner`,
    );
    expect(problems[3]).toBe(
      `${join(repoDir, "orchestrator/skills/README.md")} sits under skills but in no skill directory`,
    );
    expect(problems[4]).toStartWith(
      `${join(repoDir, "orchestrator/skills/research/logo.png")} is not UTF-8 text`,
    );
  });

  it("reports a failed Cloudflare check beside the outcome of the other checks", async () => {
    const reports = await runChecks({
      repoDir: TEMPLATE_DIR,
      runWrangler: async () => ({ exitCode: 1, stdout: '{"loggedIn":false}', stderr: "" }),
    });
    expect(
      reports.filter((report) => report.outcome === "failed").map((report) => report.check),
    ).toEqual(["Cloudflare credential", "access"]);
  });

  it("reports a wrangler that does not start", async () => {
    const reports = await runChecks({
      repoDir: TEMPLATE_DIR,
      runWrangler: async () => {
        throw new Error("spawn npx ENOENT");
      },
    });
    expect(reports[0]).toEqual({
      check: "Cloudflare credential",
      outcome: "failed",
      problems: ["spawn npx ENOENT"],
    });
  });

  it("reports every file check as failed outside a deployment repo", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "artfct-check-"));
    repoDirs.push(repoDir);
    const reports = await runChecks({
      repoDir,
      runWrangler: loggedIn,
    });
    expect(reports.map((report) => report.outcome)).toEqual([
      "passed",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
  });

  it("skips the Cloudflare credential offline and runs the other checks", async () => {
    const reports = await runChecks({ repoDir: TEMPLATE_DIR, runWrangler: null });
    expect(reports[0]).toEqual({
      check: "Cloudflare credential",
      outcome: "skipped",
      detail: "--offline skips it",
    });
    expect(reports.find((report) => report.check === "config")?.outcome).toBe("passed");
  });
});

describe("the documents credential check", () => {
  it("warns on an empty Notion token and names each stage that writes a page", async () => {
    const repoDir = templateCopyWithDevVars("SLACK_BOT_TOKEN=xoxb-1\nNOTION_TOKEN=\n");
    expect(await documentsReport(repoDir)).toEqual({
      check: "documents credential",
      outcome: "warned",
      problems: [
        "NOTION_TOKEN is empty in orchestrator/.dev.vars. The orchestrator refuses to start the stages that write a page: architectural directions, design, plan",
      ],
    });
  });

  it("warns on a .dev.vars without a Notion token line", async () => {
    const repoDir = templateCopyWithDevVars("SLACK_BOT_TOKEN=xoxb-1\n");
    expect((await documentsReport(repoDir))?.outcome).toBe("warned");
  });

  it("passes a set Notion token", async () => {
    const repoDir = templateCopyWithDevVars("NOTION_TOKEN=ntn_123\n");
    expect(await documentsReport(repoDir)).toEqual({
      check: "documents credential",
      outcome: "passed",
      detail: "NOTION_TOKEN is set",
    });
  });

  it("skips Linear documents, which use the Linear install", async () => {
    const repoDir = templateCopyWithDevVars("NOTION_TOKEN=\n");
    const configFile = join(repoDir, "orchestrator/artfct.yaml");
    writeFileSync(
      configFile,
      readFileSync(configFile, "utf8").replace(/provider: notion/, "provider: linear"),
    );
    expect(await documentsReport(repoDir)).toEqual({
      check: "documents credential",
      outcome: "skipped",
      detail: "Linear documents use the Linear install",
    });
  });
});

describe("formatChecksReport", () => {
  it("prints one line per check and indents each problem line", () => {
    expect(
      formatChecksReport([
        { check: "skills", outcome: "passed", detail: "2 skills" },
        { check: "Cloudflare credential", outcome: "skipped", detail: "--offline skips it" },
        { check: "documents credential", outcome: "warned", problems: ["empty"] },
        { check: "config", outcome: "failed", problems: ["first\nsecond"] },
      ]),
    ).toBe(
      "ok    skills: 2 skills\nskip  Cloudflare credential: --offline skips it\nWARN  documents credential\n      empty\nFAIL  config\n      first\n      second\n",
    );
  });
});
