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
    "Change the page in place with targeted edits. People comment on blocks, and a block you rewrite or remove loses its comments, so change only the text a finding needs.",
    'Write the request body to a file as `{"type":"update_content","update_content":{"content_updates":[{"old_str":"<exact current text>","new_str":"<new text>"}]}}` and run `ntn api v1/pages/<page id>/markdown -X PATCH --data @edit.json`. Each `old_str` must match the page exactly once. Send at most 100 edits in one request.',
    "Do not replace the whole page, and do not create another page.",
    'A finding that starts with a label such as [comment <id>] came from a comment on the page. Reply to each one in its discussion: read the comment with `ntn api v1/comments/<id>`, write `{"discussion_id":"<its discussion_id>","rich_text":[{"text":{"content":"<reply>"}}]}` to a file, and run `ntn api v1/comments --data @reply.json`. Say in one or two sentences what you changed for it, or why the page does not change.',
  ].join("\n"),
};

/** Where the orchestrator agent finds the page parent of a workflow on Notion. */
export const NOTION_PAGE_PARENT_HINT =
  "the link of a Notion page or database the request names as the place for the documents. Null when the request names none, and the workflow definition's default applies.";
