import { describe, expect, it } from "bun:test";
import { htmlText } from "./html-text";

describe("htmlText", () => {
  it("keeps the text of each block on its own line", () => {
    expect(htmlText("<h1>Node.js</h1><p>Download <b>v24.9.0</b> LTS</p>")).toBe(
      "Node.js\nDownload v24.9.0 LTS",
    );
  });

  it("drops the head, scripts, styles, and comments", () => {
    const html =
      "<head><title>T</title></head><style>p{}</style><script>alert(1)</script><!-- x --><p>Body</p>";
    expect(htmlText(html)).toBe("Body");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlText("<p>a &amp; b &lt;c&gt; &#39;d&#x27; &nbsp;e</p>")).toBe("a & b <c> 'd' e");
  });

  it("leaves an entity outside the code point range as it is", () => {
    expect(htmlText("<p>&#99999999;</p>")).toBe("&#99999999;");
  });
});
