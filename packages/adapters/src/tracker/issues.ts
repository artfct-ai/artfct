import type { StateType, TrackerIssue } from "./types";

/** True when the state means no more work happens on the issue. */
export function isFinishedState(type: StateType): boolean {
  return type === "completed" || type === "canceled";
}

/** Blockers that are not finished. Empty means the issue may start. */
export function unfinishedBlockers(issue: TrackerIssue): TrackerIssue["blockers"] {
  return issue.blockers.filter((blocker) => !isFinishedState(blocker.state.type));
}

/** Issues nobody works on whose blockers are all finished. */
export function readyIssues(issues: TrackerIssue[]): TrackerIssue[] {
  return issues.filter(
    (issue) =>
      (issue.state.type === "backlog" || issue.state.type === "unstarted") &&
      unfinishedBlockers(issue).length === 0,
  );
}
