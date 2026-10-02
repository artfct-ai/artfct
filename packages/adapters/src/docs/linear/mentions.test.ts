import { describe, expect, it } from "bun:test";
import { linearMentionedUserIds } from "./mentions";

function bodyData(...paragraphs: unknown[][]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((content) => ({ type: "paragraph", content })),
  });
}

const mention = (id: string, label: string) => ({
  type: "suggestion_userMentions",
  attrs: { id, label },
});
const text = (value: string) => ({ type: "text", text: value });

describe("linearMentionedUserIds", () => {
  it("reads the id of each user mention in every paragraph", () => {
    const data = bodyData(
      [mention("app1", "artfct"), text(" please revise")],
      [text("cc "), mention("u2", "ann")],
    );
    expect(linearMentionedUserIds(data)).toEqual(["app1", "u2"]);
  });

  it("finds a mention nested inside a list", () => {
    const data = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [mention("app1", "a")] }] },
          ],
        },
      ],
    });
    expect(linearMentionedUserIds(data)).toEqual(["app1"]);
  });

  it("finds none in text that only looks like a mention", () => {
    expect(linearMentionedUserIds(bodyData([text("@artfct please revise")]))).toEqual([]);
  });

  it("skips an issue mention", () => {
    const issueMention = { type: "issueMention", attrs: { id: "i1", label: "ENG-1" } };
    expect(linearMentionedUserIds(bodyData([issueMention]))).toEqual([]);
  });
});
