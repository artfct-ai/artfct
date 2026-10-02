import { join } from "node:path";
import { compileSkill, listSkillEntries } from "@artfct-ai/core/config";
import { describeError } from "../describe-error";
import type { CheckOutcome } from "./types";

/** Compile every entry under `skills` the way the build step does, and report each that fails. */
export function checkSkills(configDir: string): CheckOutcome {
  const skillsDir = join(configDir, "skills");
  const entries = listSkillEntries(skillsDir);
  const problems: string[] = [];
  for (const entry of entries) {
    try {
      compileSkill(skillsDir, entry);
    } catch (error) {
      problems.push(describeError(error));
    }
  }
  if (problems.length > 0) return { outcome: "failed", problems };
  return { outcome: "passed", detail: `${entries.length} skills` };
}
