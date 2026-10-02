import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileConfig } from "./compile-config";

const CONFIG_YAML = "providers: { docs: notion }\n";

const WORKFLOW_DEFINITION_YAML =
  "description: Write designs.\nstages:\n  - { name: design, artifact: page, author: { produce: { execution: harness, skill: design } } }\n";

function skillEntry(name: string): string {
  return `---\nname: ${name}\ndescription: Do the work.\n---\n\nDo the ${name} work.\n`;
}

let repo: string;

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "deployment-"));
  write("artfct.yaml", CONFIG_YAML);
  write("workflows/development.yaml", WORKFLOW_DEFINITION_YAML);
  write("writing-rules.md", "\nWrite short sentences.\n\n");
  write("skills/design/SKILL.md", skillEntry("design"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("compileConfig", () => {
  it("carries artfct.yaml as the repo holds it", () => {
    expect(compileConfig(repo).config).toBe(CONFIG_YAML);
  });

  it("carries each workflow definition as the repo holds it, under its file name", () => {
    expect(compileConfig(repo).workflowDefinitions).toEqual([
      { name: "development", text: WORKFLOW_DEFINITION_YAML },
    ]);
  });

  it("leaves hidden files under workflows out", () => {
    write("workflows/.DS_Store", "finder");
    expect(compileConfig(repo).workflowDefinitions.map((definition) => definition.name)).toEqual([
      "development",
    ]);
  });

  it("refuses a file under workflows that is not a .yaml file", () => {
    write("workflows/incident.yml", WORKFLOW_DEFINITION_YAML);
    expect(() => compileConfig(repo)).toThrow(
      /incident\.yml sits under workflows but is not a workflow definition \.yaml file/,
    );
  });

  it("refuses a second workflow definition", () => {
    write("workflows/incident.yaml", WORKFLOW_DEFINITION_YAML);
    expect(() => compileConfig(repo)).toThrow(
      /Multiple workflow definitions are not supported yet/,
    );
  });

  it("refuses a workflow definition whose file name is not a valid name", () => {
    rmSync(join(repo, "workflows/development.yaml"));
    write("workflows/Incident Response.yaml", WORKFLOW_DEFINITION_YAML);
    expect(() => compileConfig(repo)).toThrow(/workflows\/Incident Response\.yaml/);
  });

  it("refuses a repo without a workflows directory", () => {
    rmSync(join(repo, "workflows"), { recursive: true });
    expect(() => compileConfig(repo)).toThrow(/workflows/);
  });

  it("trims the writing rules", () => {
    expect(compileConfig(repo).writingRules).toBe("Write short sentences.");
  });

  it("carries every file of each skill directory at its path inside the directory", () => {
    write("skills/pdf-processing/SKILL.md", skillEntry("pdf-processing"));
    write("skills/pdf-processing/scripts/fill_form.py", "print('fill')\n");
    write("skills/pdf-processing/FORMS.md", "Fill the form.\n");
    expect(compileConfig(repo).skills).toEqual([
      { name: "design", files: [{ path: "SKILL.md", content: skillEntry("design") }] },
      {
        name: "pdf-processing",
        files: [
          { path: "FORMS.md", content: "Fill the form.\n" },
          { path: "SKILL.md", content: skillEntry("pdf-processing") },
          { path: "scripts/fill_form.py", content: "print('fill')\n" },
        ],
      },
    ]);
  });

  it("keeps a file whose name leaves ASCII", () => {
    write("skills/design/café.md", "Fill the form.\n");
    expect(compileConfig(repo).skills[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "café.md",
    ]);
  });

  it("leaves hidden files out", () => {
    write(".DS_Store", "finder");
    write("skills/.DS_Store", "finder");
    write("skills/design/.DS_Store", "finder");
    expect(compileConfig(repo).skills).toEqual([
      { name: "design", files: [{ path: "SKILL.md", content: skillEntry("design") }] },
    ]);
  });

  it("refuses a file that sits in no skill directory", () => {
    write("skills/loose.md", "Loose.\n");
    expect(() => compileConfig(repo)).toThrow(
      /loose\.md sits under skills but in no skill directory/,
    );
  });

  it("refuses a skill directory without a SKILL.md", () => {
    write("skills/plan/NOTES.md", "Notes.\n");
    expect(() => compileConfig(repo)).toThrow(/plan has no SKILL\.md/);
  });

  it("refuses a SKILL.md that names another skill", () => {
    write("skills/plan/SKILL.md", skillEntry("design"));
    expect(() => compileConfig(repo)).toThrow(/plan\/SKILL\.md names itself design/);
  });

  it("refuses a SKILL.md that breaks the frontmatter rules and keeps the schema error", () => {
    write("skills/design/SKILL.md", "---\nname: design\ndescription: Do it.\nversion: 2\n---\n");
    expect(() => compileConfig(repo)).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /design\/SKILL\.md breaks the Agent Skills frontmatter rules/,
        ),
        cause: expect.objectContaining({ name: "ZodError" }),
      }),
    );
  });

  it("refuses a file that is not UTF-8 text", () => {
    write("skills/design/logo.png", new Uint8Array([0xff, 0xfe, 0x00]));
    expect(() => compileConfig(repo)).toThrow(/logo\.png is not UTF-8 text/);
  });

  it("refuses an artfct.yaml that still lists stages", () => {
    write("artfct.yaml", WORKFLOW_DEFINITION_YAML.replace("description: Write designs.\n", ""));
    expect(() => compileConfig(repo)).toThrow(/artfct\.yaml breaks the config schema/);
  });
});

describe("the template", () => {
  const templateDir = join(import.meta.dirname, "../../../../template/orchestrator");

  it("compiles every skill directory", () => {
    const skillsDir = join(templateDir, "skills");
    expect(compileConfig(templateDir).skills.map((skill) => skill.name)).toEqual(
      readdirSync(skillsDir).toSorted((left, right) => left.localeCompare(right)),
    );
  });
});
