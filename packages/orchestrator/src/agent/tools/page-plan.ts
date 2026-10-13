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
): Promise<PagePlan | { error: string }> {
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
      return { error: `The root page is already ${current.url}. Pass root_page null.` };
    }
    return { page_parent: pageParent, root_page: current, note: "" };
  }
  if (!input.stages.some((stage) => stage.artifact === "page")) {
    if (!input.root_page) return { page_parent: pageParent, root_page: null, note: "" };
    return {
      error:
        "The planned stages do not write a page, so the workflow does not get a root page. Pass root_page null.",
    };
  }
  const rootStage = input.stages.find((stage) => stage.name === rootPageStageName);
  try {
    if (input.root_page) {
      if (rootStage) {
        return { error: `Stage ${rootStage.name} fills the root page. Pass root_page null.` };
      }
      const named = await documents.pageFromUrl(input.root_page);
      if (!named) return { error: `${input.root_page} is not a page on the document host.` };
      const root = await nameRootPage(documents, nesting, {
        page_id: named.page_id,
        url: input.root_page,
      });
      return { page_parent: pageParent, root_page: root, note: ` The root page is ${root.url}.` };
    }
    if (!pageParent) return { error: missingPageParentError(rootStage) };
    const root = await createRootContainer(nesting, { title: input.name, pageParent });
    const filledBy = rootStage ? ` for stage ${rootStage.name} to fill` : "";
    return {
      page_parent: pageParent,
      root_page: root,
      note: ` Created the root page ${root.url}${filledBy}.`,
    };
  } catch (error) {
    return { error: `The root page could not be set up: ${String(error).slice(0, 300)}` };
  }
}

/** The error when the plan writes pages and does not say where they go. */
function missingPageParentError(rootStage: Stage | undefined): string {
  if (rootStage) {
    return `Stage ${rootStage.name} fills the root page, and the plan and the workflow definition do not set a page parent. Ask the requester where the documents go. Then call set_plan again with page_parent.`;
  }
  return "The plan writes pages, and the plan and the workflow definition do not set a page parent. Ask the requester where the documents go, or which existing page is the root page. The root page is the page people read first. Then call set_plan again with page_parent or root_page.";
}

/** A workflow without a root page puts every page under the page parent. */
function flatPagePlan(
  input: PagePlanInput,
  pageParent: string | null,
): PagePlan | { error: string } {
  if (input.root_page) {
    return {
      error: "This workflow does not use a root page. Pass root_page null.",
    };
  }
  const needsPageParent = input.stages.some((stage) => stage.author.produce.execution === "model");
  if (needsPageParent && !pageParent) {
    return {
      error:
        "A planned stage writes its page as a model call, and the plan and the workflow definition do not set a page parent. Find it as the page_parent field describes. Then call set_plan again. Ask only when the context does not point to one.",
    };
  }
  return { page_parent: pageParent, root_page: null, note: "" };
}
