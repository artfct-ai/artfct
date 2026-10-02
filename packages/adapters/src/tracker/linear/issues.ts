/**
 * Issue reads for the Linear tracker, through raw GraphQL documents that select an issue and
 * its `inverseRelations` in one request.
 */
import type { StateType, TrackerIssue } from "../types";

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

const ISSUE_FIELDS = `
  id identifier title url state { type name } team { id } labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { type } } } }`;

/** One issue by id or identifier, with the relations that point at it. */
export const ISSUE_QUERY = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;

/** Issues per request, the largest page that fits Linear's query complexity limit. */
const ISSUES_PER_PAGE = 50;

/** One page of a project's issues, with relations. */
export const PROJECT_ISSUES_QUERY = `query ProjectIssues($id: String!, $after: String) {
  project(id: $id) {
    issues(first: ${ISSUES_PER_PAGE}, after: $after) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
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

/** Every issue of a project, with blockers. Follows the cursor until the last page. */
export async function fetchProjectIssues(
  query: RawQuery,
  projectId: string,
): Promise<TrackerIssue[]> {
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  for (;;) {
    const data: ProjectIssuesData = await query(PROJECT_ISSUES_QUERY, { id: projectId, after });
    const page: IssuePage | undefined = data.project?.issues;
    if (!page) break;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return nodes.map(toIssue);
}
