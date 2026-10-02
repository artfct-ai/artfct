import type { ArtifactKind } from "@artfct-ai/contracts/types";

/**
 * What a task is for. A `researcher` task extracts a research payload before the author starts.
 * An `author` task produces the artifact of its job. A `reviewer` task reads that artifact from
 * its own context and sandbox and reports on it. A `polisher` task changes that artifact in
 * place. Neither refiner role owns anything.
 */
export type TaskRole = "author" | "researcher" | "reviewer" | "polisher";

/** Events the Workflow DO emits to channel adapters. */
export type TaskEvent =
  | { type: "started"; stage: string; job_id: string }
  | { type: "progress"; task_id: string; text: string }
  | { type: "question"; task_id?: string; text: string }
  | {
      type: "artifact_ready";
      job_id: string;
      artifact_kind: ArtifactKind;
      url: string;
      /** The one line the humans read. It already carries the url. */
      text: string;
    }
  | { type: "failed"; job_id: string; reason: string }
  | { type: "workflow_failed"; reason: string }
  | { type: "done"; result: string }
  | { type: "status"; text: string }
  | { type: "info"; text: string };
