import { beforeEach, describe, expect, it } from "bun:test";
import { LineSplitter, readLines } from "./line-reader";

describe("LineSplitter", () => {
  let splitter: LineSplitter;

  beforeEach(() => {
    splitter = new LineSplitter();
  });

  describe("a chunk that ends inside a line", () => {
    let lines: string[];

    beforeEach(() => {
      lines = splitter.push('{"a":1}\n{"b":');
    });

    it("yields only the complete line", () => {
      expect(lines).toEqual(['{"a":1}']);
    });

    describe("with the rest of the line in the next chunk", () => {
      it("yields the line the two chunks share", () => {
        expect(splitter.push("2}\n")).toEqual(['{"b":2}']);
      });
    });
  });

  describe("a chunk of blank lines and whitespace", () => {
    it("drops the blank lines and trims the rest", () => {
      expect(splitter.push("\n  x  \r\n\n")).toEqual(["x"]);
    });
  });

  describe("a chunk with no line end", () => {
    let lines: string[];

    beforeEach(() => {
      lines = splitter.push("tail");
    });

    it("yields no line", () => {
      expect(lines).toEqual([]);
    });

    describe("after a flush", () => {
      let tail: string | null;

      beforeEach(() => {
        tail = splitter.flush();
      });

      it("gives the unterminated tail", () => {
        expect(tail).toBe("tail");
      });

      it("has nothing left for a second flush", () => {
        expect(splitter.flush()).toBeNull();
      });
    });
  });
});

describe("readLines", () => {
  describe("a stream whose chunks cut across lines", () => {
    it("reassembles every line", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("one\ntw"));
          controller.enqueue(encoder.encode("o\nthree"));
          controller.close();
        },
      });
      const lines: string[] = [];
      await readLines(stream, (line) => lines.push(line));
      expect(lines).toEqual(["one", "two", "three"]);
    });
  });
});
