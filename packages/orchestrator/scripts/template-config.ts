import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { compileConfig } from "../src/config/compile-config";

const TEMPLATE_DIR = join(import.meta.dirname, "../../../template/orchestrator");

/** The template's `artfct.yaml` without its `access` placeholders, so a local run lets everyone in. */
function withoutAccess(config: string): string {
  const document = parseDocument(config);
  document.delete("access");
  return document.toString();
}

const template = compileConfig(TEMPLATE_DIR);
writeFileSync(
  join(import.meta.dirname, "../test/template-config.json"),
  JSON.stringify({ ...template, config: withoutAccess(template.config) }),
);
