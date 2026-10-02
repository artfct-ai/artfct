import type { SandboxRef, SandboxSize } from "../../../sandbox/spec";
import type { TaskRow } from "../../store/tasks";
import type { TaskRole } from "../events";

const SIZE_OF_ROLE: Record<TaskRole, SandboxSize> = {
  author: "large",
  polisher: "small",
  researcher: "small",
  reviewer: "small",
};

/** The sandbox size a task of a role runs in. The author gets the large one. */
export function sandboxSizeOf(role: TaskRole): SandboxSize {
  return SIZE_OF_ROLE[role];
}

/** The sandbox of a task as the provider addresses it. */
export function sandboxRefOf(task: TaskRow): SandboxRef {
  return { id: task.task_id, size: sandboxSizeOf(task.role) };
}
