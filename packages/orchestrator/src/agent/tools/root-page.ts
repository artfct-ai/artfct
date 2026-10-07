import { tool } from "ai";
import { z } from "zod";
import type { ArtifactTarget } from "../../artifact/types";
import { linkFromRootPage, moveIntoRootPage } from "../../workflow/root-page";
import type { WorkflowRuntime } from "../../workflow/types";

/** The tool that moves an existing page under the root page. */
export const MOVE_INTO_ROOT_PAGE = "move_into_root_page";

/** How the agent treats a page the workflow did not create. Kept next to the tool that moves it. */
export const ROOT_PAGE_RULES = `## Root Page
* **Expect** start_job to link an input page from the root page when the workflow created the root page.
* **Ask** the requester once, with the plan, whether to move that page into the root page or keep the link. Keep the link when they do not answer.
* **Call** \`${MOVE_INTO_ROOT_PAGE}\` only when the requester asks to move it.`;

/** True once the workflow has a root page. */
export function hasRootPage(workflow: WorkflowRuntime): boolean {
  return Boolean(workflow.state.root_page);
}

/** The tool that moves a linked page under the root page when the requester asks. */
export function rootPageTools(workflow: WorkflowRuntime) {
  return {
    [MOVE_INTO_ROOT_PAGE]: tool({
      description:
        "Move an existing page under the root page as a subpage, and drop its link from the root page. Refused when the workflow has no root page, the link names no page on the document host, or it is the root page.",
      inputSchema: z.object({ page: z.string().describe("the link of the page to move") }),
      execute: ({ page }) => movePage(workflow, page),
    }),
  };
}

/**
 * Link an input page from the root page the workflow created, and say what the agent asks next.
 * Empty when there is no such root page or the root page lists the page already.
 */
export async function linkInputPage(
  workflow: WorkflowRuntime,
  target: ArtifactTarget,
): Promise<string> {
  const root = workflow.state.root_page;
  if (target.ref.kind !== "page" || root?.source !== "container") return "";
  const docs = await workflow.docs();
  if (!docs?.nesting) return "";
  const page = { page_id: target.ref.page_id, url: target.url };
  try {
    if (!(await linkFromRootPage(docs, docs.nesting, { root, page }))) return "";
  } catch (error) {
    return ` Could not link ${target.url} from the root page: ${String(error).slice(0, 200)}`;
  }
  return ` Linked ${target.url} from the root page ${root.url}. Ask the requester whether to move it into the root page instead. Call ${MOVE_INTO_ROOT_PAGE} if they say move.`;
}

async function movePage(workflow: WorkflowRuntime, url: string): Promise<string> {
  const root = workflow.state.root_page;
  if (!root) return "This workflow has no root page.";
  const docs = await workflow.docs();
  if (!docs?.nesting) return "The document host does not nest pages.";
  const page = await docs.pageFromUrl(url);
  if (!page) return `${url} is not a page on the document host.`;
  if (page.page_id === root.page_id) return `${url} is the root page.`;
  try {
    await moveIntoRootPage(docs, docs.nesting, { root, pageId: page.page_id });
  } catch (error) {
    return `Could not move ${url}: ${String(error).slice(0, 300)}`;
  }
  workflow.log(null, `moved ${url} into the root page ${root.url}`);
  return `Moved ${url} into the root page ${root.url}.`;
}
