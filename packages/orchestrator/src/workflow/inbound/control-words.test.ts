import { describe, expect, it } from "bun:test";
import { parseControl } from "./control-words";

describe("parseControl", () => {
  describe("a bare control word", () => {
    it("reads cancel", () => {
      expect(parseControl("cancel")).toEqual({ control: "cancel", rest: "" });
    });

    it("reads stop as cancel, past the space and the full stop", () => {
      expect(parseControl("  Stop.  ")).toEqual({ control: "cancel", rest: "" });
    });

    it("reads retry and continue as resume", () => {
      expect(parseControl("retry")).toEqual({ control: "resume", rest: "" });
      expect(parseControl("Continue")).toEqual({ control: "resume", rest: "" });
    });
  });

  describe("a control word behind a mention", () => {
    it("reads the word after a plain mention", () => {
      expect(parseControl("@ao stop")).toEqual({ control: "cancel", rest: "" });
    });

    it("reads the word after a Slack mention, past the punctuation", () => {
      expect(parseControl("<@U0AB12CD> pause!")).toEqual({ control: "pause", rest: "" });
    });
  });

  describe("instruct", () => {
    it("keeps the text after the word", () => {
      expect(parseControl("instruct use bun")).toEqual({ control: "instruct", rest: "use bun" });
    });

    it("keeps the text after a mention and a colon", () => {
      expect(parseControl("@ao instruct: use bun")).toEqual({
        control: "instruct",
        rest: "use bun",
      });
    });
  });

  describe("a control verb with more words after it", () => {
    it("is an ordinary message", () => {
      expect(parseControl("Stop using mocks in the tests")).toBeNull();
      expect(parseControl("Continue with the API change, then add tests")).toBeNull();
    });

    it("is an ordinary message behind a mention or punctuation", () => {
      expect(parseControl("@ao stop now")).toBeNull();
      expect(parseControl("Pause: waiting on design")).toBeNull();
    });
  });

  describe("text with no control word", () => {
    it("is an ordinary message", () => {
      expect(parseControl("please also fix the tests")).toBeNull();
    });

    it("is an ordinary message when a word only starts with a control word", () => {
      expect(parseControl("cancellation policy is unclear")).toBeNull();
    });

    it("answers null for empty text", () => {
      expect(parseControl("")).toBeNull();
    });
  });
});
