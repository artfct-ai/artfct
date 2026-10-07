/** The Notion CLI in the sandbox image and the agent text that names its commands. */
import type { PageInstructions } from "../../instructions";

/**
 * The environment the Notion CLI reads a connection token from. It keeps the token off the OS
 * keychain, which a container does not have.
 */
export function notionCliEnv(token: string): Record<string, string> {
  return { NOTION_API_TOKEN: token, NOTION_KEYRING: "0" };
}

/** How an agent works with a page on Notion, through the Notion CLI. */
export const NOTION_PAGE_INSTRUCTIONS: PageInstructions = {
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
  report: [
    'Post your review as one comment on the page. Write the request body to a file as `{"parent":{"page_id":"<page id>"},"rich_text":[{"text":{"content":"<review>"}}]}` and run `ntn api v1/comments --data @comment.json`.',
    "Notion takes at most 2000 characters in one rich text item. Split a longer review across several items in order.",
    "Post one comment only. Do not edit the page, reply to another comment, or write anywhere else.",
  ].join("\n"),
};

/** Where the orchestrator agent finds the page parent of a workflow on Notion. */
export const NOTION_PAGE_PARENT_HINT =
  "the link of a Notion page or database the request names as the place for the documents. Null when the request names none, and the default from the config applies.";
