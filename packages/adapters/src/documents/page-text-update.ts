import { diffArrays } from "diff/lib/diff/array.js";
import type { PageTextChange } from "./types";

/** One search-and-replace on page text. `find` matches the page text exactly once. */
export type PageTextEdit = { find: string; replace: string };

/**
 * How a host writes a page text change. A page read without text gets the whole new text, since
 * an edit needs text to find. The host writes it ahead of any text a person wrote since the read.
 * Any other page gets edits in page order, empty when the text did not change.
 */
export type PageTextUpdate = { whole: string } | { edits: PageTextEdit[] };

/** A run of page lines: one line both texts hold, or the lines one change swaps. */
type LineSegment = { before: string[]; after: string[]; changed: boolean };

/** The segments one edit covers, from `first` up to and not including `end`. */
type SegmentSpan = { first: number; end: number };

/**
 * The edits that turn `before` into `after` and touch only the lines that differ. An edit takes
 * in the neighboring lines it needs to anchor an insertion or to match the page once. Edits that
 * lie closest together merge until at most `maxEdits` remain.
 */
export function planPageTextUpdate(change: PageTextChange, maxEdits: number): PageTextUpdate {
  if (!change.before.trim()) return { whole: change.after };
  const segments = lineSegments(change.before, change.after);
  let spans = changedSpans(segments);
  for (;;) {
    spans = withinEditLimit(mergeOverlapping(spans), maxEdits);
    const edits = spans.map((span) => spanEdit(segments, span));
    const ambiguous = firstAmbiguousEdit(change.before, edits);
    if (ambiguous === null) return { edits };
    spans[ambiguous] = widened(spans[ambiguous]!, segments.length);
  }
}

/**
 * The text after each edit in order, or the first edit that does not match the text exactly
 * once.
 */
export function applyPageTextEdits(
  text: string,
  edits: PageTextEdit[],
): { text: string } | { error: string } {
  let current = text;
  for (const edit of edits) {
    const matches = matchCount(current, edit.find);
    if (matches !== 1) {
      return { error: `an edit matches the page ${matches} times: ${edit.find.slice(0, 80)}` };
    }
    current = current.replace(edit.find, () => edit.replace);
  }
  return { text: current };
}

function lineSegments(before: string, after: string): LineSegment[] {
  const segments: LineSegment[] = [];
  let pending: LineSegment | null = null;
  for (const part of diffArrays(before.split("\n"), after.split("\n"))) {
    if (part.added || part.removed) {
      pending ??= { before: [], after: [], changed: true };
      (part.added ? pending.after : pending.before).push(...part.value);
      continue;
    }
    if (pending) segments.push(pending);
    pending = null;
    segments.push(...part.value.map((line) => ({ before: [line], after: [line], changed: false })));
  }
  if (pending) segments.push(pending);
  return segments;
}

function changedSpans(segments: LineSegment[]): SegmentSpan[] {
  return segments.flatMap((segment, index) =>
    segment.changed ? [{ first: index, end: index + 1 }] : [],
  );
}

function mergeOverlapping(spans: SegmentSpan[]): SegmentSpan[] {
  const merged: SegmentSpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.first < previous.end) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/** Merge the two neighboring spans with the fewest lines between them until few enough remain. */
function withinEditLimit(spans: SegmentSpan[], maxEdits: number): SegmentSpan[] {
  const merged = [...spans];
  while (merged.length > maxEdits) {
    let closest = 0;
    for (let index = 1; index < merged.length - 1; index += 1) {
      if (gapAfter(merged, index) < gapAfter(merged, closest)) closest = index;
    }
    const [left, right] = [merged[closest]!, merged[closest + 1]!];
    merged.splice(closest, 2, { first: left.first, end: right.end });
  }
  return merged;
}

function gapAfter(spans: SegmentSpan[], index: number): number {
  return spans[index + 1]!.first - spans[index]!.end;
}

function widened(span: SegmentSpan, segmentCount: number): SegmentSpan {
  if (span.first > 0) return { first: span.first - 1, end: span.end };
  return { first: span.first, end: Math.min(span.end + 1, segmentCount) };
}

/**
 * The edit for a span. A span that only deletes lines takes the line break after them, or the
 * one before them at the end of the page. A span that only inserts does not cover any text, so
 * its edit has an empty find and gets widened.
 */
function spanEdit(segments: LineSegment[], span: SegmentSpan): PageTextEdit {
  const covered = segments.slice(span.first, span.end);
  const before = covered.flatMap((segment) => segment.before);
  const after = covered.flatMap((segment) => segment.after);
  if (!before.length) return { find: "", replace: after.join("\n") };
  const find = before.join("\n");
  if (after.length) return { find, replace: after.join("\n") };
  const linesFollow = segments.slice(span.end).some((segment) => segment.before.length > 0);
  if (linesFollow) return { find: `${find}\n`, replace: "" };
  return { find: `\n${find}`, replace: "" };
}

/**
 * The index of the first edit that does not match exactly once, both in the page as it was and
 * after the edits before it. A host may apply the edits either way.
 */
function firstAmbiguousEdit(before: string, edits: PageTextEdit[]): number | null {
  let current = before;
  for (const [index, edit] of edits.entries()) {
    if (matchCount(before, edit.find) !== 1 || matchCount(current, edit.find) !== 1) return index;
    current = current.replace(edit.find, () => edit.replace);
  }
  return null;
}

/** How many times `find` occurs in `text`, overlaps included, counted up to two. */
function matchCount(text: string, find: string): number {
  if (!find) return 0;
  const first = text.indexOf(find);
  if (first === -1) return 0;
  return text.indexOf(find, first + 1) === -1 ? 1 : 2;
}
