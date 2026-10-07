import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadDeploymentConfig, readDeploymentConfig } from "@artfct-ai/core/config";
import { readDevVar } from "../dev-vars";
import type { CheckOutcome } from "./types";

type DocumentsProvider = Config["adapters"]["documents"]["provider"];

/**
 * The secret that holds each document host's credential. Null for Linear, whose credential is
 * the Linear install the orchestrator stores after the first deploy.
 */
const DOCUMENTS_SECRET: Record<DocumentsProvider, string | null> = {
  notion: "NOTION_TOKEN",
  linear: null,
};

/**
 * Warn when `orchestrator/.dev.vars` leaves the document host's credential empty. Without it the
 * orchestrator has no document host and refuses every stage that writes a page.
 */
export function checkDocumentsCredential(configDir: string): CheckOutcome {
  const { config, workflowDefinition } = loadDeploymentConfig(readDeploymentConfig(configDir));
  const secret = DOCUMENTS_SECRET[config.adapters.documents.provider];
  if (!secret) {
    return { outcome: "skipped", detail: "Linear documents use the Linear install" };
  }
  const devVarsPath = join(configDir, ".dev.vars");
  if (!existsSync(devVarsPath)) {
    return { outcome: "skipped", detail: "orchestrator/.dev.vars is missing" };
  }
  if (readDevVar(readFileSync(devVarsPath, "utf8"), secret)) {
    return { outcome: "passed", detail: `${secret} is set` };
  }
  const pageStages = workflowDefinition.stages
    .filter((stage) => stage.artifact === "page")
    .map((stage) => stage.name);
  if (pageStages.length === 0) {
    return { outcome: "passed", detail: `${secret} is empty, and no stage writes a page` };
  }
  return {
    outcome: "warned",
    problems: [
      `${secret} is empty in orchestrator/.dev.vars. The orchestrator refuses to start the stages that write a page: ${pageStages.join(", ")}`,
    ],
  };
}
