import { describe, expect, it } from "bun:test";
import { parseSkillName, skillInstructions, SkillRef } from "./skill-frontmatter";

const ENTRY = ["---", "name: design", "description: Write a design.", "---", "", "Do it.", ""].join(
  "\n",
);

describe("parseSkillName", () => {
  it("reads the name a harness discovers it under", () => {
    expect(parseSkillName(ENTRY)).toBe("design");
  });

  it("refuses a frontmatter key the Agent Skills standard does not define", () => {
    expect(() => parseSkillName(ENTRY.replace("---\n\n", "sections: Plan\n---\n\n"))).toThrow();
  });

  it("takes the metadata the standard defines", () => {
    const text = ENTRY.replace("---\n\n", "metadata:\n  author: ao\n---\n\n");
    expect(parseSkillName(text)).toBe("design");
  });

  it("refuses a file that opens with no frontmatter", () => {
    expect(() => parseSkillName("Do it.\n")).toThrow(/frontmatter/);
  });

  it("refuses a name a skill directory cannot carry", () => {
    expect(() => parseSkillName(ENTRY.replace("name: design", "name: Design It"))).toThrow();
  });

  it("refuses a file that describes itself to no one", () => {
    expect(() =>
      parseSkillName(ENTRY.replace("description: Write a design.", "description: ''")),
    ).toThrow();
  });
});

describe("skillInstructions", () => {
  it("keeps the text after the frontmatter", () => {
    expect(skillInstructions(ENTRY)).toBe("Do it.");
  });
});

describe("SkillRef", () => {
  it("takes a skill name", () => {
    expect(SkillRef.parse("implement")).toBe("implement");
  });

  it("refuses a name that would reach outside the skills directory", () => {
    expect(() => SkillRef.parse("../../secrets")).toThrow();
  });
});
