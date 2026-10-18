import type { TrackerIssue, TrackerProject } from "@artfct-ai/adapters/tracker/types";

/** The issue a tracker-origin world starts from, and the subject issue of every world that has one. */
export const SUBJECT_ISSUE_KEY = "ENG-100";

/** The tracker project of a world whose subject is a project. It holds the subject issue and its sub-issues. */
export const WORLD_PROJECT: TrackerProject = {
  id: "proj-1",
  name: "Login",
  url: "https://linear.app/acme/project/login-a1b2c3",
};

const PROJECT_SLUG = "a1b2c3";

/** How many sub-issues and stray issues a world's tracker holds of each. */
const ISSUES_OF_EACH = 25;

/** The key of a sub-issue of the subject issue, numbered from 0. */
export function subIssueKey(index: number): string {
  return `ENG-${110 + index}`;
}

/** The key of an issue that is neither the subject issue, one of its sub-issues, nor in the project. */
export function strayIssueKey(index: number): string {
  return `ENG-${400 + index}`;
}

/** The link the tracker shows for an issue of a world. */
export function worldIssueUrl(key: string): string {
  return `https://linear.app/acme/issue/${key}/fix-login`;
}

function worldIssue(key: string, place: { parent_id: string | null; project_id: string | null }) {
  const issue: TrackerIssue = {
    id: key,
    identifier: key,
    title: `Fix login ${key}`,
    url: worldIssueUrl(key),
    state: { type: "unstarted", name: "Todo" },
    team_id: null,
    labels: [],
    blockers: [],
    ...place,
  };
  return issue;
}

/** Every issue the tracker of a world holds. Issue ids equal their keys. */
export const WORLD_ISSUES: TrackerIssue[] = [
  worldIssue(SUBJECT_ISSUE_KEY, { parent_id: null, project_id: WORLD_PROJECT.id }),
  ...Array.from({ length: ISSUES_OF_EACH }, (_, index) =>
    worldIssue(subIssueKey(index), { parent_id: SUBJECT_ISSUE_KEY, project_id: WORLD_PROJECT.id }),
  ),
  ...Array.from({ length: ISSUES_OF_EACH }, (_, index) =>
    worldIssue(strayIssueKey(index), { parent_id: null, project_id: null }),
  ),
];

/** The projects of a world's tracker, by id and by the slug its link carries. */
export const WORLD_PROJECTS: Record<string, TrackerProject> = {
  [WORLD_PROJECT.id]: WORLD_PROJECT,
  [PROJECT_SLUG]: WORLD_PROJECT,
};
