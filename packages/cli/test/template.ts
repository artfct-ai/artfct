import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageTemplate } from "../src/init/packaged-template";

export const TEMPLATE_DIR = join(import.meta.dirname, "../../../template");

export function packagedTemplate(): string {
  const packagedDir = mkdtempSync(join(tmpdir(), "artfct-packaged-template-"));
  packageTemplate(TEMPLATE_DIR, packagedDir);
  return packagedDir;
}

export function copyTemplate(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "artfct-check-"));
  for (const entry of ["artfct.yaml", "workflows", "skills"]) {
    cpSync(join(TEMPLATE_DIR, "orchestrator", entry), join(repoDir, "orchestrator", entry), {
      recursive: true,
    });
  }
  return repoDir;
}
