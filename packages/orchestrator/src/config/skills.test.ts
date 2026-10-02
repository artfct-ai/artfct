import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import templateConfig from "../../test/template-config.json";
import { loadDeploymentConfig } from "./register-config";
import { SKILL_ENTRY } from "./skill-frontmatter";
import { loadSkills, loadHarnessSkills, skillPromptText } from "./skills";

const SKILLS_DIR = join(import.meta.dirname, "../../../../template/orchestrator/skills");

describe("loadSkills", () => {
  describe("one named skill", () => {
    it("loads that skill alone", () => {
      expect(loadSkills(["code-cleaner"]).map((skill) => skill.name)).toEqual(["code-cleaner"]);
    });

    it("carries every file of the directory as the repository holds it", () => {
      const [skill] = loadSkills(["code-cleaner"]);
      expect(skill?.files).toEqual([
        {
          path: SKILL_ENTRY,
          content: readFileSync(join(SKILLS_DIR, "code-cleaner", SKILL_ENTRY), "utf8"),
        },
      ]);
    });
  });

  describe("a skill whose text names others", () => {
    it("loads that skill alone", () => {
      expect(loadSkills(["design-review"]).map((skill) => skill.name)).toEqual(["design-review"]);
    });
  });

  describe("a name the deployment does not carry", () => {
    it("says which directory to write", () => {
      expect(() => loadSkills(["invent-it"])).toThrow(
        /the deployment has no skill invent-it\. Add skills\/invent-it\/SKILL\.md/,
      );
    });
  });
});

describe("skillPromptText", () => {
  describe("a skill with a preloaded skill", () => {
    const text = skillPromptText("breakdown", ["working-with-findings"]);

    it("holds the text of the skill", () => {
      expect(text).toContain("## Objective");
    });

    it("holds the text of the preloaded skill after it", () => {
      const applied = readFileSync(join(SKILLS_DIR, "working-with-findings", SKILL_ENTRY), "utf8");
      expect(text).toContain(applied.split("---\n").at(-1)!.trim());
    });

    it("leaves the frontmatter out", () => {
      expect(text).not.toContain("name: breakdown");
    });
  });
});

describe("the skills the template workflow definition names", () => {
  const { workflowDefinition } = loadDeploymentConfig(templateConfig);
  const named = workflowDefinition.stages.flatMap((stage) => [
    ...[stage.author.produce, ...(stage.author.revise ? [stage.author.revise] : [])].flatMap(
      (activity) => [
        activity.skill,
        ...(activity.execution === "model" ? activity.preload_skills : []),
      ],
    ),
    ...(stage.research ? [stage.research.skill] : []),
    ...stage.reviewers.map((reviewer) => reviewer.skill),
    ...stage.polishers.map((polisher) => polisher.skill),
  ]);

  it("names one for every stage and refiner", () => {
    expect(named.length).toBeGreaterThan(0);
  });

  it("has a skill for each", () => {
    expect(() => loadSkills(named)).not.toThrow();
  });
});

describe("loadHarnessSkills", () => {
  it("loads every skill directory of the template", () => {
    expect(
      loadHarnessSkills("design")
        .map((skill) => skill.name)
        .toSorted(),
    ).toEqual(readdirSync(SKILLS_DIR).toSorted());
  });

  it("refuses a task skill the deployment does not carry", () => {
    expect(() => loadHarnessSkills("invent-it")).toThrow(/invent-it/);
  });
});
