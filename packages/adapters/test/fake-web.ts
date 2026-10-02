import type { Web, WebPage } from "../src/web/types";

/** An in-memory `Web` that answers from fixed pages by URL and records every URL it reads. */
export class FakeWeb implements Web {
  readonly readUrls: string[] = [];

  constructor(private readonly pages: Record<string, WebPage> = {}) {}

  async readPage(url: string): Promise<WebPage> {
    this.readUrls.push(url);
    const page = this.pages[url];
    if (!page) throw new Error(`${url} answered 404`);
    return page;
  }
}
