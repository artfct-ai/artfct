import type { HarnessAdapter, HarnessFile, Skill } from "./types";

/** Files that install each skill directory whole under `<skillsDir>/<name>/`. */
export function harnessSkillFiles(
  harness: HarnessAdapter,
  skills: readonly Skill[],
): HarnessFile[] {
  return skills.flatMap((skill) =>
    skill.files.map((file) => ({
      path: `${harness.skillsDir}/${skill.name}/${file.path}`,
      content: file.content,
    })),
  );
}
