/**
 * Issue reads for the Linear tracker, through raw GraphQL documents that select an issue and
 * its `inverseRelations` in one request.
 */
import type { StateType, TrackerIssue, TrackerProject } from "../types";

/** Runs one GraphQL document and returns its `data`. The tracker supplies it. */
export type RawQuery = <Data>(query: string, variables: Record<string, unknown>) => Promise<Data>;

/** One issue as the documents below select it. */
export type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { type: StateType; name: string };
  team?: { id: string } | null;
  parent?: { id: string } | null;
  project?: { id: string } | null;
  labels: { nodes: Array<{ name: string }> };
  inverseRelations: {
    nodes: Array<{
      type: string;
      issue: { id: string; identifier: string; state: { type: StateType } };
    }>;
  };
};

type IssuePage = {
  nodes: IssueNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type ProjectIssuesData = { project: { issues: IssuePage } | null };

type SubIssuesData = { issue: { children: IssuePage } | null };

const ISSUE_FIELDS = `
  id identifier title url state { type name } team { id } parent { id } project { id }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { type } } } }`;

/** One issue by id or identifier, with the relations that point at it. */
export const ISSUE_QUERY = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;

/** One project by id or slug id. */
export const PROJECT_QUERY = `query Project($id: String!) { project(id: $id) { id name url } }`;

/** Issues per request, the largest page that fits Linear's query complexity limit. */
const ISSUES_PER_PAGE = 50;

const ISSUE_PAGE = `(first: ${ISSUES_PER_PAGE}, after: $after) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }`;

/** One page of a project's issues, with relations. */
export const PROJECT_ISSUES_QUERY = `query ProjectIssues($id: String!, $after: String) {
  project(id: $id) { issues${ISSUE_PAGE} }
}`;

/** One page of the direct sub-issues of an issue, with relations. */
export const SUB_ISSUES_QUERY = `query SubIssues($id: String!, $after: String) {
  issue(id: $id) { children${ISSUE_PAGE} }
}`;

/** Map the GraphQL shape. A relation where this issue is the target of `blocks` is a blocker. */
export function toIssue(node: IssueNode): TrackerIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    state: node.state,
    team_id: node.team?.id ?? null,
    parent_id: node.parent?.id ?? null,
    project_id: node.project?.id ?? null,
    labels: node.labels.nodes.map((label) => label.name),
    blockers: node.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks")
      .map((relation) => relation.issue),
  };
}

/** One issue by id or identifier (`ENG-42`), with its blockers. Null when Linear has none. */
export async function fetchIssue(query: RawQuery, idOrKey: string): Promise<TrackerIssue | null> {
  const data = await query<{ issue: IssueNode | null }>(ISSUE_QUERY, { id: idOrKey });
  return data.issue ? toIssue(data.issue) : null;
}

/** One project by id or slug id. Null when Linear has none. */
export async function fetchProject(
  query: RawQuery,
  idOrSlug: string,
): Promise<TrackerProject | null> {
  const data = await query<{ project: TrackerProject | null }>(PROJECT_QUERY, { id: idOrSlug });
  const project = data.project;
  return project ? { id: project.id, name: project.name, url: project.url } : null;
}

/** Every issue of a project, with blockers. Follows the cursor until the last page. */
export function fetchProjectIssues(query: RawQuery, projectId: string): Promise<TrackerIssue[]> {
  return fetchIssuePages(projectId, async (variables) => {
    const data: ProjectIssuesData = await query(PROJECT_ISSUES_QUERY, variables);
    return data.project?.issues;
  });
}

/** The direct sub-issues of an issue, with blockers. Follows the cursor until the last page. */
export function fetchSubIssues(query: RawQuery, parentId: string): Promise<TrackerIssue[]> {
  return fetchIssuePages(parentId, async (variables) => {
    const data: SubIssuesData = await query(SUB_ISSUES_QUERY, variables);
    return data.issue?.children;
  });
}

/** Read every page of an issue connection. A missing owner ends the read. */
async function fetchIssuePages(
  ownerId: string,
  readPage: (variables: { id: string; after: string | null }) => Promise<IssuePage | undefined>,
): Promise<TrackerIssue[]> {
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await readPage({ id: ownerId, after });
    if (!page) break;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return nodes.map(toIssue);
}
