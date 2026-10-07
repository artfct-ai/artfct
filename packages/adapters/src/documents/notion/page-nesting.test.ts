import { describe, expect, it } from "bun:test";
import { fetchBody, fetchUrl } from "../../../test/fetch";
import { NotionDocuments } from "./documents";

type Call = { url: string; method: string; body: string };

const PARENT_ID = "3eb92fd781108088b848ebb16c8f4838";
const TABLE_ID = "7d1c2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

const createdPage = {
  object: "page",
  id: "1111aaaa-2222-bbbb-3333-cccc4444dddd",
  created_time: "2026-09-01T00:00:00.000Z",
  last_edited_time: "2026-09-01T00:00:00.000Z",
  parent: { type: "page_id", page_id: PARENT_ID },
  archived: false,
  properties: {},
  url: "https://www.notion.so/Design-1111aaaa2222bbbb3333cccc4444dddd",
};

const notFound = () =>
  Response.json(
    { object: "error", status: 404, code: "object_not_found", message: "Not a database." },
    { status: 404 },
  );

const database = (dataSources: Array<{ id: string; name: string }>) => ({
  object: "database",
  id: PARENT_ID,
  title: [],
  data_sources: dataSources,
});

const table = {
  object: "data_source",
  id: TABLE_ID,
  title: [],
  properties: {
    Status: { id: "s", name: "Status", type: "status" },
    Name: { id: "title", name: "Name", type: "title" },
  },
};

function notionNesting(respond: (url: string, method: string) => Response) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: fetchUrl(input), method, body: fetchBody(init) });
    return respond(fetchUrl(input), method);
  };
  const { nesting } = new NotionDocuments("secret_x", { fetch });
  return { nesting, calls };
}

function bodyOf(calls: Call[], url: string): unknown {
  const call = calls.find((candidate) => candidate.url === url && candidate.method !== "GET");
  return JSON.parse(call?.body ?? "null");
}

async function createUnderPage() {
  const notion = notionNesting((url) =>
    url.includes("/databases/") ? notFound() : Response.json(createdPage),
  );
  const page = await notion.nesting.createRootPage("Design", "## Resources", PARENT_ID);
  return { ...notion, page };
}

async function createUnderDatabase() {
  const notion = notionNesting((url) => {
    if (url.includes("/databases/"))
      return Response.json(database([{ id: TABLE_ID, name: "Docs" }]));
    if (url.includes("/data_sources/")) return Response.json(table);
    return Response.json(createdPage);
  });
  await notion.nesting.createRootPage(
    "Design",
    "## Resources",
    `https://www.notion.so/acme/${PARENT_ID}?v=1`,
  );
  return notion.calls;
}

describe("NotionPageNesting", () => {
  describe("createRootPage under a page", () => {
    it("creates the page under the parent page with its title", async () => {
      const { calls } = await createUnderPage();
      expect(bodyOf(calls, "https://api.notion.com/v1/pages")).toEqual({
        parent: { page_id: PARENT_ID },
        properties: { title: { title: [{ text: { content: "Design" } }] } },
        markdown: "## Resources",
      });
    });

    it("answers with the dashless page id that webhooks carry", async () => {
      const { page } = await createUnderPage();
      expect(page).toEqual({
        id: "1111aaaa2222bbbb3333cccc4444dddd",
        contentId: null,
        url: createdPage.url,
        revision: "2026-09-01T00:00:00.000Z",
      });
    });
  });

  describe("createRootPage under a database with one table", () => {
    it("reads the database the link names", async () => {
      const calls = await createUnderDatabase();
      expect(calls[0]?.url).toBe(`https://api.notion.com/v1/databases/${PARENT_ID}`);
    });

    it("creates the page as a row of the table, under its title column", async () => {
      const calls = await createUnderDatabase();
      expect(bodyOf(calls, "https://api.notion.com/v1/pages")).toEqual({
        parent: { data_source_id: TABLE_ID },
        properties: { Name: { title: [{ text: { content: "Design" } }] } },
        markdown: "## Resources",
      });
    });
  });

  it("refuses a database with several tables", async () => {
    const { nesting } = notionNesting(() =>
      Response.json(
        database([
          { id: TABLE_ID, name: "Docs" },
          { id: "8e2d3f4a-5b6c-7d8e-9f0a-1b2c3d4e5f6a", name: "Archive" },
        ]),
      ),
    );
    await expect(nesting.createRootPage("Design", "", PARENT_ID)).rejects.toThrow(
      "holds 2 tables. Use a database with one table as the page parent.",
    );
  });

  it("refuses a page parent that names no page, without a request", async () => {
    const { nesting, calls } = notionNesting(() => Response.json(createdPage));
    await expect(nesting.createRootPage("Design", "", "Engineering")).rejects.toThrow(
      'notion: "Engineering" does not name a page or a database',
    );
    expect(calls).toEqual([]);
  });

  it("moves a page under another page", async () => {
    const { nesting, calls } = notionNesting(() => Response.json(createdPage));
    await nesting.movePage("5555eeee6666ffff7777aaaa8888bbbb", PARENT_ID);
    expect(calls[0]?.url).toBe(
      "https://api.notion.com/v1/pages/5555eeee6666ffff7777aaaa8888bbbb/move",
    );
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ parent: { page_id: PARENT_ID } });
  });

  it("adds text at the end of a page", async () => {
    const { nesting, calls } = notionNesting(() =>
      Response.json({
        object: "page_markdown",
        id: PARENT_ID,
        markdown: "",
        truncated: false,
        unknown_block_ids: [],
      }),
    );
    await nesting.appendToPage(PARENT_ID, "- https://www.notion.so/x");
    expect(calls[0]?.url).toBe(`https://api.notion.com/v1/pages/${PARENT_ID}/markdown`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      type: "insert_content",
      insert_content: { content: "- https://www.notion.so/x", position: { type: "end" } },
    });
  });
});
