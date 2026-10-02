import { describe, expect, it } from "bun:test";
import { toSlackMrkdwn } from "./mrkdwn";

describe("toSlackMrkdwn", () => {
  describe("a Markdown link", () => {
    it("becomes a mrkdwn link", () => {
      expect(toSlackMrkdwn("[ENG-41](https://linear.app/x/issue/ENG-41) is in.")).toBe(
        "<https://linear.app/x/issue/ENG-41|ENG-41> is in.",
      );
    });

    it("converts a mailto target", () => {
      expect(toSlackMrkdwn("[Ann](mailto:ann@x.y)")).toBe("<mailto:ann@x.y|Ann>");
    });

    it("keeps the URL alone when the link has no label", () => {
      expect(toSlackMrkdwn("[](https://a.test)")).toBe("<https://a.test>");
    });

    it("strips the characters that would close the link early", () => {
      expect(toSlackMrkdwn("[a|b <c>](https://a.test)")).toBe("<https://a.test|ab c>");
    });

    it("encodes a pipe in the URL so Slack keeps the whole target", () => {
      expect(toSlackMrkdwn("[panel](https://grafana.test/d/1?var=a|b)")).toBe(
        "<https://grafana.test/d/1?var=a%7Cb|panel>",
      );
    });

    it("drops the image marker and keeps the alt text as the label", () => {
      expect(toSlackMrkdwn("![chart](https://a.test/chart.png)")).toBe(
        "<https://a.test/chart.png|chart>",
      );
    });

    it("comes out unchanged when it is converted twice", () => {
      const once = toSlackMrkdwn("[PR #47](https://a.test/pull/47)");
      expect(toSlackMrkdwn(once)).toBe(once);
    });
  });

  describe("several links in one message", () => {
    it("converts every link on its own line", () => {
      expect(toSlackMrkdwn("- [one](https://a.test)\n- [two](https://b.test)")).toBe(
        "- <https://a.test|one>\n- <https://b.test|two>",
      );
    });

    it("converts the merged pull request message that landed badly", () => {
      const text =
        "[ENG-35](https://linear.app/acme/issue/ENG-35/writing) is in. " +
        "[PR #47](<https://github.com/acme/app/pull/47>) merged the rules.";
      expect(toSlackMrkdwn(text)).toBe(
        "<https://linear.app/acme/issue/ENG-35/writing|ENG-35> is in. " +
          "<https://github.com/acme/app/pull/47|PR #47> merged the rules.",
      );
    });
  });

  describe("bold, strikethrough, and headings", () => {
    it("bolds with one star", () => {
      expect(toSlackMrkdwn('Created **ENG-112**, "Breakdown creates milestones".')).toBe(
        'Created *ENG-112*, "Breakdown creates milestones".',
      );
    });

    it("converts a link inside a bold span", () => {
      expect(toSlackMrkdwn("**[ENG-112](https://linear.app/x/issue/ENG-112)** is in.")).toBe(
        "*<https://linear.app/x/issue/ENG-112|ENG-112>* is in.",
      );
    });

    it("strikes with one tilde", () => {
      expect(toSlackMrkdwn("~~ENG-9~~ is done.")).toBe("~ENG-9~ is done.");
    });

    it("turns a heading into a bold line", () => {
      expect(toSlackMrkdwn("## Next steps\n- ship it")).toBe("*Next steps*\n- ship it");
    });

    it("drops the bold markers inside a heading and its closing hashes", () => {
      expect(toSlackMrkdwn("### **Plan** ##")).toBe("*Plan*");
    });

    it("keeps a hash that is part of the heading text", () => {
      expect(toSlackMrkdwn("# Port to C#")).toBe("*Port to C#*");
    });

    it("keeps a hash that does not open a heading", () => {
      expect(toSlackMrkdwn("PR #47 and #channel")).toBe("PR #47 and #channel");
    });

    it("keeps bold and headings inside code", () => {
      const text = "`**a**`\n```\n# comment\n**b**\n```";
      expect(toSlackMrkdwn(text)).toBe(text);
    });

    it("keeps stars that wrap only spaces", () => {
      expect(toSlackMrkdwn("a ** b ** c")).toBe("a ** b ** c");
    });

    it("comes out unchanged when it is converted twice", () => {
      const once = toSlackMrkdwn("# Title\n**ENG-1** and ~~ENG-2~~");
      expect(toSlackMrkdwn(once)).toBe(once);
    });
  });

  describe("parentheses around a link", () => {
    it("converts a URL that holds a balanced pair", () => {
      expect(toSlackMrkdwn("[docs](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
        "<https://en.wikipedia.org/wiki/Foo_(bar)|docs>",
      );
    });

    it("leaves a link whose URL has an unclosed parenthesis", () => {
      const text = "[docs](https://a.test/foo_(bar)";
      expect(toSlackMrkdwn(text)).toBe(text);
    });

    it("keeps a parenthesis that follows the link out of the URL", () => {
      expect(toSlackMrkdwn("see [docs](https://a.test) (later)")).toBe(
        "see <https://a.test|docs> (later)",
      );
    });
  });

  describe("code spans and fenced blocks", () => {
    it("converts a link whose label is a code span", () => {
      expect(toSlackMrkdwn("See [`slack.ts`](https://github.test/blob/main/slack.ts) now.")).toBe(
        "See <https://github.test/blob/main/slack.ts|slack.ts> now.",
      );
    });

    it("converts a link that follows a code span", () => {
      expect(toSlackMrkdwn("run `bun run check`, then [PR #56](https://a.test/pull/56)")).toBe(
        "run `bun run check`, then <https://a.test/pull/56|PR #56>",
      );
    });

    it("leaves a link inside inline code", () => {
      expect(toSlackMrkdwn("write `[a](https://a.test)` for a link")).toBe(
        "write `[a](https://a.test)` for a link",
      );
    });

    it("leaves a link inside a fenced block", () => {
      const fenced = "```\n[a](https://a.test)\n```";
      expect(toSlackMrkdwn(fenced)).toBe(fenced);
    });

    it("leaves a code span label link that sits inside a fenced block", () => {
      const fenced = "```\nSee [`slack.ts`](https://a.test/slack.ts) now.\n```";
      expect(toSlackMrkdwn(fenced)).toBe(fenced);
    });

    it("converts the prose around a fenced block", () => {
      expect(
        toSlackMrkdwn("[a](https://a.test)\n```\n[b](https://b.test)\n```\n[c](https://c.test)"),
      ).toBe("<https://a.test|a>\n```\n[b](https://b.test)\n```\n<https://c.test|c>");
    });
  });

  describe("text that holds no link Slack can open", () => {
    it("keeps text that already reads as mrkdwn", () => {
      const text = "*Done.* <https://a.test|the PR> is merged. See https://b.test too.";
      expect(toSlackMrkdwn(text)).toBe(text);
    });

    it("keeps a relative target", () => {
      expect(toSlackMrkdwn("[readme](./README.md)")).toBe("[readme](./README.md)");
    });

    it("keeps a reference style link", () => {
      expect(toSlackMrkdwn("[note][ref]")).toBe("[note][ref]");
    });

    it("keeps plain prose", () => {
      expect(toSlackMrkdwn("Got it, launching an agent now.")).toBe(
        "Got it, launching an agent now.",
      );
    });

    it("keeps empty text empty", () => {
      expect(toSlackMrkdwn("")).toBe("");
    });
  });

  describe("a Slack tag in the text", () => {
    it("escapes a broadcast", () => {
      expect(toSlackMrkdwn("Done. <!channel> please review.")).toBe(
        "Done. &lt;!channel> please review.",
      );
    });

    it("escapes a user tag and a user group tag", () => {
      expect(toSlackMrkdwn("<@U123ABC> and <!subteam^S1|@eng>")).toBe(
        "&lt;@U123ABC> and &lt;!subteam^S1|@eng>",
      );
    });

    it("escapes a tag inside bold text and inside code", () => {
      expect(toSlackMrkdwn("**<!here>** and `<!everyone>`")).toBe(
        "*&lt;!here>* and `&lt;!everyone>`",
      );
    });

    it("still writes a Markdown link as a Slack link", () => {
      expect(toSlackMrkdwn("[the PR](https://github.com/acme/api/pull/1) <!here>")).toBe(
        "<https://github.com/acme/api/pull/1|the PR> &lt;!here>",
      );
    });
  });
});
