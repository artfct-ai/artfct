import { describe, expect, it } from "bun:test";
import { freshStore } from "../../../test/fresh-store";
import { scenario } from "../../../test/scenario";

const CHANNEL = { source: "chat", channel: "C1", thread: "1.0" } as const;
const CHAT_KEY = "chat:C1:1.0";
const REOPENED = "wf_x-1";
const OTHER = "wf_x-2";

describe("relocateBoards", () => {
  const relocated = scenario(freshStore, (store) => {
    store.insertBoard(REOPENED, CHAT_KEY, CHANNEL);
    store.insertBoard(OTHER, CHAT_KEY, CHANNEL);
    store.relocateBoards(REOPENED);
  });

  it("moves the board of the given job", () =>
    relocated((store) => {
      expect(store.board(REOPENED, CHAT_KEY)?.relocate).toBe(1);
    }));

  it("leaves the board of another job where it is", () =>
    relocated((store) => {
      expect(store.board(OTHER, CHAT_KEY)?.relocate).toBe(0);
    }));
});
