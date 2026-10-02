import { describe, expect, it } from "bun:test";
import { extractLinks } from "./links";

describe("extractLinks", () => {
  it("collects every http and https link once", () => {
    expect(extractLinks("a http://x.y/a and https://x.y/b then http://x.y/a")).toEqual([
      "http://x.y/a",
      "https://x.y/b",
    ]);
  });

  it("drops trailing punctuation and wrapping characters", () => {
    expect(extractLinks("see <https://x.y/a>, and (https://x.y/b).")).toEqual([
      "https://x.y/a",
      "https://x.y/b",
    ]);
  });

  it("finds nothing in text without links", () => {
    expect(extractLinks("no links here")).toEqual([]);
  });
});
