import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  notionPageLinkNamesItsPage,
  notionRichTextJoinsBack,
} from "../../../test/documents-invariants";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { notionPageFromUrl, notionPageId } from "./page-id";
import { notionRichText } from "./rich-text";

const RUNS = 100;

const HEX = /^[0-9a-f]$/;

const pageId = fc.string({
  unit: fc.constantFrom(..."0123456789abcdef".split("")),
  minLength: 32,
  maxLength: 32,
});

function dashed(id: string): string {
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join(
    "-",
  );
}

const titleWord = fc.oneof(
  fc.constantFrom("add", "a", "cafe", "deadbeef", "ABCDEF", "Design", "2026", "f00d", "Ünïcødé"),
  fc.string({
    unit: fc.constantFrom(..."0123456789abcdef".split("")),
    minLength: 1,
    maxLength: 40,
  }),
  fc
    .string({ unit: "grapheme", minLength: 1, maxLength: 8 })
    .filter((word) => !/[\s/?#%-]/.test(word)),
);

const titleSlug = fc.oneof(
  fc.constant(""),
  fc.array(titleWord, { minLength: 1, maxLength: 4 }).map((words) => `${words.join("-")}-`),
);

const notionPrefix = fc.constantFrom(
  "https://www.notion.so/",
  "https://notion.so/",
  "https://www.notion.so/acme/",
  "https://www.notion.com/acme/",
  "https://app.notion.com/p/",
  "https://acme.notion.site/",
);

const urlSuffix = fc.oneof(
  fc.constantFrom("", "/", "?pvs=4", "#", "?"),
  pageId.map((other) => `?v=${other}`),
  pageId.map((other) => `#${other}`),
  pageId.map((other) => `?v=${other}&pvs=4#${other}`),
);

const pageLink = fc.record({
  id: pageId,
  dashedId: fc.boolean(),
  form: fc.constantFrom("id", "url"),
  prefix: notionPrefix,
  slug: titleSlug,
  suffix: urlSuffix,
});

type PageLink = typeof pageLink extends fc.Arbitrary<infer Link> ? Link : never;

function linkText(link: PageLink): string {
  const written = link.dashedId ? dashed(link.id) : link.id;
  if (link.form === "id") return written;
  return `${link.prefix}${link.slug}${written}${link.suffix}`;
}

function readPageLink(link: PageLink): string | null {
  const text = linkText(link);
  if (link.form === "id") return notionPageId(text);
  return notionPageFromUrl(text)?.page_id ?? null;
}

function slugEndsWithHex(link: PageLink): boolean {
  return link.form === "url" && HEX.test(link.slug.replace(/-/g, "").at(-1) ?? "");
}

const emoji = fc.constantFrom("😀", "👍🏽", "🇺🇸", "𝄞", "👩‍💻");

const richText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 10_000 }),
  fc
    .tuple(
      fc.constantFrom(1998, 1999, 2000, 3998, 3999, 4000),
      emoji,
      fc.string({ unit: "binary", maxLength: 3000 }),
    )
    .map(([filler, symbol, rest]) => `${"a".repeat(filler)}${symbol}${rest}`),
  fc
    .tuple(fc.integer({ min: 1, max: 4 }), fc.constantFrom("a", "😀"))
    .map(([parts, unit]) => unit.repeat((parts * 2000) / unit.length)),
);

function cutFallsInsideAPair(text: string): boolean {
  for (let cut = 2000; cut < text.length; cut += 2000) {
    const unit = text.charCodeAt(cut - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) return true;
  }
  return false;
}

describe("Notion text invariants", () => {
  it(
    "a page link or page id reads as the page it names, in every form",
    () => {
      let hexSlugsBeforeTheId = 0;
      fc.assert(
        fc.property(pageLink, (link) => {
          if (slugEndsWithHex(link)) hexSlugsBeforeTheId++;
          notionPageLinkNamesItsPage(linkText(link), readPageLink(link), link.id);
        }),
        propertyRuns("notion page link names its page", RUNS),
      );
      expect(hexSlugsBeforeTheId).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "rich text parts join back to the text, within the part limit",
    () => {
      let cutsInsideAPair = 0;
      fc.assert(
        fc.property(richText, (text) => {
          if (cutFallsInsideAPair(text)) cutsInsideAPair++;
          const parts = notionRichText(text).map((item) =>
            item.type === "text" ? item.text.content : "",
          );
          notionRichTextJoinsBack(text, parts);
        }),
        propertyRuns("notion rich text joins back", RUNS),
      );
      expect(cutsInsideAPair).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
