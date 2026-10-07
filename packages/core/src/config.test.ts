import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileConfig } from "@artfct-ai/orchestrator/config/compile-config";

const TEMPLATE_DIR = join(import.meta.dirname, "../../../template/orchestrator");

const LOAD_UNDER_NODE = `
const { loadConfig, loadWorkflowDefinition, parseSkillName } = await import("@artfct-ai/core/config");
const config = loadConfig("adapters: { documents: { provider: notion } }");
const definition = loadWorkflowDefinition("development", "description: Write designs.\\nstages:\\n  - { name: design, artifact: page, author: { produce: { execution: harness, skill: design } } }");
const skill = parseSkillName("---\\nname: design\\ndescription: Write a design.\\n---\\n");
console.log(JSON.stringify({ docs: config.adapters.documents.provider, stages: definition.stages.map((stage) => stage.name), skill }));
`;

const COMPILE_UNDER_NODE = `
const { compileConfig } = await import("@artfct-ai/core/config");
console.log(JSON.stringify(compileConfig(process.argv[1])));
`;

describe("the built config export", () => {
  it("loads under plain Node", () => {
    const output = execFileSync("node", ["--input-type=module", "--eval", LOAD_UNDER_NODE], {
      cwd: import.meta.dirname,
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({ docs: "notion", stages: ["design"], skill: "design" });
  });

  it("compiles the template outside any git checkout under plain Node", () => {
    const root = mkdtempSync(join(tmpdir(), "artfct-deployment-"));
    for (const entry of ["artfct.yaml", "workflows", "writing-rules.md", "skills"]) {
      cpSync(join(TEMPLATE_DIR, entry), join(root, "repo", entry), { recursive: true });
    }
    const output = execFileSync(
      "node",
      ["--input-type=module", "--eval", COMPILE_UNDER_NODE, join(root, "repo")],
      { cwd: import.meta.dirname, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    rmSync(root, { recursive: true, force: true });
    expect(JSON.parse(output)).toEqual(compileConfig(TEMPLATE_DIR));
  });
});
