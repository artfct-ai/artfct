#!/usr/bin/env bun
/**
 * Mock Notion API for the smoke run: create a page, retrieve and update it, read, replace, and edit
 * its markdown, list and create comments on it and on its blocks, list its blocks, and read the bot
 * user of the token. Every page id is answered. A page this host did not create reads as empty markdown and
 * holds one paragraph block. `GET /__state` returns what it holds and `POST /__reset` clears it.
 */

/** The bot user every request acts as, which is what the reviewer's comments are written by. */
const BOT_USER_ID = "00000000-0000-4000-8000-000000000bot";

/** When every page was created. Each write moves its last edit one second later. */
const PAGE_CREATED_AT = Date.parse("2026-01-01T00:00:00.000Z");

/** The one paragraph a page this host did not create holds, which a mock reviewer can quote. */
const UNWRITTEN_PAGE_TEXT = "Each team runs the migration step once.";

/** A comment on a page, or on one block of it when `block_id` is set. */
type StoredComment = {
  id: string;
  page_id: string;
  block_id: string | null;
  created_time: string;
  text: string;
};

/** A page created here, with its markdown after the create and after each write, oldest first. */
type StoredPage = {
  id: string;
  parent_id: string;
  title: string;
  markdown_versions: string[];
};

const port = Number(process.env.MOCK_NOTION_PORT ?? "9999");

const state = {
  comments: [] as StoredComment[],
  pages: [] as StoredPage[],
  page_writes: {} as Record<string, number>,
};

function log(line: string): void {
  console.log(`[mock-notion] ${line}`);
}

function pageObject(pageId: string) {
  const writes = state.page_writes[pageId] ?? 0;
  return {
    object: "page",
    id: pageId,
    created_time: new Date(PAGE_CREATED_AT).toISOString(),
    last_edited_time: new Date(PAGE_CREATED_AT + writes * 1000).toISOString(),
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

function blockId(pageId: string, index: number): string {
  return `${pageId}-${index}`;
}

function pageOfBlock(id: string): string {
  return id.split("-")[0]!;
}

/** The text of each block of a page: each line of its markdown, or the unwritten page's one paragraph. */
function blockTexts(pageId: string): string[] {
  const page = state.pages.find((stored) => stored.id === pageId);
  if (!page) return [UNWRITTEN_PAGE_TEXT];
  return (page.markdown_versions.at(-1) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function listBlocks(pageId: string): Response {
  const results = blockTexts(pageId).map((text, index) => ({
    object: "block",
    id: blockId(pageId, index),
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [{ type: "text", plain_text: text, text: { content: text } }] },
  }));
  return Response.json({
    object: "list",
    type: "block",
    block: {},
    next_cursor: null,
    has_more: false,
    results,
  });
}

function createComment(body: Record<string, unknown>): Response {
  const parent = body.parent as { page_id?: string; block_id?: string } | undefined;
  const pageId = parent?.page_id ?? (parent?.block_id ? pageOfBlock(parent.block_id) : undefined);
  if (!pageId) {
    return Response.json(
      { object: "error", status: 400, message: "no page parent" },
      { status: 400 },
    );
  }
  const comment: StoredComment = {
    id: `comment-${state.comments.length + 1}`,
    page_id: pageId,
    block_id: parent?.block_id ?? null,
    created_time: new Date().toISOString(),
    text: commentText(body),
  };
  state.comments.push(comment);
  log(`comment on ${comment.block_id ?? pageId}: ${comment.text.split("\n")[0]}`);
  return Response.json(commentObject(comment));
}

function listComments(parentId: string | null): Response {
  const results = state.comments
    .filter((comment) => (comment.block_id ?? comment.page_id) === parentId)
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

function updateMarkdown(pageId: string, body: Record<string, unknown>): Response {
  const page = state.pages.find((stored) => stored.id === pageId);
  if (!page) return notFound(`no page ${pageId}`);
  const revised = revisedMarkdown(page.markdown_versions.at(-1) ?? "", body);
  if ("error" in revised) {
    return Response.json(
      { object: "error", status: 400, code: "validation_error", message: revised.error },
      { status: 400 },
    );
  }
  page.markdown_versions.push(revised.markdown);
  recordPageWrite(pageId);
  log(`page ${pageId} markdown ${body.type === "replace_content" ? "replaced" : "updated"}`);
  return Response.json(markdownObject(pageId, revised.markdown));
}

/** Moves the last edit of a page, as Notion does on each write. */
function recordPageWrite(pageId: string): void {
  state.page_writes[pageId] = (state.page_writes[pageId] ?? 0) + 1;
}

/** Updates the properties of any page id. The mock keeps only the write. */
function updatePage(pageId: string): Response {
  recordPageWrite(pageId);
  log(`page ${pageId} updated`);
  return Response.json(pageObject(pageId));
}

/** The markdown after a `replace_content` or an `update_content` request. */
function revisedMarkdown(
  markdown: string,
  body: Record<string, unknown>,
): { markdown: string } | { error: string } {
  if (body.type === "replace_content") {
    const replace = body.replace_content as { new_str?: string } | undefined;
    if (replace?.new_str === undefined) return { error: "replace_content needs new_str" };
    return { markdown: replace.new_str };
  }
  if (body.type !== "update_content") {
    return { error: "only replace_content and update_content are served" };
  }
  const update = body.update_content as
    | { content_updates?: { old_str: string; new_str: string }[] }
    | undefined;
  let current = markdown;
  for (const edit of update?.content_updates ?? []) {
    const first = current.indexOf(edit.old_str);
    if (!edit.old_str || first === -1 || current.indexOf(edit.old_str, first + 1) !== -1) {
      return { error: `old_str does not match the page once: ${edit.old_str.slice(0, 80)}` };
    }
    current = current.replace(edit.old_str, () => edit.new_str);
  }
  return { markdown: current };
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/__state") return Response.json(state);
  if (pathname === "/__reset" && request.method === "POST") {
    state.comments.length = 0;
    state.pages.length = 0;
    state.page_writes = {};
    return Response.json({ ok: true });
  }
  if (pathname === "/v1/users/me")
    return Response.json({ object: "user", id: BOT_USER_ID, type: "bot", name: "artfct", bot: {} });
  if (pathname === "/v1/comments" && request.method === "POST") {
    return createComment((await request.json()) as Record<string, unknown>);
  }
  if (pathname === "/v1/comments") return listComments(url.searchParams.get("block_id"));
  const children = /^\/v1\/blocks\/([^/]+)\/children$/.exec(pathname);
  if (children) return listBlocks(children[1]!);
  if (pathname === "/v1/pages" && request.method === "POST") {
    return createPage((await request.json()) as Record<string, unknown>);
  }
  const markdown = /^\/v1\/pages\/([^/]+)\/markdown$/.exec(pathname);
  if (markdown && request.method === "PATCH") {
    return updateMarkdown(markdown[1]!, (await request.json()) as Record<string, unknown>);
  }
  if (markdown) return readMarkdown(markdown[1]!);
  const page = /^\/v1\/pages\/([^/]+)$/.exec(pathname);
  if (page && request.method === "PATCH") return updatePage(page[1]!);
  if (page) return Response.json(pageObject(page[1]!));
  return notFound(`no route ${pathname}`);
}

Bun.serve({ port, fetch: handle });
log(`listening on ${port}`);
