import type { Skill } from "@artfct-ai/adapters/harness/types";
import { registeredConfig } from "./register-config";
import { SKILL_ENTRY, skillInstructions } from "./skill-frontmatter";

function findSkill(skills: readonly Skill[], name: string): Skill {
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill)
    throw new Error(`the deployment has no skill ${name}. Add skills/${name}/${SKILL_ENTRY}`);
  return skill;
}

/**
 * Every skill of the deployment for a harness session, the task's skill first, so it can name
 * the others. Fails when the task's skill is not among them.
 */
export function loadHarnessSkills(taskSkill: string): Skill[] {
  const { skills } = registeredConfig();
  const first = findSkill(skills, taskSkill);
  return [first, ...skills.filter((skill) => skill !== first)];
}

/** The deployment skills with the given names, in that order. Fails on an unknown name. */
export function loadSkills(names: readonly string[]): Skill[] {
  const { skills } = registeredConfig();
  return names.map((name) => findSkill(skills, name));
}

/**
 * The system prompt of a model call: the `SKILL.md` text of its skill, then of each preloaded
 * skill, without frontmatter.
 */
export function skillPromptText(name: string, preloadSkills: readonly string[]): string {
  return loadSkills([name, ...preloadSkills])
    .map((skill) => skill.files.find((file) => file.path === SKILL_ENTRY)!.content)
    .map(skillInstructions)
    .join("\n\n");
}
