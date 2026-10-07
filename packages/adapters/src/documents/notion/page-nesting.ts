import {
  APIErrorCode,
  isFullDataSource,
  isFullDatabase,
  isFullPage,
  isNotionClientError,
  type Client,
  type CreatePageParameters,
  type DatabaseObjectResponse,
} from "@notionhq/client";
import { notionDocumentPage } from "./document-page";
import { notionPageId } from "./page-id";
import type { DocumentPage, PageNesting } from "../types";

/** Where a new page goes, and the property that holds its title there. */
type NotionNewPageParent = { parent: CreatePageParameters["parent"]; titleProperty: string };

/** `PageNesting` over the Notion API. A database parent takes the page as a row of its one table. */
export class NotionPageNesting implements PageNesting {
  constructor(private readonly client: Client) {}

  async createRootPage(title: string, text: string, pageParent: string): Promise<DocumentPage> {
    const parentId = notionPageId(pageParent);
    if (!parentId) throw new Error(`notion: "${pageParent}" does not name a page or a database`);
    const { parent, titleProperty } = await this.newPageParent(parentId);
    const page = await this.client.pages.create({
      parent,
      properties: { [titleProperty]: { title: [{ text: { content: title } }] } },
      markdown: text,
    });
    if (!isFullPage(page)) throw new Error(`notion: page "${title}" is unreadable after create`);
    return notionDocumentPage(page);
  }

  async movePage(pageId: string, parentPageId: string): Promise<void> {
    await this.client.pages.move({ page_id: pageId, parent: { page_id: parentPageId } });
  }

  async appendToPage(pageId: string, text: string): Promise<void> {
    await this.client.pages.updateMarkdown({
      page_id: pageId,
      type: "insert_content",
      insert_content: { content: text, position: { type: "end" } },
    });
  }

  /** A page parent is the page itself. A database parent is its one table, under its title column. */
  private async newPageParent(parentId: string): Promise<NotionNewPageParent> {
    const database = await this.databaseOrNull(parentId);
    if (!database) return { parent: { page_id: parentId }, titleProperty: "title" };
    const [table, ...others] = database.data_sources;
    if (!table || others.length > 0) {
      throw new Error(
        `notion: database ${parentId} holds ${database.data_sources.length} tables. Use a database with one table as the page parent.`,
      );
    }
    const source = await this.client.dataSources.retrieve({ data_source_id: table.id });
    if (!isFullDataSource(source)) throw new Error(`notion: table ${table.id} is unreadable`);
    const titleProperty = Object.values(source.properties).find(
      (property) => property.type === "title",
    );
    if (!titleProperty) throw new Error(`notion: table ${table.id} has no title column`);
    return { parent: { data_source_id: table.id }, titleProperty: titleProperty.name };
  }

  /** The database with this id. Null when the id names a page, which Notion answers as not found. */
  private async databaseOrNull(id: string): Promise<DatabaseObjectResponse | null> {
    try {
      const database = await this.client.databases.retrieve({ database_id: id });
      return isFullDatabase(database) ? database : null;
    } catch (error) {
      if (isNotFoundOrNotADatabase(error)) return null;
      throw error;
    }
  }
}

function isNotFoundOrNotADatabase(error: unknown): boolean {
  if (!isNotionClientError(error)) return false;
  return error.code === APIErrorCode.ObjectNotFound || error.code === APIErrorCode.ValidationError;
}
