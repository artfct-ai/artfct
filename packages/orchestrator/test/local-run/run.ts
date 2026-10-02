/**
 * Runs the author, a reviewer, or a polisher of one configured stage in a local container,
 * against a real artifact on its host. It uses the production config, skills, prompts, harness
 * setup, and start spec. Usage is in the README.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { registerConfig } from "../../src/config/register-config";
import { producePagePrompt } from "../../src/prompts/model-author-prompt";
import templateConfig from "../template-config.json";
import { startLocalContainer } from "./container";
import { planLocalRun } from "./plan";
import { runLocalSession } from "./session";

registerConfig(templateConfig);

const OUTPUT_ROOT = join(import.meta.dirname, "../../../../.local-runs");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    title: { type: "string" },
    request: { type: "string", default: "" },
    brief: { type: "string", default: "" },
    repo: { type: "string" },
    branch: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const [stage, role, artifactUrl] = positionals;
if (!stage || !role || !values.title) {
  console.error(
    'usage: bun run local-run <stage> <role> [artifact-url] --title "..." [--request "..."] [--brief "..."] [--repo owner/name] [--branch name] [--dry-run]',
  );
  process.exit(2);
}

const plan = await planLocalRun(
  {
    stage,
    role,
    artifactUrl: artifactUrl ?? null,
    title: values.title,
    request: values.request,
    brief: values.brief,
    repoFull: values.repo ?? null,
    branch: values.branch ?? null,
  },
  process.env,
);
if ("error" in plan) {
  console.error(plan.error);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = join(OUTPUT_ROOT, `${stamp}-${stage}-${role.replaceAll(" ", "-")}`);

if (plan.execution === "model") {
  const { model, system, subject } = plan.produce;
  if (values["dry-run"]) {
    console.log(`model call on ${plan.modelName}\n\n${system}`);
    process.exit(0);
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "system.md"), system);
  console.log(`model call on ${plan.modelName}. Output in ${outputDir}`);
  const { generateText } = await import("ai");
  const result = await generateText({ model, system, prompt: producePagePrompt(subject) });
  const document = result.text.trim();
  writeFileSync(join(outputDir, "document.md"), document);
  console.log(`\n${document}`);
  process.exit(0);
}

if (values["dry-run"]) {
  const files = plan.spec.files.map((file) => file.path).join(", ");
  const envNames = Object.keys(plan.spec.env).join(", ");
  console.log(
    `command: ${plan.command.command.join(" ")}\neffort: ${plan.effort}\nfiles: ${files}`,
  );
  console.log(`env names: ${envNames}`);
  console.log(
    `MCP: ${plan.mcpServers.map((server) => server.name).join(", ")}\n\n${plan.firstPrompt}`,
  );
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "first-prompt.md"), plan.firstPrompt);
console.log(`${plan.spec.harness} on ${plan.spec.model}. Output in ${outputDir}`);

const container = await startLocalContainer(plan.spec);
try {
  const turn = await runLocalSession({
    child: container.spawnHarness(plan.command.command, plan.command.env),
    cwd: plan.spec.workspace,
    mcpServers: plan.mcpServers,
    effort: plan.effort,
    prompt: plan.firstPrompt,
    onActivity: (line) => console.log(line),
  });
  const lines = turn.updates.map((update) => JSON.stringify(update));
  writeFileSync(join(outputDir, "updates.jsonl"), lines.join("\n"));
  writeFileSync(join(outputDir, "closing.md"), turn.text);
  console.log(`\nstop reason: ${turn.stopReason}\n\n${turn.text}`);
} finally {
  await container.destroy();
}
