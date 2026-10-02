import { describe, expect, it } from "bun:test";
import { addressesSomeoneElse, mentionedUserIds, readableMentions, tagsThisApp } from "./mentions";

describe("mentionedUserIds", () => {
  describe("text that names the same id twice", () => {
    it("reads every id once, in order", () => {
      expect(mentionedUserIds("<@ULINEAR> and <@U2> and <@ULINEAR> again")).toEqual([
        "ULINEAR",
        "U2",
      ]);
    });
  });

  describe("the labelled mention form", () => {
    it("reads the id and drops the label", () => {
      expect(mentionedUserIds("<@U2|sam> take a look")).toEqual(["U2"]);
    });
  });

  describe("text without mentions", () => {
    it("finds nothing in plain text", () => {
      expect(mentionedUserIds("ship it")).toEqual([]);
    });

    it("does not read an email address as a mention", () => {
      expect(mentionedUserIds("mail dev@acme.test")).toEqual([]);
    });
  });
});

describe("tagsThisApp", () => {
  describe("text that carries this app's id", () => {
    it("is true for the bare form", () => {
      expect(tagsThisApp("<@UBOT> ship it", "UBOT")).toBe(true);
    });

    it("is true for the labelled form", () => {
      expect(tagsThisApp("<@UBOT|artfct> ship it", "UBOT")).toBe(true);
    });

    it("is true when the tag sits inside the sentence", () => {
      expect(tagsThisApp("B, and <@UBOT> should say so", "UBOT")).toBe(true);
    });
  });

  describe("text that does not carry this app's id", () => {
    it("is false for another id", () => {
      expect(tagsThisApp("<@U2> ship it", "UBOT")).toBe(false);
    });

    it("is false when the callback named no bot user", () => {
      expect(tagsThisApp("<@UBOT> ship it", undefined)).toBe(false);
    });
  });
});

describe("readableMentions", () => {
  describe("this app's own tag", () => {
    it("drops a bare tag at the start", () => {
      expect(readableMentions("<@UBOT> ship it", "UBOT")).toBe("ship it");
    });

    it("drops a labelled tag at the start", () => {
      expect(readableMentions("<@UBOT|artfct> ship it", "UBOT")).toBe("ship it");
    });

    it("closes the gap a tag inside the text leaves", () => {
      expect(readableMentions("please <@UBOT> ship it", "UBOT")).toBe("please ship it");
    });
  });

  describe("somebody else's tag", () => {
    it("keeps a bare id as a name the agent can read", () => {
      expect(readableMentions("<@ULINEAR> link this thread", "UBOT")).toBe(
        "@ULINEAR link this thread",
      );
    });

    it("keeps a labelled id as its label", () => {
      expect(readableMentions("B, and <@U2|sam> should check it", "UBOT")).toBe(
        "B, and @sam should check it",
      );
    });
  });

  describe("a user group or a broadcast", () => {
    it("names a labelled user group", () => {
      expect(readableMentions("<!subteam^S1|@eng> any idea?", "UBOT")).toBe("@eng any idea?");
    });

    it("names a user group the payload left unlabelled", () => {
      expect(readableMentions("<!subteam^S1> any idea?", "UBOT")).toBe("@group any idea?");
    });

    it("names the here broadcast", () => {
      expect(readableMentions("<!here> the build is red", "UBOT")).toBe("@here the build is red");
    });

    it("names the channel broadcast", () => {
      expect(readableMentions("<!channel> the build is red", "UBOT")).toBe(
        "@channel the build is red",
      );
    });
  });

  describe("a callback that named no bot user", () => {
    it("keeps every tag, this app's own among them", () => {
      expect(readableMentions("<@UBOT> ship it", undefined)).toBe("@UBOT ship it");
    });
  });

  describe("text without tags", () => {
    it("leaves the text alone, newlines included", () => {
      expect(readableMentions("ship it\n\nthen tell me", "UBOT")).toBe("ship it\n\nthen tell me");
    });
  });
});

describe("addressesSomeoneElse", () => {
  describe("a message that opens with a tag for somebody else", () => {
    it("is true for another agent", () => {
      expect(addressesSomeoneElse("<@ULINEAR> can you link this thread to ENG-41?", "UBOT")).toBe(
        true,
      );
    });

    it("is true for a person", () => {
      expect(addressesSomeoneElse("<@U2|sam> can you take a look?", "UBOT")).toBe(true);
    });

    it("is true for a user group", () => {
      expect(addressesSomeoneElse("<!subteam^S1|@eng> any idea what broke?", "UBOT")).toBe(true);
    });

    it("ignores leading whitespace before the tag", () => {
      expect(addressesSomeoneElse("  <@ULINEAR> link this thread", "UBOT")).toBe(true);
    });
  });

  describe("a colleague named inside an answer", () => {
    it("is false for a person named after the first word", () => {
      expect(addressesSomeoneElse("B, and <@U2> should sanity check the migration", "UBOT")).toBe(
        false,
      );
    });

    it("is false for a user group named after the first word", () => {
      expect(
        addressesSomeoneElse("looks good, ask <!subteam^S1|@eng> after the merge", "UBOT"),
      ).toBe(false);
    });
  });

  describe("a message that tags nobody", () => {
    it("is false", () => {
      expect(addressesSomeoneElse("also update the docs", "UBOT")).toBe(false);
    });
  });

  describe("a message that opens with this app", () => {
    it("is false for the bare form", () => {
      expect(addressesSomeoneElse("<@UBOT> ship it", "UBOT")).toBe(false);
    });

    it("is false for the labelled form", () => {
      expect(addressesSomeoneElse("<@UBOT|artfct> ship it", "UBOT")).toBe(false);
    });
  });

  describe("a broadcast, which addresses this app too", () => {
    it("is false for here", () => {
      expect(addressesSomeoneElse("<!here> the build is red", "UBOT")).toBe(false);
    });

    it("is false for channel", () => {
      expect(addressesSomeoneElse("<!channel> the build is red", "UBOT")).toBe(false);
    });
  });

  describe("a user group when the callback named no bot user", () => {
    it("is true", () => {
      expect(addressesSomeoneElse("<!subteam^S1|@eng> any idea?", undefined)).toBe(true);
    });
  });

  describe("the same text read twice", () => {
    it("keeps no state between calls", () => {
      const text = "<@U2> please look";
      expect(addressesSomeoneElse(text, "UBOT")).toBe(true);
      expect(addressesSomeoneElse(text, "UBOT")).toBe(true);
    });
  });
});
