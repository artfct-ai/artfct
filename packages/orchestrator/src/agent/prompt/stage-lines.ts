import type { Config } from "../../config/config";
import { resolveStage, type ResolvedStage } from "../../config/stage";
import type { WorkflowDefinition } from "../../config/workflow-definition";

/** Where the author of a stage runs, and on which model it produces and revises. */
function authorLine({ produce, revise }: ResolvedStage["author"]): string {
  if (produce.execution === "harness") return `Harness ${produce.harness}, model ${produce.model}.`;
  const revises = revise.model === produce.model ? "" : ` It revises on model ${revise.model}.`;
  return `The author runs as model calls on model ${produce.model}.${revises}`;
}

/** The stages of a workflow definition under their heading, one line each, in order. */
export function stageLines(config: Config, definition: WorkflowDefinition): string[] {
  const stages = definition.stages.map((stage) => {
    const resolved = resolveStage(config, stage);
    const needsRepo = stage.branch ? ", needs a repository" : "";
    const when = stage.when ? ` Only when ${stage.when}.` : "";
    const research = resolved.research
      ? ` A researcher runs first on harness ${resolved.research.harness}, model ${resolved.research.model}.`
      : "";
    const choice =
      stage.ending === "choice"
        ? " Ends on a choice: its job completes only when a person's message selects one option listed on its page. Pass that option to complete_job."
        : "";
    return `- ${stage.name}: produces ${stage.artifact}${needsRepo}. ${authorLine(resolved.author)}${research}${choice}${when}`;
  });
  return ["## Stages (in order)", ...stages];
}
