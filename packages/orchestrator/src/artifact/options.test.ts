import { describe, expect, it } from "bun:test";
import { OPTIONS_HEADING, parseDocumentOptions } from "./options";

const PAGE = [
  "# Login redesign",
  "",
  "Two ways to store sessions.",
  "",
  `## ${OPTIONS_HEADING}`,
  "",
  "1. Keep one sessions table",
  "   Simple to migrate.",
  "   1. A nested step",
  "2) Split the table",
  "",
  "- a bullet",
  "",
  "## Risks",
  "",
  "1. Not an option",
].join("\n");

describe("parseDocumentOptions", () => {
  it("reads the numbered items under the options heading", () => {
    expect(parseDocumentOptions(PAGE)).toEqual(["Keep one sessions table", "Split the table"]);
  });

  it("reads the heading at any level", () => {
    expect(parseDocumentOptions(`### ${OPTIONS_HEADING}\n1. Only one`)).toEqual(["Only one"]);
  });

  it("is empty when the page has no options heading", () => {
    expect(parseDocumentOptions("# Design\n\n1. A step")).toEqual([]);
  });
});
