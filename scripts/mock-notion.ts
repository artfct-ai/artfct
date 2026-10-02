#!/usr/bin/env bun
/**
 * Mock Notion API for the smoke run: create a page, retrieve it, read and replace its markdown,
 * list and create comments on it, list its blocks, and read the bot user of the token. Every page
 * id is answered, a page this host did not create reads as empty markdown, and no page has blocks.
 * `GET /__state` returns what it holds and `POST /__reset` clears it.
 */

/** The bot user every request acts as, which is what the reviewer's comments are written by. */
const BOT_USER_ID = "00000000-0000-4000-8000-000000000bot";

/** When a page was last edited. Fixed, so a review of it is never stale in the smoke. */
const PAGE_EDITED_AT = "2026-01-01T00:00:00.000Z";

type StoredComment = {
  id: string;
  page_id: string;
  created_time: string;
  text: string;
};

/** A page created here, with its markdown after the create and after each replace, oldest first. */
type StoredPage = {
  id: string;
  parent_id: string;
  title: string;
  markdown_versions: string[];
};

const port = Number(process.env.MOCK_NOTION_PORT ?? "9999");

const state = { comments: [] as StoredComment[], pages: [] as StoredPage[] };

function log(line: string): void {
  console.log(`[mock-notion] ${line}`);
}

function pageObject(pageId: string) {
  return {
    object: "page",
    id: pageId,
    created_time: PAGE_EDITED_AT,
    last_edited_time: PAGE_EDITED_AT,
    created_by: { object: "user", id: BOT_USER_ID },
    last_edited_by: { object: "user", id: BOT_USER_ID },
    parent: { type: "workspace", workspace: true },
    archived: false,
    in_trash: false,
    properties: {},
    url: `https://www.notion.so/acme/${pageId}`,
    public_url: null,
  };
}

function commentObject(comment: StoredComment) {
  return {
    object: "comment",
    id: comment.id,
    parent: { type: "page_id", page_id: comment.page_id },
    discussion_id: `discussion-${comment.id}`,
    created_time: comment.created_time,
    last_edited_time: comment.created_time,
    created_by: { object: "user", id: BOT_USER_ID },
    rich_text: [{ type: "text", plain_text: comment.text, text: { content: comment.text } }],
    display_name: { type: "integration", resolved_name: "artfct" },
  };
}

/** The text of a create-comment body. Every caller here sends rich text. */
function commentText(body: Record<string, unknown>): string {
  const richText = Array.isArray(body.rich_text) ? body.rich_text : [];
  return richText
    .map((part) => (part as { text?: { content?: string } }).text?.content ?? "")
    .join("");
}

function createComment(body: Record<string, unknown>): Response {
  const parent = body.parent as { page_id?: string; block_id?: string } | undefined;
  const pageId = parent?.page_id ?? parent?.block_id;
  if (!pageId) {
    return Response.json(
      { object: "error", status: 400, message: "no page parent" },
      { status: 400 },
    );
  }
  const comment: StoredComment = {
    id: `comment-${state.comments.length + 1}`,
    page_id: pageId,
    created_time: new Date().toISOString(),
    text: commentText(body),
  };
  state.comments.push(comment);
  log(`comment on ${pageId}: ${comment.text.split("\n")[0]}`);
  return Response.json(commentObject(comment));
}

function listComments(blockId: string | null): Response {
  const results = state.comments
    .filter((comment) => comment.page_id === blockId)
    .map(commentObject);
  return Response.json({
    object: "list",
    type: "comment",
    comment: {},
    next_cursor: null,
    has_more: false,
    results,
  });
}

function notFound(message: string): Response {
  return Response.json({ object: "error", status: 404, message }, { status: 404 });
}

/** The plain text of the title property a create-page body sends. */
function pageTitle(body: Record<string, unknown>): string {
  const properties = body.properties as
    | { title?: { title?: Array<{ text?: { content?: string } }> } }
    | undefined;
  return (properties?.title?.title ?? []).map((part) => part.text?.content ?? "").join("");
}

function createPage(body: Record<string, unknown>): Response {
  const parent = body.parent as { page_id?: string } | undefined;
  if (!parent?.page_id) {
    return Response.json(
      { object: "error", status: 400, message: "no page parent" },
      { status: 400 },
    );
  }
  const page: StoredPage = {
    id: crypto.randomUUID().replaceAll("-", ""),
    parent_id: parent.page_id,
    title: pageTitle(body),
    markdown_versions: [typeof body.markdown === "string" ? body.markdown : ""],
  };
  state.pages.push(page);
  log(`page ${page.id} created under ${page.parent_id}: ${page.title}`);
  return Response.json(pageObject(page.id));
}

function markdownObject(pageId: string, markdown: string) {
  return { object: "page_markdown", id: pageId, markdown, truncated: false, unknown_block_ids: [] };
}

function readMarkdown(pageId: string): Response {
  const page = state.pages.find((stored) => stored.id === pageId);
  return Response.json(markdownObject(pageId, page?.markdown_versions.at(-1) ?? ""));
}

function replaceMarkdown(pageId: string, body: Record<string, unknown>): Response {
  const page = state.pages.find((stored) => stored.id === pageId);
  if (!page) return notFound(`no page ${pageId}`);
  const replace = body.replace_content as { new_str?: string } | undefined;
  if (body.type !== "replace_content" || replace?.new_str === undefined) {
    return Response.json(
      { object: "error", status: 400, message: "only replace_content is served" },
      { status: 400 },
    );
  }
  page.markdown_versions.push(replace.new_str);
  log(`page ${pageId} markdown replaced`);
  return Response.json(markdownObject(pageId, replace.new_str));
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/__state") return Response.json(state);
  if (pathname === "/__reset" && request.method === "POST") {
    state.comments.length = 0;
    state.pages.length = 0;
    return Response.json({ ok: true });
  }
  if (pathname === "/v1/users/me")
    return Response.json({ object: "user", id: BOT_USER_ID, type: "bot", name: "artfct", bot: {} });
  if (pathname === "/v1/comments" && request.method === "POST") {
    return createComment((await request.json()) as Record<string, unknown>);
  }
  if (pathname === "/v1/comments") return listComments(url.searchParams.get("block_id"));
  if (/^\/v1\/blocks\/[^/]+\/children$/.test(pathname)) {
    return Response.json({
      object: "list",
      type: "block",
      block: {},
      next_cursor: null,
      has_more: false,
      results: [],
    });
  }
  if (pathname === "/v1/pages" && request.method === "POST") {
    return createPage((await request.json()) as Record<string, unknown>);
  }
  const markdown = /^\/v1\/pages\/([^/]+)\/markdown$/.exec(pathname);
  if (markdown && request.method === "PATCH") {
    return replaceMarkdown(markdown[1]!, (await request.json()) as Record<string, unknown>);
  }
  if (markdown) return readMarkdown(markdown[1]!);
  const page = /^\/v1\/pages\/([^/]+)$/.exec(pathname);
  if (page) return Response.json(pageObject(page[1]!));
  return notFound(`no route ${pathname}`);
}

Bun.serve({ port, fetch: handle });
log(`listening on ${port}`);
