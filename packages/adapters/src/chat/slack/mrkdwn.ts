/**
 * Slack renders mrkdwn, not Markdown, so every Markdown link, bold span, strikethrough, and
 * heading is rewritten on the way out. Only Slack text goes through here.
 */

/** A Markdown link or image. The URL may carry angle brackets and one balanced pair of parentheses. */
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\(\s*<?((?:[^\s<>()]|\([^\s<>()]*\))+)>?\s*\)/;

/** A bold span. Slack bolds with one star. */
const MARKDOWN_BOLD = /\*\*(?=\S)([^\n]*?\S)\*\*/;

/** A strikethrough span. Slack strikes with one tilde. */
const MARKDOWN_STRIKE = /~~(?=\S)([^\n]*?\S)~~/;

/** An ATX heading line. Slack has no headings, so it becomes a bold line. */
const MARKDOWN_HEADING = /^ {0,3}#{1,6}[ \t]+([^\n]*?\S)(?:[ \t]+#+)?[ \t]*$/m;

/** A fenced block or an inline span. Slack renders neither, so Markdown there stays as text. */
const CODE = /```[\S\s]*?```|`[^\n`]*`/;

/** Code and Markdown in one scan, so whichever starts first wins. */
const CODE_OR_MARKDOWN = new RegExp(
  [CODE, MARKDOWN_LINK, MARKDOWN_BOLD, MARKDOWN_STRIKE, MARKDOWN_HEADING]
    .map((pattern) => pattern.source)
    .join("|"),
  "gm",
);

/** The opening of a Slack tag: a user, a user group, or a broadcast such as `<!channel>`. */
const TAG_OPENING = /<(?=[!@])/g;

/** Schemes Slack accepts in a link. A relative or unknown target is left as it was written. */
const LINK_SCHEME = /^(https?:\/\/|mailto:)/i;

/** Characters that would end the link or its label early. */
const LABEL_BREAKS = /[<>|]/g;

/**
 * Rewrite Markdown as Slack mrkdwn. Text that holds no Markdown comes back unchanged. A Slack
 * tag in the text is escaped, so it shows as written and notifies nobody.
 */
export function toSlackMrkdwn(text: string): string {
  return text
    .replace(TAG_OPENING, "&lt;")
    .replace(
      CODE_OR_MARKDOWN,
      (
        match,
        rawLabel?: string,
        rawUrl?: string,
        bold?: string,
        struck?: string,
        heading?: string,
      ) => {
        if (rawUrl !== undefined && rawLabel !== undefined)
          return mrkdwnLink(match, rawLabel, rawUrl);
        if (bold !== undefined) return `*${toSlackMrkdwn(bold)}*`;
        if (struck !== undefined) return `~${toSlackMrkdwn(struck)}~`;
        if (heading !== undefined) return `*${toSlackMrkdwn(heading.replaceAll("**", ""))}*`;
        return match;
      },
    );
}

/** The link as mrkdwn, or the Markdown as written when Slack cannot open its target. */
function mrkdwnLink(match: string, rawLabel: string, rawUrl: string): string {
  if (!LINK_SCHEME.test(rawUrl)) return match;
  const url = linkUrl(rawUrl);
  const label = linkLabel(rawLabel);
  return label ? `<${url}|${label}>` : `<${url}>`;
}

/** The URL as a mrkdwn link can carry it: a pipe would cut the link short, so it is encoded. */
function linkUrl(rawUrl: string): string {
  return rawUrl.replaceAll("|", "%7C");
}

/** The label Slack can carry: one line, without backticks or the characters that close a link. */
function linkLabel(rawLabel: string): string {
  return rawLabel.replace(LABEL_BREAKS, "").replaceAll("`", "").replace(/\s+/g, " ").trim();
}
