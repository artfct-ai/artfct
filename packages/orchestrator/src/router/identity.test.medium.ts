import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { Actor } from "@artfct-ai/contracts/inbound";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Identity, resolveActor, resolveCodeActor, resolveVendorEventCauser } from "./identity";

function team(members: string[]) {
  return { id: "team-1", members };
}

const bounded = { tracker_team: "team-1" };
const chatBounded = { chat_team: "T1" };
const open = {};

function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("resolveCodeActor", () => {
  let actor: Actor | null;

  describe("a login that may push", () => {
    const octocat = { login: "octocat", repo: "acme/app", app: false };
    let code: FakeCodeHost;

    beforeEach(async () => {
      code = new FakeCodeHost({ pushers: ["octocat"] });
      actor = await resolveCodeActor(code, octocat);
    });

    it("returns the login as the actor", () => {
      expect(actor?.display_name).toBe("octocat");
    });

    it("asks the code host about that login on that repository", () => {
      expect(code.argsOf("canPush")).toEqual([["acme/app", "octocat"]]);
    });
  });

  describe("a login that may not push", () => {
    it("is unauthorized", async () => {
      const mallory = { login: "mallory", repo: "acme/app", app: false };
      expect(await resolveCodeActor(new FakeCodeHost({ pushers: [] }), mallory)).toBeNull();
    });
  });

  describe("a login that lost its push access", () => {
    it("is unauthorized on the next event", async () => {
      const sam = { login: "sam", repo: "acme/app", app: false };
      await resolveCodeActor(new FakeCodeHost({ pushers: ["sam"] }), sam);
      expect(await resolveCodeActor(new FakeCodeHost({ pushers: [] }), sam)).toBeNull();
    });
  });

  describe("an App", () => {
    let code: FakeCodeHost;

    beforeEach(async () => {
      code = new FakeCodeHost({ pushers: [] });
      actor = await resolveCodeActor(code, {
        login: "coderabbitai[bot]",
        repo: "acme/app",
        app: true,
      });
    });

    it("is authorized, since the repository installed it", () => {
      expect(actor?.display_name).toBe("coderabbitai[bot]");
    });

    it("is not looked up", () => {
      expect(code.calls).toEqual([]);
    });
  });

  describe("a code host that cannot answer", () => {
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(async () => {
      warn = spyOnWarn();
      actor = await resolveCodeActor(new FakeCodeHost({ failing: true }), {
        login: "sam",
        repo: "acme/app",
        app: false,
      });
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("leaves the person unauthorized", () => {
      expect(actor).toBeNull();
    });
  });

  describe("a deployment with no code host connected", () => {
    it("lets no person in", async () => {
      expect(
        await resolveCodeActor(null, { login: "sam", repo: "acme/app", app: false }),
      ).toBeNull();
    });
  });
});

describe("resolveActor for a code host user", () => {
  it("dispatches to the code host identity", async () => {
    const actor = await resolveActor(
      env,
      { source: "code", user: { login: "sam", repo: "acme/app", app: false } },
      { code: new FakeCodeHost() },
    );
    expect(actor?.display_name).toBe("sam");
  });
});
describe("Identity.fromTracker", () => {
  const user = { id: "L1", email: "Lee@acme.test", name: "Lee" };
  let actor: Actor | null;

  describe("a member of the tracker team", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker({ team: team(["L1"]) });
      actor = await new Identity(bounded, tracker).fromTracker(user);
    });

    it("returns the actor", () => {
      expect(actor?.display_name).toBe("Lee");
    });

    it("asks Linear whether they are in the team", () => {
      expect(tracker.calls).toEqual([{ method: "teamMembership", args: ["team-1", "L1"] }]);
    });

    it("asks again on their next event, so leaving the team takes effect at once", async () => {
      await new Identity(bounded, tracker).fromTracker(user);
      expect(tracker.argsOf("teamMembership")).toHaveLength(2);
    });
  });

  describe("a member who has left the tracker team", () => {
    it("is rejected on their next event", async () => {
      await new Identity(bounded, new FakeTracker({ team: team(["L1"]) })).fromTracker(user);
      expect(await new Identity(bounded, new FakeTracker()).fromTracker(user)).toBeNull();
    });
  });

  describe("a user outside the tracker team", () => {
    beforeEach(async () => {
      actor = await new Identity(bounded, new FakeTracker()).fromTracker(user);
    });

    it("rejects them", () => {
      expect(actor).toBeNull();
    });
  });

  describe("a tracker team and no client to ask", () => {
    it("rejects them", async () => {
      expect(await new Identity(bounded, null).fromTracker(user)).toBeNull();
    });
  });

  describe("a user the event names, without a tracker team", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker();
      actor = await new Identity(chatBounded, tracker).fromTracker(user);
    });

    it("returns the actor with the email and name the event carries", () => {
      expect(actor).toEqual({ email: "Lee@acme.test", display_name: "Lee" });
    });

    it("asks Linear nothing", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("a user with no email, without a client and without a boundary", () => {
    beforeEach(async () => {
      actor = await new Identity(open, null).fromTracker({ id: "L3" });
    });

    it("still answers an actor", () => {
      expect(actor).not.toBeNull();
    });

    it("leaves the email empty", () => {
      expect(actor?.email).toBeNull();
    });
  });

  describe("the installed app's own user", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker({ appUserId: "app1" });
      actor = await new Identity(bounded, tracker).fromTracker({ id: "app1", name: "Agent" });
    });

    it("resolves to nobody, since the app is not a person", () => {
      expect(actor).toBeNull();
    });
  });
});

describe("Identity.fromChat", () => {
  const user = { id: "U1", email: "sam@acme.test", name: "Sam", member_of_team: "T1" };
  let tracker: FakeTracker;
  let actor: Actor | null;

  describe("a full member of the chat team", () => {
    beforeEach(async () => {
      tracker = new FakeTracker();
      actor = await new Identity(chatBounded, tracker).fromChat(user);
    });

    it("accepts them", () => {
      expect(actor?.display_name).toBe("Sam");
    });

    it("asks Linear nothing", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("a full member of another chat team", () => {
    it("rejects them", async () => {
      const visitor = { ...user, member_of_team: "T2" };
      expect(await new Identity(chatBounded, null).fromChat(visitor)).toBeNull();
    });
  });

  describe("a guest of the chat team", () => {
    it("rejects them", async () => {
      const guest = { ...user, member_of_team: null };
      expect(await new Identity(chatBounded, null).fromChat(guest)).toBeNull();
    });
  });

  describe("a chat team and a tracker team together", () => {
    beforeEach(async () => {
      tracker = new FakeTracker();
      const both = { ...bounded, ...chatBounded };
      actor = await new Identity(both, tracker).fromChat(user);
    });

    it("accepts a full member of the chat team", () => {
      expect(actor).not.toBeNull();
    });

    it("asks Linear nothing", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("without a team boundary", () => {
    beforeEach(async () => {
      actor = await new Identity(open, null).fromChat(user);
    });

    it("accepts everyone", () => {
      expect(actor?.display_name).toBe("Sam");
    });
  });

  describe("a user whose email changed since an earlier event", () => {
    beforeEach(async () => {
      tracker = new FakeTracker({
        team: team(["L1"]),
        usersByEmail: { "sam.lee@acme.test": { id: "L1", name: "Sam L" } },
      });
      await new Identity(bounded, tracker).fromChat(user);
      actor = await new Identity(bounded, tracker).fromChat({
        ...user,
        email: "sam.lee@acme.test",
      });
    });

    it("joins them by the email the chat vendor reports now", () => {
      expect(actor).toEqual({ email: "sam.lee@acme.test", display_name: "Sam L" });
    });

    it("asks Linear about each event's own email", () => {
      expect(tracker.argsOf("userByEmail")).toEqual([["sam@acme.test"], ["sam.lee@acme.test"]]);
    });
  });

  describe("an unknown user without an email", () => {
    beforeEach(async () => {
      tracker = new FakeTracker();
      actor = await new Identity(bounded, tracker).fromChat({ id: "U2", member_of_team: null });
    });

    it("rejects them", () => {
      expect(actor).toBeNull();
    });

    it("asks Linear nothing, since there is no email to ask about", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("an email that belongs to a Linear user in the team", () => {
    beforeEach(async () => {
      tracker = new FakeTracker({
        team: team(["L1"]),
        usersByEmail: { "sam@acme.test": { id: "L1", name: "Sam L" } },
      });
      actor = await new Identity(bounded, tracker).fromChat(user);
    });

    it("returns the Linear user under their Linear name", () => {
      expect(actor).toMatchObject({ email: "sam@acme.test", display_name: "Sam L" });
    });

    it("looks the email up and then the team membership", () => {
      expect(tracker.calls).toEqual([
        { method: "userByEmail", args: ["sam@acme.test"] },
        { method: "teamMembership", args: ["team-1", "L1"] },
      ]);
    });
  });

  describe("an email that belongs to a Linear user outside the team", () => {
    it("rejects them", async () => {
      tracker = new FakeTracker({ usersByEmail: { "sam@acme.test": { id: "L1", name: "Sam" } } });
      expect(await new Identity(bounded, tracker).fromChat(user)).toBeNull();
    });
  });

  describe("when the Linear lookup fails", () => {
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(async () => {
      warn = spyOnWarn();
      actor = await new Identity(bounded, new FakeTracker({ failing: true })).fromChat(user);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("rejects them", () => {
      expect(actor).toBeNull();
    });

    it("warns that the user lookup failed", () => {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/user lookup failed/));
    });
  });

  describe("an email Linear does not know", () => {
    const unknown = { id: "U3", email: "nobody@acme.test", member_of_team: null };

    beforeEach(() => {
      tracker = new FakeTracker({
        usersByEmail: { "sam@acme.test": { id: "L1", name: "Sam" } },
      });
    });

    it("rejects them", async () => {
      expect(await new Identity(bounded, tracker).fromChat(unknown)).toBeNull();
    });

    it("rejects them without a client too", async () => {
      expect(await new Identity(bounded, null).fromChat(unknown)).toBeNull();
    });
  });
});

describe("Identity.fromDocuments", () => {
  let tracker: FakeTracker;

  describe("a person the page names without an email", () => {
    it("rejects them", async () => {
      expect(await new Identity(open, null).fromDocuments({ id: "N1" })).toBeNull();
    });
  });

  describe("a Linear user for the email, without a tracker team", () => {
    let actor: Actor | null;

    beforeEach(async () => {
      tracker = new FakeTracker({ usersByEmail: { "new@acme.test": { id: "L5", name: "New" } } });
      actor = await new Identity(open, tracker).fromDocuments({
        id: "N2",
        email: "new@acme.test",
      });
    });

    it("returns them", () => {
      expect(actor?.display_name).toBe("New");
    });

    it("asks Linear for the user alone", () => {
      expect(tracker.calls).toEqual([{ method: "userByEmail", args: ["new@acme.test"] }]);
    });
  });

  describe("a team boundary and a Linear user for a new email", () => {
    beforeEach(() => {
      tracker = new FakeTracker({
        team: team(["L5"]),
        usersByEmail: { "new@acme.test": { id: "L5", name: "New" } },
      });
    });

    describe("an email Linear does not know", () => {
      it("is rejected", async () => {
        const kim = { id: "N1", email: "kim@acme.test" };
        expect(await new Identity(bounded, tracker).fromDocuments(kim)).toBeNull();
      });
    });

    describe("an email of a Linear user in the team", () => {
      let actor: Actor | null;

      beforeEach(async () => {
        actor = await new Identity(bounded, tracker).fromDocuments({
          id: "N2",
          email: "new@acme.test",
          name: "N",
        });
      });

      it("returns the Linear name, not the one the page carries", () => {
        expect(actor?.display_name).toBe("New");
      });
    });
  });
});

describe("resolveActor with a given client", () => {
  let tracker: FakeTracker;

  beforeEach(() => {
    tracker = new FakeTracker({ team: team(["L7"]) });
  });

  describe("a Linear user", () => {
    let actor: Actor | null;

    beforeEach(async () => {
      actor = await resolveActor(
        env,
        { source: "tracker", user: { id: "L7", name: "Seven" } },
        { tracker },
      );
    });

    it("dispatches to the Linear identity", () => {
      expect(actor?.display_name).toBe("Seven");
    });

    it("asks Linear nothing, since the event names the user", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("a Notion user without an email and without a document host", () => {
    it("answers null", async () => {
      expect(
        await resolveActor(
          env,
          { source: "documents", user: { id: "N9" } },
          { tracker, documents: null },
        ),
      ).toBeNull();
    });
  });

  describe("a Notion user named by id alone, as a vendor event names its causer", () => {
    let documents: FakeDocuments;
    let actor: Actor | null;

    beforeEach(async () => {
      documents = new FakeDocuments({ emails: { N7: "Seven@Acme.test" } });
      tracker = new FakeTracker({
        team: team(["L7"]),
        usersByEmail: { "seven@acme.test": { id: "L7", name: "Seven" } },
      });
      actor = await resolveActor(
        env,
        { source: "documents", user: { id: "N7" } },
        { tracker, documents },
      );
    });

    it("joins the Linear user by the email the document host holds, lowercased", () => {
      expect(actor).toEqual({ email: "seven@acme.test", display_name: "Seven" });
    });

    it("asks the document host for the email", () => {
      expect(documents.calls).toEqual([{ method: "userEmail", args: ["N7"] }]);
    });
  });

  describe("a Notion user whose email lookup fails", () => {
    it("answers null", async () => {
      expect(
        await resolveActor(
          env,
          { source: "documents", user: { id: "N7" } },
          { tracker, documents: new FakeDocuments({ failing: true }) },
        ),
      ).toBeNull();
    });
  });
});

describe("resolveVendorEventCauser", () => {
  describe("a chat causer the chat can look up", () => {
    let chat: FakeChat;
    let actor: Actor | null;

    beforeEach(async () => {
      const dev = { id: "U1", email: "Dev@Acme.test", name: "Dev", member_of_team: "T1" };
      chat = new FakeChat({ users: { U1: dev } });
      actor = await resolveVendorEventCauser(env, { source: "chat", user_id: "U1" }, { chat });
    });

    it("asks the chat for the user", () => {
      expect(chat.calls).toEqual([{ method: "user", args: ["U1"] }]);
    });

    it("resolves the user with the email in lowercase", () => {
      expect(actor).toEqual({ email: "dev@acme.test", display_name: "Dev" });
    });
  });

  describe("a chat causer without a chat credential", () => {
    it("resolves the id alone", async () => {
      const actor = await resolveVendorEventCauser(
        env,
        { source: "chat", user_id: "U1" },
        { chat: null },
      );
      expect(actor).toEqual({ email: null, display_name: null });
    });
  });

  describe("a code host causer", () => {
    it("resolves it as any code host user", async () => {
      const actor = await resolveVendorEventCauser(
        env,
        { source: "code", user: { login: "sam", repo: "acme/app", app: false } },
        { code: new FakeCodeHost() },
      );
      expect(actor?.display_name).toBe("sam");
    });
  });
});
