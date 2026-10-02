import { describe, expect, it } from "bun:test";
import { harnessAdapter } from "./clients";
import { harnessSkillFiles } from "./skills";
import { HARNESSES, SANDBOX_HOME, type Skill } from "./types";

const skills: Skill[] = [
  {
    name: "pdf-processing",
    files: [
      { path: "SKILL.md", content: "---\nname: pdf-processing\n---\nDo it.\n" },
      { path: "FORMS.md", content: "# Forms\n" },
      { path: "scripts/fill_form.py", content: "print('filled')\n" },
    ],
  },
  { name: "plan", files: [{ path: "SKILL.md", content: "---\nname: plan\n---\nPlan it.\n" }] },
];

describe("harnessSkillFiles", () => {
  describe("claude-code", () => {
    const files = harnessSkillFiles(harnessAdapter("claude-code"), skills);

    it("writes every file of every skill under the user-scoped directory", () => {
      expect(files.map((file) => file.path)).toEqual([
        `${SANDBOX_HOME}/.claude/skills/pdf-processing/SKILL.md`,
        `${SANDBOX_HOME}/.claude/skills/pdf-processing/FORMS.md`,
        `${SANDBOX_HOME}/.claude/skills/pdf-processing/scripts/fill_form.py`,
        `${SANDBOX_HOME}/.claude/skills/plan/SKILL.md`,
      ]);
    });

    it("keeps a nested file at the path it holds inside the skill directory", () => {
      const nested = files.find((file) => file.path.endsWith("fill_form.py"));
      expect(nested?.content).toBe("print('filled')\n");
    });

    it("writes the markdown as it is, frontmatter included", () => {
      expect(files[0]?.content).toBe(skills[0]!.files[0]!.content);
    });
  });

  it("writes opencode's under its own config directory", () => {
    const files = harnessSkillFiles(harnessAdapter("opencode"), skills);
    expect(files[0]?.path).toBe(`${SANDBOX_HOME}/.config/opencode/skills/pdf-processing/SKILL.md`);
  });

  it("installs a skill that is only a SKILL.md", () => {
    const files = harnessSkillFiles(harnessAdapter("claude-code"), [skills[1]!]);
    expect(files.map((file) => file.path)).toEqual([
      `${SANDBOX_HOME}/.claude/skills/plan/SKILL.md`,
    ]);
  });

  it("keeps every harness's skills under the sandbox home", () => {
    for (const harness of HARNESSES) {
      const files = harnessSkillFiles(harnessAdapter(harness), skills);
      for (const file of files) expect(file.path.startsWith(`${SANDBOX_HOME}/`)).toBe(true);
    }
  });
});

describe("invokeSkill", () => {
  it("names the Skill tool for claude-code", () => {
    expect(harnessAdapter("claude-code").invokeSkill("design")).toContain("Skill tool");
  });

  it("names the skill tool for opencode", () => {
    expect(harnessAdapter("opencode").invokeSkill("design")).toContain("skill tool");
  });

  it("names the skill on every harness", () => {
    for (const harness of HARNESSES) {
      expect(harnessAdapter(harness).invokeSkill("design")).toContain("design");
    }
  });
});
