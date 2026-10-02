/** The Linear MCP server and the agent text that names its tools. */
import type { HostInstructions, PageInstructions } from "../../instructions";
import type { McpServer } from "../../mcp";

/** The Linear MCP server. Whoever the token acts as is the author of what the agent writes. */
export function linearMcpServer(token: string): McpServer {
  return {
    name: "linear",
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: `Bearer ${token}` },
  };
}

/** The tools the orchestrator agent may call on this server: reads and the small writes it makes itself. */
export const LINEAR_MCP_TOOLS = [
  "get_issue",
  "list_issues",
  "list_comments",
  "get_attachment",
  "get_project",
  "list_projects",
  "get_document",
  "list_documents",
  "list_milestones",
  "get_team",
  "list_teams",
  "get_user",
  "list_users",
  "list_issue_labels",
  "list_project_labels",
  "save_issue",
  "save_comment",
  "save_project",
  "save_milestone",
  "save_status_update",
];

/** How an agent works with a document on Linear. */
export const LINEAR_PAGE_INSTRUCTIONS: PageInstructions = {
  create:
    "Create the document in Linear with the Linear tools. Print the document URL on its own line when it exists.",
  read: "Read the document with the Linear `get_document` tool. The document slug is the last part of its URL.",
  change: "Change the document in place with the Linear tools. Do not create another document.",
  report: [
    "Post your review as one comment on the document with the Linear `save_comment` tool.",
    "Post one comment only. Do not edit the document, reply to another comment, or write anywhere else.",
  ].join("\n"),
};

/** How an agent works with a set of issues on Linear. */
export const LINEAR_ISSUES_INSTRUCTIONS: HostInstructions = {
  create:
    "Create the issues in Linear with the Linear tools. Print each issue URL on its own line. End with a one-line summary.",
  read: "Read the issue the artifact URL names with the Linear `get_issue` tool, then read its project with `get_project` and every issue in that project with `list_issues`.",
  change:
    "Change the issues in place with the Linear `save_issue` tool. Do not create an issue that repeats one the set already holds.",
};
