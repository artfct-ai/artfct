import type { Stage } from "../../config/stage";
import { createRootContainer, nameRootPage, rootPageStage } from "../../workflow/root-page";
import type { RootPage } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";

/** What `set_plan` asks about the pages of the workflow. */
export type PagePlanInput = {
  name: string;
  stages: Stage[];
  page_parent: string | null;
  root_page: string | null;
};

/** Where the pages of the workflow go, and what `set_plan` adds to its answer about them. */
export type PagePlan = { page_parent: string | null; root_page: RootPage | null; note: string };

/**
 * Settle where the pages of the workflow go. The page parent falls back to the workflow
 * definition's default.
 * On a host that nests pages, in a workflow definition with a root page stage, a plan that
 * writes pages gets its root page here: the existing page `root_page` names, else a container
 * under the page parent. The root page stage fills the container when it runs.
 */
export async function planPages(
  workflow: WorkflowRuntime,
  input: PagePlanInput,
): Promise<PagePlan | { refusal: string }> {
  const pageParent =
    input.page_parent ?? workflow.workflowDefinition().documents.page_parent ?? null;
  const documents = await workflow.documents();
  const nesting = documents?.nesting;
  const rootPageStageName = rootPageStage(workflow)?.name;
  if (!documents || !nesting || !rootPageStageName) return flatPagePlan(input, pageParent);
  const current = workflow.state.root_page ?? null;
  if (current) {
    const named = input.root_page ? await documents.pageFromUrl(input.root_page) : null;
    if (input.root_page && named?.page_id !== current.page_id) {
      return { refusal: `The root page is already ${current.url}. Pass root_page null.` };
    }
    return { page_parent: pageParent, root_page: current, note: "" };
  }
  if (!input.stages.some((stage) => stage.artifact === "page")) {
    if (!input.root_page) return { page_parent: pageParent, root_page: null, note: "" };
    return {
      refusal: "No planned stage writes a page, so there is no root page. Pass root_page null.",
    };
  }
  const rootStage = input.stages.find((stage) => stage.name === rootPageStageName);
  try {
    if (input.root_page) {
      if (rootStage) {
        return { refusal: `Stage ${rootStage.name} fills the root page. Pass root_page null.` };
      }
      const named = await documents.pageFromUrl(input.root_page);
      if (!named) return { refusal: `${input.root_page} is not a page on the document host.` };
      const root = await nameRootPage(documents, nesting, {
        page_id: named.page_id,
        url: input.root_page,
      });
      return { page_parent: pageParent, root_page: root, note: ` The root page is ${root.url}.` };
    }
    if (!pageParent) return { refusal: missingPageParentRefusal(rootStage) };
    const root = await createRootContainer(nesting, { title: input.name, pageParent });
    const filledBy = rootStage ? ` for stage ${rootStage.name} to fill` : "";
    return {
      page_parent: pageParent,
      root_page: root,
      note: ` Created the root page ${root.url}${filledBy}.`,
    };
  } catch (error) {
    return { refusal: `The root page could not be set up: ${String(error).slice(0, 300)}` };
  }
}

/** What set_plan asks for when the plan writes pages and nothing says where they go. */
function missingPageParentRefusal(rootStage: Stage | undefined): string {
  if (rootStage) {
    return `Stage ${rootStage.name} fills the root page, and no page parent was given or set in the workflow definition. Ask the requester where the documents go, then call set_plan again with page_parent.`;
  }
  return "The plan writes pages, and no page parent was given or set in the workflow definition. Ask the requester where the documents go, or which existing page is the root page, the one people read first. Then call set_plan again with page_parent or root_page.";
}

/** A workflow without a root page puts every page under the page parent. */
function flatPagePlan(
  input: PagePlanInput,
  pageParent: string | null,
): PagePlan | { refusal: string } {
  if (input.root_page) {
    return {
      refusal: "This workflow has no root page. Pass root_page null.",
    };
  }
  const needsPageParent = input.stages.some((stage) => stage.author.produce.execution === "model");
  if (needsPageParent && !pageParent) {
    return {
      refusal:
        "A planned stage writes its page as a model call, and no page parent was given or set in the workflow definition. Find it as the page_parent field describes, then call set_plan again. Ask only when nothing points to one.",
    };
  }
  return { page_parent: pageParent, root_page: null, note: "" };
}
