/** The GitHub MCP server and the agent text that names its tools. */
import type { HostInstructions } from "../../instructions";
import type { McpServer } from "../../mcp";

/** The GitHub MCP server, on the token the task that uses it runs with. */
export function githubMcpServer(token: string): McpServer {
  return {
    name: "github",
    type: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: `Bearer ${token}` },
  };
}

const PULL_CREATE = [
  "When the work is ready, push the branch and open a draft pull request against the default branch with `gh pr create --draft`.",
  "Open it as a draft and leave it one. A reviewer reads it first, and a human marking it ready for review is how the humans take it over.",
  "Only this repository gets a pull request.",
  "Print the pull request URL on its own line when it exists.",
  "Stop after the pull request is open. You will receive CI results and review comments as follow-up messages.",
].join("\n");

/** What a task may do with repositories other than the one it works in. */
export const GITHUB_REPOSITORY_NOTES =
  "Clone other repositories you need for reference into /workspace/<name> with `gh repo clone`. Only repositories your credentials can reach will clone. If a clone is refused, say so and continue without it.";

const PULL_READ = [
  "- The repository is checked out on the pull request's branch in the current directory.",
  "- Read the pull request with `gh pr view <number>` and its diff with `gh pr diff <number>`.",
].join("\n");

const PULL_CHANGE = [
  "- Change the files on your branch and push to that branch.",
  "- Change the pull request's title and description with `gh pr edit <number>`.",
  "- Do not open another pull request.",
].join("\n");

/** How an agent works with a pull request on GitHub. */
export const GITHUB_PULL_INSTRUCTIONS: HostInstructions = {
  create: PULL_CREATE,
  read: PULL_READ,
  change: PULL_CHANGE,
};
