import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** A skill name, which is also the name of its directory under `skills`. */
export const SkillRef = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** The file every skill directory holds. It is what a harness reads to learn the skill. */
export const SKILL_ENTRY = "SKILL.md";

/** The Agent Skills frontmatter, and no other key, so a skill works in any harness. */
export const SkillFrontmatter = z.strictObject({
  name: SkillRef,
  description: z.string().min(1),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  "allowed-tools": z.string().optional(),
});

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** The name a `SKILL.md` gives itself. */
export function parseSkillName(text: string): string {
  const matched = FRONTMATTER.exec(text);
  if (!matched) throw new Error("a SKILL.md starts with a --- frontmatter block");
  return SkillFrontmatter.parse(parseYaml(matched[1]!)).name;
}

/** The instructions of a `SKILL.md`, without its frontmatter. */
export function skillInstructions(text: string): string {
  return text.replace(FRONTMATTER, "").trim();
}
