/** Newline-delimited text framing for harness stdout. */

/** Accumulates chunks and yields complete lines. Blank lines are dropped. */
export class LineSplitter {
  private buffer = "";

  /** Add a chunk. Returns every complete, trimmed, non-empty line it closed. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) lines.push(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** Return the unterminated tail, if any, and reset. */
  flush(): string | null {
    const tail = this.buffer.trim();
    this.buffer = "";
    return tail || null;
  }
}

/** Read a byte stream to its end and call `onLine` for each complete line. */
export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const splitter = new LineSplitter();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of splitter.push(decoder.decode(value, { stream: true }))) onLine(line);
  }
  const tail = splitter.flush();
  if (tail) onLine(tail);
}
