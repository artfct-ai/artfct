import { resolveRefinerSettings, type TaskSettings } from "../../config/stage";
import { refinerAt, refinerIndexOf } from "../refiner/stage-refiner";
import type { TaskRow } from "../store/tasks";
import type { WorkflowRuntime } from "../types";

/**
 * The settings a task runs with: the produce activity for an author, the research step for a
 * researcher, the refiner entry for a refiner run. A step the config dropped runs on the author's
 * settings in a harness session.
 */
export function taskSettings(workflow: WorkflowRuntime, task: TaskRow): TaskSettings {
  const stage = workflow.stageForTask(task);
  const { produce } = stage.author;
  if (task.role === "author") return produce;
  if (task.role === "researcher") return stage.research ?? { ...produce, execution: "harness" };
  const refiner = refinerAt(stage, refinerIndexOf(task));
  if (!refiner) return { ...produce, execution: "harness" };
  return resolveRefinerSettings(workflow.config(), refiner.entry);
}
