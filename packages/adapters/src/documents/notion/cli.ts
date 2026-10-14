/** The Notion CLI in the sandbox image and the agent text that names its commands. */
import type { HostInstructions } from "../../instructions";

/**
 * The environment the Notion CLI reads a connection token from. It keeps the token off the OS
 * keychain, which a container does not have.
 */
export function notionCliEnv(token: string): Record<string, string> {
  return { NOTION_API_TOKEN: token, NOTION_KEYRING: "0" };
}

/** How an agent works with a page on Notion, through the Notion CLI. */
export const NOTION_PAGE_INSTRUCTIONS: HostInstructions = {
  create: [
    "Write the page as Markdown in a file. A leading frontmatter `title` sets the page title.",
    "Create the page under the page parent this prompt names with `ntn pages create --parent page:<page parent id> < page.md`.",
    "Print the page URL on its own line when it exists.",
  ].join("\n"),
  read: "Read the page as Markdown with `ntn pages get <page id>`. The page id is the last part of its URL.",
  change: [
    "Change the page in place. Write its full new Markdown in a file and run `ntn pages edit <page id> < page.md`, which replaces the page content.",
    "Do not create another page.",
  ].join("\n"),
};

/** Where the orchestrator agent finds the page parent of a workflow on Notion. */
export const NOTION_PAGE_PARENT_HINT =
  "the link of a Notion page or database the request names as the place for the documents. Null when the request names none, and the workflow definition's default applies.";
