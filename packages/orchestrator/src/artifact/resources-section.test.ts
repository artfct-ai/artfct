import { describe, expect, it } from "bun:test";
import {
  aboveResources,
  resourcesNamePage,
  splitAtResources,
  withoutResourceLink,
} from "./resources-section";

const CHILD = '<page url="https://www.notion.so/Plan-1111aaaa2222bbbb3333cccc4444dddd">Plan</page>';
const LINKED = "- https://www.notion.so/Directions-5555eeee6666ffff7777aaaa8888bbbb";
const ROOT = ["# Design", "", "The body.", "", "## Resources", CHILD, LINKED].join("\n");

describe("splitAtResources", () => {
  it("splits at the heading and keeps the section to the end", () => {
    expect(splitAtResources(ROOT)).toEqual({
      body: "# Design\n\nThe body.",
      resources: ["## Resources", CHILD, LINKED].join("\n"),
    });
  });

  it("leaves a page without the section whole", () => {
    expect(splitAtResources("# Design")).toEqual({ body: "# Design", resources: "" });
  });
});

describe("aboveResources", () => {
  it("fills an empty container above its section", () => {
    expect(aboveResources("# Design\n\nNew.", "## Resources")).toBe(
      "# Design\n\nNew.\n\n## Resources",
    );
  });

  it("replaces the body and keeps the section the page holds now", () => {
    expect(aboveResources("# Design\n\nRevised.", ROOT)).toBe(
      ["# Design", "", "Revised.", "", "## Resources", CHILD, LINKED].join("\n"),
    );
  });

  it("drops a section the author wrote", () => {
    expect(aboveResources("# Design\n\n## Resources\n- made up", ROOT)).toBe(
      ["# Design", "", "## Resources", CHILD, LINKED].join("\n"),
    );
  });

  it("keeps the author text when the page has no section", () => {
    expect(aboveResources("# Design", "# Old")).toBe("# Design");
  });
});

describe("withoutResourceLink", () => {
  it("drops the link to a page by its dashed id", () => {
    expect(withoutResourceLink(ROOT, "5555eeee-6666-ffff-7777-aaaa8888bbbb")).toBe(
      ["# Design", "", "The body.", "", "## Resources", CHILD].join("\n"),
    );
  });

  it("keeps a child page line that names the page", () => {
    expect(withoutResourceLink(ROOT, "1111aaaa2222bbbb3333cccc4444dddd")).toBe(ROOT);
  });

  it("leaves a page without the section as it is", () => {
    expect(withoutResourceLink("# Design", "5555eeee6666ffff7777aaaa8888bbbb")).toBe("# Design");
  });
});

describe("resourcesNamePage", () => {
  it("finds a linked page", () => {
    expect(resourcesNamePage(ROOT, "5555eeee6666ffff7777aaaa8888bbbb")).toBe(true);
  });

  it("finds a child page", () => {
    expect(resourcesNamePage(ROOT, "1111aaaa-2222-bbbb-3333-cccc4444dddd")).toBe(true);
  });

  it("does not look above the section", () => {
    expect(resourcesNamePage("See 9999 here\n\n## Resources", "9999")).toBe(false);
  });
});
