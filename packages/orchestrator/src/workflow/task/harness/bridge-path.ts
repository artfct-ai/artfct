import type { TaskId, WorkflowId } from "../../../ids";

const BRIDGE_PATH = /^\/bridge\/([^/]+)\/([^/]+)$/;

/** The workflow and the task a bridge dial names. Null when the path is not a bridge path. */
export function parseBridgePath(
  pathname: string,
): { workflowId: WorkflowId; taskId: TaskId } | null {
  const match = BRIDGE_PATH.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { workflowId: match[1], taskId: match[2] };
}

/** WebSocket URL the bridge dials, derived from the ingress Worker's public origin. */
export function bridgeDialUrl(publicUrl: string, workflowId: WorkflowId, taskId: TaskId): string {
  const base = publicUrl.replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}/bridge/${workflowId}/${taskId}`;
}
