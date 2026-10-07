import type { Stage } from "../../config/stage";
import { createRootContainer, nameRootPage, rootPageStage } from "../../workflow/root-page";
import type { RootPage } from "../../workflow/store/state";
import { modelAuthorPageTitle } from "../../workflow/task/model-author";
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
 * Settle where the pages of the workflow go. The page parent falls back to the config default.
 * On a host that nests pages, in a workflow definition with a root page stage, a plan that
 * writes pages gets its root page here: a container when a planned stage makes the root page,
 * else the existing page `root_page` names.
 */
export async function planPages(
  workflow: WorkflowRuntime,
  input: PagePlanInput,
): Promise<PagePlan | { refusal: string }> {
  const pageParent = input.page_parent ?? workflow.config().page_parent ?? null;
  const docs = await workflow.docs();
  const nesting = docs?.nesting;
  if (!docs || !nesting || !rootPageStage(workflow)) return flatPagePlan(input, pageParent);
  const current = workflow.state.root_page ?? null;
  if (current) {
    const named = input.root_page ? await docs.pageFromUrl(input.root_page) : null;
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
  const rootStage = input.stages.find((stage) => stage.root_page);
  try {
    if (rootStage) {
      if (input.root_page) {
        return { refusal: `Stage ${rootStage.name} makes the root page. Pass root_page null.` };
      }
      if (!pageParent) {
        return {
          refusal: `Stage ${rootStage.name} makes the root page, and no page parent was given or set in the config. Ask the requester where the documents go, then call set_plan again with page_parent.`,
        };
      }
      const title = modelAuthorPageTitle(input.name, rootStage.name);
      const root = await createRootContainer(nesting, { title, pageParent });
      const note = ` Created the root page ${root.url} for stage ${rootStage.name} to fill.`;
      return { page_parent: pageParent, root_page: root, note };
    }
    if (!input.root_page) {
      return {
        refusal:
          "The plan writes pages, and no planned stage makes the root page. Ask the requester which existing page is the root page, the one people read first. When they have none, use the page the workflow starts from. Then call set_plan again with root_page.",
      };
    }
    const named = await docs.pageFromUrl(input.root_page);
    if (!named) return { refusal: `${input.root_page} is not a page on the document host.` };
    const root = await nameRootPage(docs, nesting, {
      page_id: named.page_id,
      url: input.root_page,
    });
    return { page_parent: pageParent, root_page: root, note: ` The root page is ${root.url}.` };
  } catch (error) {
    return { refusal: `The root page could not be set up: ${String(error).slice(0, 300)}` };
  }
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
        "A planned stage writes its page as a model call, and no page parent was given or set in the config. Find it as the page_parent field describes, then call set_plan again. Ask only when nothing points to one.",
    };
  }
  return { page_parent: pageParent, root_page: null, note: "" };
}
