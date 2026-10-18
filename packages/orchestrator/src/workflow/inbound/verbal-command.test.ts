import { describe, expect, it } from "bun:test";
import { parseVerbalCommand } from "./verbal-command";

describe("parseVerbalCommand", () => {
  describe("a bare verbal command", () => {
    it("reads cancel", () => {
      expect(parseVerbalCommand("cancel")).toEqual({ control: "cancel", rest: "" });
    });

    it("reads stop as cancel, past the space and the full stop", () => {
      expect(parseVerbalCommand("  Stop.  ")).toEqual({ control: "cancel", rest: "" });
    });

    it("reads retry and continue as resume", () => {
      expect(parseVerbalCommand("retry")).toEqual({ control: "resume", rest: "" });
      expect(parseVerbalCommand("Continue")).toEqual({ control: "resume", rest: "" });
    });
  });

  describe("a verbal command behind a mention", () => {
    it("reads the word after a plain mention", () => {
      expect(parseVerbalCommand("@ao stop")).toEqual({ control: "cancel", rest: "" });
    });

    it("reads the word after a Slack mention, past the punctuation", () => {
      expect(parseVerbalCommand("<@U0AB12CD> pause!")).toEqual({ control: "pause", rest: "" });
    });
  });

  describe("instruct", () => {
    it("keeps the text after the word", () => {
      expect(parseVerbalCommand("instruct use bun")).toEqual({
        control: "instruct",
        rest: "use bun",
      });
    });

    it("keeps the text after a mention and a colon", () => {
      expect(parseVerbalCommand("@ao instruct: use bun")).toEqual({
        control: "instruct",
        rest: "use bun",
      });
    });
  });

  describe("a control verb with more words after it", () => {
    it("is an ordinary message", () => {
      expect(parseVerbalCommand("Stop using mocks in the tests")).toBeNull();
      expect(parseVerbalCommand("Continue with the API change, then add tests")).toBeNull();
    });

    it("is an ordinary message behind a mention or punctuation", () => {
      expect(parseVerbalCommand("@ao stop now")).toBeNull();
      expect(parseVerbalCommand("Pause: waiting on design")).toBeNull();
    });
  });

  describe("text with no verbal command", () => {
    it("is an ordinary message", () => {
      expect(parseVerbalCommand("please also fix the tests")).toBeNull();
    });

    it("is an ordinary message when a word only starts with a verbal command", () => {
      expect(parseVerbalCommand("cancellation policy is unclear")).toBeNull();
    });

    it("answers null for empty text", () => {
      expect(parseVerbalCommand("")).toBeNull();
    });
  });
});
