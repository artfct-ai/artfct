import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SkillFile, Skill } from "@artfct-ai/adapters/harness/types";
import { loadDeploymentConfig } from "./register-config";
import { parseSkillName, SKILL_ENTRY, SkillRef } from "./skill-frontmatter";
import type { ConfigFiles } from "./types";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function isHidden(entry: Dirent): boolean {
  return entry.name.startsWith(".");
}

function readText(path: string): string {
  try {
    return UTF8.decode(readFileSync(path));
  } catch (error) {
    throw new Error(`${path} is not UTF-8 text, which is all a sandbox can receive`, {
      cause: error,
    });
  }
}

function declaredSkillName(path: string, text: string): string {
  try {
    return parseSkillName(text);
  } catch (error) {
    throw new Error(`${path} breaks the Agent Skills frontmatter rules`, { cause: error });
  }
}

function sortedVisibleEntries(directory: string): Dirent[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !isHidden(entry))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** The entries under a `skills` directory that the build step compiles, in order. */
export function listSkillEntries(skillsDir: string): Dirent[] {
  return sortedVisibleEntries(skillsDir);
}

/** Compile one entry under `skills`. Throws when the entry breaks a rule a skill must keep. */
export function compileSkill(skillsDir: string, entry: Dirent): Skill {
  if (!entry.isDirectory() || !SkillRef.safeParse(entry.name).success) {
    throw new Error(`${join(skillsDir, entry.name)} sits under skills but in no skill directory`);
  }
  const directory = join(skillsDir, entry.name);
  const files: SkillFile[] = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile() && !isHidden(file))
    .map((file) => relative(directory, join(file.parentPath, file.name)).split(sep).join("/"))
    .toSorted()
    .map((path) => ({ path, content: readText(join(directory, path)) }));
  const skillEntry = files.find((file) => file.path === SKILL_ENTRY);
  if (!skillEntry) throw new Error(`${directory} has no ${SKILL_ENTRY}`);
  const declaredName = declaredSkillName(join(directory, SKILL_ENTRY), skillEntry.content);
  if (declaredName !== entry.name)
    throw new Error(`${join(directory, SKILL_ENTRY)} names itself ${declaredName}`);
  return { name: entry.name, files };
}

const WORKFLOW_DEFINITION_EXTENSION = ".yaml";

/** Read `artfct.yaml` and each workflow definition under `workflows`, by the name its file gives it. */
export function readDeploymentConfig(
  configDir: string,
): Pick<ConfigFiles, "config" | "workflowDefinitions"> {
  const workflowsDir = join(configDir, "workflows");
  const workflowDefinitions = sortedVisibleEntries(workflowsDir).map((entry) => {
    const path = join(workflowsDir, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(WORKFLOW_DEFINITION_EXTENSION)) {
      throw new Error(`${path} sits under workflows but is not a workflow definition .yaml file`);
    }
    const name = entry.name.slice(0, -WORKFLOW_DEFINITION_EXTENSION.length);
    return { name, text: readText(path) };
  });
  return { config: readText(join(configDir, "artfct.yaml")), workflowDefinitions };
}

/**
 * The config build step of a deployment: read its orchestrator config directory, `artfct.yaml`,
 * `workflows`, `writing-rules.md`, and `skills`, into the value the Worker entrypoint passes to
 * `registerConfig`. Throws on a config the loader refuses.
 */
export function compileConfig(configDir: string): ConfigFiles {
  const deploymentConfig = readDeploymentConfig(configDir);
  loadDeploymentConfig(deploymentConfig);
  const skillsDir = join(configDir, "skills");
  return {
    ...deploymentConfig,
    writingRules: readText(join(configDir, "writing-rules.md")).trim(),
    skills: listSkillEntries(skillsDir).map((entry) => compileSkill(skillsDir, entry)),
  };
}
