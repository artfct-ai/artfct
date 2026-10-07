import type { Documents, PageNesting } from "@artfct-ai/adapters/documents/types";
import {
  RESOURCES_HEADING,
  resourcesNamePage,
  splitAtResources,
  withoutResourceLink,
} from "../artifact/resources-section";
import type { Stage } from "../config/stage";
import type { RootPage, WorkflowState } from "./store/state";
import type { WorkflowRuntime } from "./types";

/** A page on the document host, by the id `pageFromUrl` gives and its link. */
export type HostPage = { page_id: string; url: string };

/** The stage of the workflow definition whose page is the root page. Undefined when none sets it. */
export function rootPageStage(workflow: WorkflowRuntime): Stage | undefined {
  return workflow.workflowDefinition().stages.find((stage) => stage.root_page);
}

/** Where a new page of the workflow goes: under the root page once there is one, else the page parent. */
export function newPageParent(state: WorkflowState): string | null {
  return state.root_page?.page_id ?? state.page_parent ?? null;
}

/** Create the root page as an empty container under the page parent, for the root page stage to fill. */
export async function createRootContainer(
  nesting: PageNesting,
  { title, pageParent }: { title: string; pageParent: string },
): Promise<RootPage> {
  const page = await nesting.createRootPage(title, RESOURCES_HEADING, pageParent);
  return { page_id: page.contentId ?? page.id, url: page.url, source: "container" };
}

/** Make an existing page the root page. It gets a resources section when it has none. */
export async function nameRootPage(
  documents: Documents,
  nesting: PageNesting,
  page: HostPage,
): Promise<RootPage> {
  if (!splitAtResources(await documents.readPageContent(page.page_id)).resources) {
    await nesting.appendToPage(page.page_id, RESOURCES_HEADING);
  }
  return { ...page, source: "named" };
}

/** Link a page from the resources section of the root page. False when the section names it already. */
export async function linkFromRootPage(
  documents: Documents,
  nesting: PageNesting,
  { root, page }: { root: RootPage; page: HostPage },
): Promise<boolean> {
  if (page.page_id === root.page_id) return false;
  if (resourcesNamePage(await documents.readPageContent(root.page_id), page.page_id)) return false;
  await nesting.appendToPage(root.page_id, `- ${page.url}`);
  return true;
}

/** Move a page under the root page. Its link goes first, so the resources section lists it once. */
export async function moveIntoRootPage(
  documents: Documents,
  nesting: PageNesting,
  { root, pageId }: { root: RootPage; pageId: string },
): Promise<void> {
  const text = await documents.readPageContent(root.page_id);
  const unlinked = withoutResourceLink(text, pageId);
  if (unlinked !== text) await documents.updatePageContent(root.page_id, unlinked);
  await nesting.movePage(pageId, root.page_id);
}
