import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { fakeDocumentsOf, patchNestingHost, type FakeRuntime } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { linkInputPage, rootPageTools } from "./root-page";

const call = { toolCallId: "call-1", messages: [], context: {} };

const ROOT = { page_id: "root-1", url: "https://docs.test/root-1", source: "container" as const };
const INPUT_URL = "https://docs.test/directions";
const INPUT_TARGET = { url: INPUT_URL, ref: { kind: "page" as const, page_id: "directions-1" } };

function seedRootPage(workflow: FakeRuntime, rootText: string) {
  const documents = patchNestingHost(workflow, {
    pages: { [INPUT_URL]: "directions-1", [ROOT.url]: "root-1" },
  });
  documents.seedPage("root-1", rootText);
  documents.seedPage("directions-1", "# Directions");
  workflow.patchState({ root_page: ROOT });
  return documents;
}

describe("linkInputPage", () => {
  describe("an input page the workflow did not create", () => {
    let result: string;
    const linked = scenario(freshRuntime, async (workflow) => {
      seedRootPage(workflow, "## Resources");
      result = await linkInputPage(workflow, INPUT_TARGET);
    });

    it("links it from the resources section of the root page", () =>
      linked((workflow) => {
        expect(fakeDocumentsOf(workflow).pageText("root-1")).toBe(`## Resources\n- ${INPUT_URL}`);
      }));

    it("tells the agent to ask whether to move it", () =>
      linked(() => {
        expect(result).toContain("Ask the requester whether to move it into the root page");
      }));
  });

  describe("an input page the root page lists already", () => {
    let result: string;
    const listed = scenario(freshRuntime, async (workflow) => {
      seedRootPage(workflow, `## Resources\n- ${INPUT_URL}/directions-1`);
      result = await linkInputPage(workflow, INPUT_TARGET);
    });

    it("adds nothing and says nothing", () =>
      listed((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("appendToPage")).toEqual([]);
        expect(result).toBe("");
      }));
  });

  describe("a root page a person named", () => {
    let result: string;
    const named = scenario(freshRuntime, async (workflow) => {
      seedRootPage(workflow, "## Resources");
      workflow.patchState({ root_page: { ...ROOT, source: "named" } });
      result = await linkInputPage(workflow, INPUT_TARGET);
    });

    it("leaves the root page alone", () =>
      named((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("appendToPage")).toEqual([]);
        expect(result).toBe("");
      }));
  });
});

describe("move_into_root_page", () => {
  describe("a linked page", () => {
    let result: string;
    const moved = scenario(freshRuntime, async (workflow) => {
      seedRootPage(workflow, `# Design\n\n## Resources\n- ${INPUT_URL}/directions-1`);
      const { move_into_root_page } = rootPageTools(workflow);
      result = toolText(await move_into_root_page.execute({ page: INPUT_URL }, call));
    });

    it("moves the page under the root page", () =>
      moved((workflow) => {
        expect(fakeDocumentsOf(workflow).argsOf("movePage")).toEqual([["directions-1", "root-1"]]);
      }));

    it("drops the link, so the root page lists the page once, as a subpage", () =>
      moved((workflow) => {
        expect(fakeDocumentsOf(workflow).pageText("root-1")).toBe(
          '# Design\n\n## Resources\n<page url="https://docs.test/directions-1">directions-1</page>',
        );
      }));

    it("answers that it moved", () =>
      moved(() => {
        expect(result).toBe(`Moved ${INPUT_URL} into the root page ${ROOT.url}.`);
      }));
  });

  it("refuses without a root page", () =>
    freshRuntime(async (workflow) => {
      patchNestingHost(workflow);
      const { move_into_root_page } = rootPageTools(workflow);
      expect(toolText(await move_into_root_page.execute({ page: INPUT_URL }, call))).toBe(
        "This workflow has no root page.",
      );
    }));

  it("refuses the root page itself", () =>
    freshRuntime(async (workflow) => {
      const documents = seedRootPage(workflow, "## Resources");
      const { move_into_root_page } = rootPageTools(workflow);
      expect(toolText(await move_into_root_page.execute({ page: ROOT.url }, call))).toBe(
        `${ROOT.url} is the root page.`,
      );
      expect(documents.argsOf("movePage")).toEqual([]);
    }));
});
